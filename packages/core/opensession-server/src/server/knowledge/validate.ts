/**
 * What every file in a knowledge repository must satisfy. The server runs
 * this before each knowledge commit (people's edits and ingestion alike);
 * nothing else writes to the repository.
 *
 * Reuses memory's FileProblem shape and credential patterns, but is
 * stricter about layout: items are Markdown with valid front matter, in the
 * exact form renderArticle writes, under the item folders; uploads live
 * under attachments/.
 */

import { isMarkdownPath } from "../memory-repo/format";
import { findSecrets } from "../memory-repo/secrets";
import type { FileProblem } from "../memory-repo/validate";
import { parseArticle, renderFrontMatter } from "./format";
import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENTS_DIR,
  hasAttachmentExtension,
  hasSafeSegments,
  isItemPath,
  KNOWLEDGE_ENTRY,
} from "./layout";

export type { FileProblem } from "../memory-repo/validate";
export { formatProblems } from "../memory-repo/validate";

export const MAX_ARTICLE_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const OUTSIDE_LAYOUT =
  "Knowledge files belong under articles/, suggestions/, sources/ or attachments/.";

const ATTACHMENT_LAYOUT =
  "Attachments go in attachments/<article>/<file name>.";

const ATTACHMENT_TYPES = `Attachments must be ${ATTACHMENT_EXTENSIONS.slice(0, -1).join(", ")} or ${ATTACHMENT_EXTENSIONS.at(-1)} files.`;

const BAD_NAME =
  "File and folder names may use only letters, digits and @ . _ + -, and can't start with a dot.";

const NOT_UTF8 = "File isn't UTF-8 text.";

const NOT_CANONICAL =
  "The front matter isn't in the standard form (one `key: value` per line, keys in the usual order). Save it from Knowledge to fix it.";

/** Git modes a knowledge file may have; anything else is refused. */
const MODE_PROBLEMS: Record<string, string | null> = {
  "100644": null,
  "100755": "Executable files are not allowed.",
};
const REFUSED_MODES: Record<string, string> = {
  "120000": "Symbolic links are not allowed in knowledge.",
  "160000": "Submodules are not allowed in knowledge.",
};

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function secretProblems(path: string, text: string): FileProblem[] {
  return findSecrets(text).map((finding) => ({
    path,
    line: finding.line + 1,
    message: `Looks like a ${finding.name}. Knowledge never stores credentials.`,
  }));
}

export function validateKnowledgeFile(
  path: string,
  bytes: Uint8Array,
  mode = "100644",
): FileProblem[] {
  const refused = REFUSED_MODES[mode];
  if (refused) return [{ path, message: refused }];
  if (!(mode in MODE_PROBLEMS))
    return [{ path, message: "Only regular files are allowed in knowledge." }];
  const problems: FileProblem[] = [];
  const modeProblem = MODE_PROBLEMS[mode];
  if (modeProblem) problems.push({ path, message: modeProblem });
  const fail = (message: string) => [...problems, { path, message }];

  if (path.startsWith(`${ATTACHMENTS_DIR}/`))
    return [...problems, ...attachmentProblems(path, bytes)];

  if (!hasSafeSegments(path)) return fail(BAD_NAME);
  if (looksBinary(bytes))
    return fail("Binary files belong under attachments/.");
  const item = isItemPath(path);
  if (!item && path !== KNOWLEDGE_ENTRY) return fail(OUTSIDE_LAYOUT);
  if (bytes.byteLength > MAX_ARTICLE_BYTES)
    return fail(
      `File is ${bytes.byteLength} bytes; the limit is ${MAX_ARTICLE_BYTES}. Split it into smaller articles.`,
    );
  const text = decodeUtf8(bytes);
  if (text === null) return fail(NOT_UTF8);
  problems.push(...secretProblems(path, text));
  if (!item || !isMarkdownPath(path)) return problems;
  const parsed = parseArticle(path, text);
  for (const problem of parsed.problems)
    problems.push({
      path,
      ...(problem.line ? { line: problem.line } : {}),
      message: problem.message,
    });
  if (parsed.fm) {
    // Every writer renders, so the stored block is exactly what
    // renderArticle writes: no comments, aliases, reordering or restyling
    // that a reader could interpret differently from the index.
    const block = renderFrontMatter(parsed.fm);
    if (!text.startsWith(block) && text !== block.slice(0, -1))
      problems.push({ path, line: 1, message: NOT_CANONICAL });
  }
  return problems;
}

function attachmentProblems(path: string, bytes: Uint8Array): FileProblem[] {
  const fail = (message: string) => [{ path, message }];
  const parts = path.split("/");
  if (parts.length !== 3) return fail(ATTACHMENT_LAYOUT);
  if (!hasSafeSegments(path)) return fail(BAD_NAME);
  if (!hasAttachmentExtension(parts[2])) return fail(ATTACHMENT_TYPES);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return fail(
      `File is ${bytes.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}.`,
    );
  if (/\.(?:md|txt)$/i.test(parts[2])) {
    const text = decodeUtf8(bytes);
    if (text === null) return fail(NOT_UTF8);
    return secretProblems(path, text);
  }
  if (looksBinary(bytes)) return [];
  return secretProblems(path, new TextDecoder().decode(bytes));
}
