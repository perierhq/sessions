/**
 * The file import: Markdown, plain text, HTML exports (Notion, Google
 * Docs) and PDFs a person uploads become reference knowledge.
 *
 * Each file becomes `sources/files/<slug>.md` (`origin: file`, `trust:
 * reference`, `sources: ["file:<name>"]`, its text as the body, `validAsOf`
 * today) and its original bytes `attachments/file+<slug>/<name>`. The
 * `file+` folder keeps a file's attachment apart from an article's
 * (`attachments/<slug>/`) with the same slug, like suggestions'
 * `suggestion+<slug>`. HTML exports keep only their text: the layout never
 * stores HTML (layout.ts ATTACHMENT_EXTENSIONS). Uploading a file under a
 * name already imported replaces that item and its attachment; another
 * name with the same slug gets `-2`, `-3`.
 *
 * A request is refused (400) before any job starts when it has no file,
 * more than MAX_IMPORT_FILES, a zip, a file over 10 MB or a type this
 * doesn't read. In the job, a file whose text can't be read (a scanned
 * PDF, not UTF-8) or that looks like it holds a credential is skipped and
 * counted, never redacted into knowledge. Text over the article cap is cut
 * with a note (the job records it was cut). One commit per request,
 * authored by the person who uploaded.
 *
 * PDF text comes from `unpdf` (pdf.js, no worker, scripts off), loaded on
 * first use. Reuses web-fetch.ts htmlToText, the job records of jobs.ts,
 * layout's freeSlugPath and the validator. Nothing runs at import.
 */
import type { KnowledgeImportJob } from "../../../shared/knowledge";
import type { Author } from "../../memory-repo/git-store";
import { MemoryRepoError } from "../../memory-repo/git-store";
import { findSecrets } from "../../memory-repo/secrets";
import { htmlToText } from "../../web-fetch";
import { knowledgeRepo } from "../client";
import {
  ATTACHMENTS_DIR,
  folderFor,
  freeSlugPath,
  hasAttachmentExtension,
  knowledgeRepoName,
} from "../layout";
import type { KnowledgeChange } from "../service";
import {
  MAX_ARTICLE_BYTES,
  MAX_ATTACHMENT_BYTES,
  validateKnowledgeFile,
} from "../validate";
import { startJob } from "./jobs";

export interface ImportedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface FilesDeps {
  /** YYYY-MM-DD, UTC. */
  today(): string;
}

export const MAX_IMPORT_FILES = 20;
export const ZIP_COPY = "Unzip the export and upload the files";
export const FILE_TOO_BIG_COPY = "Files can be up to 10 MB";
export const TOO_MANY_FILES_COPY = `Import up to ${MAX_IMPORT_FILES} files at a time`;
export const NO_FILES_COPY = "Choose the files to import";
export const FILE_TYPES_COPY =
  "Import Markdown, text, HTML or PDF files (.md, .txt, .html, .pdf)";

/** Room left for the front matter and the cut note under the article cap. */
const BODY_BYTES = MAX_ARTICLE_BYTES - 4096;
/** Pages read from one PDF. */
const MAX_PDF_PAGES = 2000;
const MAX_TITLE = 200;
const WRITE_ATTEMPTS = 3;
const FILES_DIR = folderFor("file");

type Format = "markdown" | "text" | "html" | "pdf";

const FORMATS: Record<string, Format> = {
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  html: "html",
  htm: "html",
  pdf: "pdf",
};

const ZIP_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
]);

/** The file's own name, without any folder a browser sent. */
function baseName(name: string): string {
  return (
    name
      .split(/[\\/]/)
      .pop()!
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim() || "file"
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim() || "file";
}

/** Why a file can't be imported at all, before reading it; null when it
 *  may be. */
function refusal(file: ImportedFile): string | null {
  const name = baseName(file.name);
  if (extensionOf(name) === "zip" || ZIP_TYPES.has(file.type.toLowerCase()))
    return ZIP_COPY;
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) return FILE_TOO_BIG_COPY;
  if (!FORMATS[extensionOf(name)]) return FILE_TYPES_COPY;
  return null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim();
}

/** NFC, `\n` line ends, lines without trailing blanks, blank runs folded. */
function tidy(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function utf8(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

/** The first `# heading` of Markdown. */
function markdownTitle(text: string): string | null {
  return /^#[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]?.trim() || null;
}

const isPdf = (bytes: Uint8Array) =>
  new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");

/** The text of a PDF's pages, a blank line between pages. Stops reading
 *  once there is more text than an item holds. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  // pdf.js may take the buffer over; it gets a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    // Errors only: a missing standard font still yields its text.
    verbosity: 0,
  });
  try {
    const pages: string[] = [];
    let size = 0;
    const last = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let n = 1; n <= last && size <= BODY_BYTES; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      page.cleanup();
      pages.push(text);
      size += text.length;
    }
    return pages.join("\n\n");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/**
 * The title and text of an uploaded file, or why it can't be read: a zip
 * (ZIP_COPY), over 10 MB, a type other than Markdown, text, HTML or PDF,
 * not valid for its type, or without any text. The title is the first
 * Markdown heading or the HTML `<title>`, else the file name without its
 * extension.
 */
export async function fileText(
  name: string,
  type: string,
  bytes: Uint8Array,
): Promise<{ title: string; text: string } | { error: string }> {
  const base = baseName(name);
  const refused = refusal({ name, type, bytes });
  if (refused) return { error: refused };
  const format = FORMATS[extensionOf(base)]!;
  const fallback = oneLine(stemOf(base)) || "file";
  let title: string | null = null;
  let text: string;
  if (format === "pdf") {
    if (!isPdf(bytes)) return { error: `"${base}" isn't a PDF` };
    try {
      text = await pdfText(bytes);
    } catch {
      return { error: `"${base}" couldn't be read as a PDF` };
    }
  } else {
    const decoded = utf8(bytes);
    if (decoded === null) return { error: `"${base}" isn't UTF-8 text` };
    if (format === "html") {
      const page = await htmlToText(decoded);
      title = page.title ?? null;
      text = page.text;
    } else {
      text = decoded.replace(/^\uFEFF/, "");
      if (format === "markdown") title = markdownTitle(text);
    }
  }
  text = tidy(text);
  if (!text)
    return {
      error:
        format === "pdf"
          ? `"${base}" has no text to import (a scanned PDF needs text recognition first)`
          : `"${base}" has no text to import`,
    };
  return { title: (title && oneLine(title)) || fallback, text };
}

/** Text that fits an item: cut at the last line break under the cap, with
 *  a note saying so. */
function fitted(
  text: string,
  attached: boolean,
): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= BODY_BYTES) return { text, cut: false };
  let head = new TextDecoder().decode(bytes.subarray(0, BODY_BYTES));
  head = head.replace(/\uFFFD$/, "");
  const lineEnd = head.lastIndexOf("\n");
  if (lineEnd > BODY_BYTES / 2) head = head.slice(0, lineEnd);
  const note = attached
    ? "> The text was cut here; the full file is attached."
    : "> The text was cut here.";
  return { text: `${head.trimEnd()}\n\n${note}`, cut: true };
}

/** An attachment name for the upload: letters, digits and `._-`, `.md`
 *  for `.markdown`; null for a type the layout doesn't store (HTML). */
function attachmentName(base: string): string | null {
  let name = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-100);
  if (/\.markdown$/i.test(name)) name = name.replace(/\.markdown$/i, ".md");
  return name && hasAttachmentExtension(name) ? name : null;
}

function checkProject(project: string): void {
  try {
    knowledgeRepoName(project);
  } catch {
    throw new MemoryRepoError(`"${project}" isn't a project name.`);
  }
}

interface Prepared {
  name: string;
  title: string;
  text: string;
  attachName: string | null;
  bytes: Uint8Array;
}

const slugOf = (path: string) =>
  path.slice(FILES_DIR.length + 1, -".md".length);
const attachmentFolder = (path: string) =>
  `${ATTACHMENTS_DIR}/file+${slugOf(path)}`;

/** Read, check and fit one upload; a string says why it is skipped. */
async function prepare(file: ImportedFile): Promise<Prepared | string> {
  const name = baseName(file.name);
  const read = await fileText(file.name, file.type, file.bytes);
  if ("error" in read) return read.error;
  const attachName = attachmentName(name);
  if (findSecrets(`${name}\n${read.title}\n${read.text}`).length)
    return `"${name}" looks like it holds a credential`;
  if (
    attachName &&
    validateKnowledgeFile(`${ATTACHMENTS_DIR}/file+x/${attachName}`, file.bytes)
      .length
  )
    return `"${name}" can't be stored`;
  return {
    name,
    title: read.title,
    text: read.text,
    attachName,
    bytes: file.bytes,
  };
}

/** Where each prepared file goes: the item that imported the same name,
 *  else a free slug. */
async function plan(
  project: string,
  files: Prepared[],
  today: string,
): Promise<{
  changes: KnowledgeChange[];
  expected: Record<string, string | null>;
  cut: number;
}> {
  const changes: KnowledgeChange[] = [];
  const expected: Record<string, string | null> = {};
  const taken = new Set<string>();
  let cut = 0;
  for (const file of files) {
    const source = `file:${file.name}`;
    let path: string;
    for (;;) {
      path = freeSlugPath(taken, FILES_DIR, stemOf(file.name));
      taken.add(path);
      const current = await knowledgeRepo.call("read", project, path, today);
      if (!current) {
        expected[path] = null;
        break;
      }
      if (current.item.sources.includes(source)) {
        expected[path] = current.item.blob;
        break;
      }
    }
    const fit = fitted(file.text, file.attachName !== null);
    if (fit.cut) cut++;
    changes.push({
      op: "put",
      path,
      fm: {
        title: file.title,
        kind: "answer",
        trust: "reference",
        status: "active",
        origin: "file",
        topics: [],
        sources: [source],
        dependsOn: [],
        validAsOf: today,
      },
      body: fit.text,
    });
    if (file.attachName)
      changes.push({
        op: "attach",
        path: `${attachmentFolder(path)}/${file.attachName}`,
        bytes: file.bytes,
      });
  }
  return { changes, expected, cut };
}

/**
 * Start importing `files` for `project`; resolves with the job (it runs in
 * the background). Refuses (400) a request without files, with more than
 * MAX_IMPORT_FILES, or with a zip, an oversize file or an unread type; a
 * second file import while one runs is refused (409).
 */
export async function importFiles(
  input: { project: string; by: Author; files: ImportedFile[] },
  over: Partial<FilesDeps> = {},
): Promise<KnowledgeImportJob> {
  const { project, by, files } = input;
  checkProject(project);
  if (!files.length) throw new MemoryRepoError(NO_FILES_COPY);
  if (files.length > MAX_IMPORT_FILES)
    throw new MemoryRepoError(TOO_MANY_FILES_COPY);
  for (const file of files) {
    const refused = refusal(file);
    if (refused) throw new MemoryRepoError(refused);
  }
  const today = over.today ?? (() => new Date().toISOString().slice(0, 10));
  const names = files.map((f) => baseName(f.name));
  return startJob(
    project,
    "files",
    { by: by.name, files: names },
    async (job) => {
      await job.setTotal(files.length);
      await knowledgeRepo.call("ensureRepo", project);
      const ready: Prepared[] = [];
      let skipped = 0;
      for (const file of files) {
        job.signal.throwIfAborted();
        const prepared = await prepare(file);
        if (typeof prepared === "string") skipped++;
        else ready.push(prepared);
      }
      if (skipped) await job.progress({ skipped, done: skipped });
      if (!ready.length) return;
      const day = today();
      for (let attempt = 1; ; attempt++) {
        job.signal.throwIfAborted();
        const { changes, expected, cut } = await plan(project, ready, day);
        try {
          await knowledgeRepo.call("write", project, changes, {
            message: `Import files: ${ready.length}`,
            author: by,
            expected,
          });
          if (cut) await job.markTruncated();
          break;
        } catch (error) {
          // Someone wrote meanwhile: plan again from what is there now.
          const conflict =
            error instanceof Error && error.name === "KnowledgeConflictError";
          if (!conflict || attempt >= WRITE_ATTEMPTS) throw error;
        }
      }
      await job.progress({ reference: ready.length, done: ready.length });
    },
  );
}
