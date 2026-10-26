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
 * more than MAX_IMPORT_FILES, two files with the same name, a zip, a file
 * over 10 MB or a type this doesn't read. In the job, a file whose text
 * can't be read (a scanned PDF, not UTF-8) or that looks like it holds a
 * credential is skipped, counted and named in the job record with why,
 * never redacted into knowledge. Text over the article cap is cut with a
 * note (the job records it was cut). One commit per request, authored by
 * the person who uploaded.
 *
 * PDF text comes from `unpdf` (pdf.js without a worker; this pdf.js never
 * evaluates code from a file), read in a child process with a time and
 * memory limit (pdf-text.ts). That child checks every page and the
 * metadata for credentials; a PDF too long to check in full keeps its
 * text but isn't attached. Reuses web-fetch.ts htmlToText, the job records
 * of jobs.ts, layout's freeSlugPath and the validator. Nothing runs at
 * import.
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
import { type PdfChildOptions, pdfTextInChild } from "./pdf-text";

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
export const DUPLICATE_NAMES_COPY =
  "Two files have the same name; rename one and import again";
export const FILE_TYPES_COPY =
  "Import Markdown, text, HTML or PDF files (.md, .txt, .html, .pdf)";

/** Room left for the front matter and the cut note under the article cap. */
const BODY_BYTES = MAX_ARTICLE_BYTES - 4096;
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
    .map((line) => line.trimEnd())
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

const isBlank = (c: string | undefined) => c === " " || c === "\t";

/** The first `# heading` of Markdown, without a closing `#` run. Read by
 *  hand: a regex with a lazy group before a trailing class backtracks over
 *  a long line of `#`s. */
function markdownTitle(text: string): string | null {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    if (text[start] === "#" && isBlank(text[start + 1])) {
      let head = start + 2;
      let tail = end;
      while (head < tail && isBlank(text[head])) head++;
      while (tail > head && /\s/.test(text[tail - 1]!)) tail--;
      // A closing run of `#`s counts only after a blank.
      let hashes = tail;
      while (hashes > head && text[hashes - 1] === "#") hashes--;
      if (hashes < tail && (hashes === head || isBlank(text[hashes - 1]))) {
        tail = hashes;
        while (tail > head && isBlank(text[tail - 1])) tail--;
      }
      const title = text.slice(head, tail).trim();
      if (title) return title;
    }
    start = end + 1;
  }
  return null;
}

const credentialCopy = (base: string) =>
  `"${base}" looks like it holds a credential`;

const isPdf = (bytes: Uint8Array) =>
  new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");

/** What fileText reads from an upload. `cut`: the PDF had more text than
 *  its reader sends. `partial`: pages past PDF_MAX_PAGES weren't read or
 *  checked, so the file isn't attached. */
export type FileText =
  | { title: string; text: string; cut?: boolean; partial?: boolean }
  | { error: string };

/** Why a PDF's reader gave no text, in a skipped file's words. */
function pdfError(base: string, error: "timeout" | "memory" | "unreadable") {
  if (error === "timeout") return `"${base}" took too long to read`;
  if (error === "memory") return `"${base}" needed too much memory to read`;
  return `"${base}" couldn't be read as a PDF`;
}

/**
 * The title and text of an uploaded file, or why it can't be read: a zip
 * (ZIP_COPY), over 10 MB, a type other than Markdown, text, HTML or PDF,
 * not valid for its type, a PDF that looks like it holds a credential
 * (its reader checks every page and the metadata), or without any text.
 * The title is the first Markdown heading or the HTML `<title>`, else the
 * file name without its extension. Rejects with `pdf.signal`'s reason when
 * it aborts while a PDF is read.
 */
export async function fileText(
  name: string,
  type: string,
  bytes: Uint8Array,
  pdf: PdfChildOptions = {},
): Promise<FileText> {
  const base = baseName(name);
  const refused = refusal({ name, type, bytes });
  if (refused) return { error: refused };
  const format = FORMATS[extensionOf(base)]!;
  const fallback = oneLine(stemOf(base)) || "file";
  let title: string | null = null;
  let text: string;
  let cut = false;
  let partial = false;
  if (format === "pdf") {
    if (!isPdf(bytes)) return { error: `"${base}" isn't a PDF` };
    const read = await pdfTextInChild(bytes, pdf);
    if ("error" in read) return { error: pdfError(base, read.error) };
    if ("secret" in read) return { error: credentialCopy(base) };
    ({ text, cut, partial } = read);
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
  return {
    title: (title && oneLine(title)) || fallback,
    text,
    ...(cut ? { cut } : {}),
    ...(partial ? { partial } : {}),
  };
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
  /** Part of the file was left out (a PDF's reader cut or stopped). */
  cut: boolean;
}

const slugOf = (path: string) =>
  path.slice(FILES_DIR.length + 1, -".md".length);
const attachmentFolder = (path: string) =>
  `${ATTACHMENTS_DIR}/file+${slugOf(path)}`;

/** Read, check and fit one upload; a string says why it is skipped. */
async function prepare(
  file: ImportedFile,
  signal: AbortSignal,
): Promise<Prepared | string> {
  const name = baseName(file.name);
  const read = await fileText(file.name, file.type, file.bytes, { signal });
  if ("error" in read) return read.error;
  // A PDF too long to check in full keeps its text, never its bytes.
  const attachName = read.partial ? null : attachmentName(name);
  if (findSecrets(`${name}\n${read.title}\n${read.text}`).length)
    return credentialCopy(name);
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
    cut: read.cut === true || read.partial === true,
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
    if (fit.cut || file.cut) cut++;
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
 * MAX_IMPORT_FILES, with two files of the same name, or with a zip, an
 * oversize file or an unread type; a second file import while one runs is
 * refused (409). Each skipped file is named in the job with why.
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
  const names = files.map((f) => baseName(f.name));
  // Both would claim one item (`file:<name>`), the second silently.
  if (new Set(names).size < names.length)
    throw new MemoryRepoError(DUPLICATE_NAMES_COPY);
  const today = over.today ?? (() => new Date().toISOString().slice(0, 10));
  return startJob(
    project,
    "files",
    { by: by.name, files: names },
    async (job) => {
      await job.setTotal(files.length);
      job.phase("Opening the knowledge repository");
      await knowledgeRepo.call("ensureRepo", project);
      const ready: Prepared[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      for (const [i, file] of files.entries()) {
        job.signal.throwIfAborted();
        job.phase("Reading files", { done: i, total: files.length });
        const prepared = await prepare(file, job.signal);
        if (typeof prepared === "string")
          skipped.push({ name: baseName(file.name), reason: prepared });
        else ready.push(prepared);
      }
      if (skipped.length) {
        await job.recordSkipped(skipped);
        await job.progress({ skipped: skipped.length, done: skipped.length });
      }
      if (!ready.length) return;
      const day = today();
      for (let attempt = 1; ; attempt++) {
        job.signal.throwIfAborted();
        const { changes, expected, cut } = await plan(project, ready, day);
        job.phase("Committing");
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
