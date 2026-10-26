/**
 * What every file in a knowledge repository must satisfy. The server runs
 * this before each knowledge commit (people's edits and ingestion alike);
 * nothing else writes to the repository.
 *
 * Reuses memory's FileProblem shape and credential patterns, but is
 * stricter about layout: items are Markdown with valid front matter under
 * the item folders, binaries live under attachments/.
 */

import { isMarkdownPath } from "../memory-repo/format";
import { findSecrets } from "../memory-repo/secrets";
import type { FileProblem } from "../memory-repo/validate";
import { parseArticle } from "./format";
import {
  ATTACHMENTS_DIR,
  isAttachmentPath,
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

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
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
  if (mode === "120000")
    return [{ path, message: "Symbolic links are not allowed in knowledge." }];
  if (mode === "160000")
    return [{ path, message: "Submodules are not allowed in knowledge." }];
  const problems: FileProblem[] = [];
  if (mode === "100755")
    problems.push({ path, message: "Executable files are not allowed." });

  if (isAttachmentPath(path)) {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
      return [
        ...problems,
        {
          path,
          message: `File is ${bytes.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}.`,
        },
      ];
    if (looksBinary(bytes)) return problems;
    return [
      ...problems,
      ...secretProblems(path, new TextDecoder().decode(bytes)),
    ];
  }

  if (path.startsWith(`${ATTACHMENTS_DIR}/`))
    return [...problems, { path, message: ATTACHMENT_LAYOUT }];
  if (looksBinary(bytes))
    return [
      ...problems,
      { path, message: "Binary files belong under attachments/." },
    ];
  const item = isItemPath(path);
  if (!item && path !== KNOWLEDGE_ENTRY)
    return [...problems, { path, message: OUTSIDE_LAYOUT }];
  if (bytes.byteLength > MAX_ARTICLE_BYTES)
    return [
      ...problems,
      {
        path,
        message: `File is ${bytes.byteLength} bytes; the limit is ${MAX_ARTICLE_BYTES}. Split it into smaller articles.`,
      },
    ];
  const text = new TextDecoder().decode(bytes);
  problems.push(...secretProblems(path, text));
  if (!item || !isMarkdownPath(path)) return problems;
  for (const problem of parseArticle(path, text).problems)
    problems.push({
      path,
      ...(problem.line ? { line: problem.line } : {}),
      message: problem.message,
    });
  return problems;
}
