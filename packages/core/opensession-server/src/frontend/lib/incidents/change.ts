// A findings change block as a summary: which files a PR or commit
// touches with their line counts, and the one hunk the agent cited. The
// whole diff stays in the review. Pure.
import { splitPatchByFile } from "../pr-review-guide";
import type { PrFile } from "../types";

/** How many files a change block lists before "N more". */
export const CHANGE_FILES_SHOWN = 5;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** One file's chunk of a unified diff: its header (before the first
 *  hunk) and its hunks, each a list of lines. */
interface FileHunks {
  header: string[];
  hunks: string[][];
}

function hunksOf(chunk: string): FileHunks {
  const header: string[] = [];
  const hunks: string[][] = [];
  for (const line of chunk.replace(/\n$/, "").split("\n")) {
    if (HUNK.test(line)) hunks.push([line]);
    else if (hunks.length) hunks.at(-1)!.push(line);
    else header.push(line);
  }
  return { header, hunks };
}

/** Each file of a patch with its added and removed lines, in patch order.
 *  Only lines inside hunks count, so a `+++` header never does. */
export function patchFileStats(patch: string): PrFile[] {
  return [...splitPatchByFile(patch)].map(([path, chunk]) => {
    let additions = 0;
    let deletions = 0;
    for (const hunk of hunksOf(chunk).hunks)
      for (const line of hunk.slice(1))
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
    return { path, additions, deletions };
  });
}

/** The chunk of `file`: its exact path, else the one path ending in it. */
function fileChunk(patch: string, file: string): string | null {
  const byFile = splitPatchByFile(patch);
  const exact = byFile.get(file);
  if (exact) return exact;
  const tail = file.startsWith("/") ? file : `/${file}`;
  const matches = [...byFile].filter(([path]) => path.endsWith(tail));
  return matches.length === 1 ? matches[0]![1] : null;
}

/** The cited file's header and one hunk: the hunk whose new side holds
 *  `line`, else the file's first. Null without a file, or when the patch
 *  does not hold it. */
export function citedHunk(
  patch: string,
  file: string | undefined,
  line?: number,
): string | null {
  if (!file) return null;
  const chunk = fileChunk(patch, file);
  if (!chunk) return null;
  const { header, hunks } = hunksOf(chunk);
  if (hunks.length === 0) return null;
  const holding =
    line === undefined
      ? undefined
      : hunks.find((hunk) => {
          const m = HUNK.exec(hunk[0]!);
          const start = Number(m?.[1]);
          const count = m?.[2] === undefined ? 1 : Number(m[2]);
          return line >= start && line < start + Math.max(count, 1);
        });
  return [...header, ...(holding ?? hunks[0]!)].join("\n");
}

/** The files a block lists and how many more the change has. */
export interface ShownFiles {
  files: PrFile[];
  more: number;
}

export function shownFiles(
  files: readonly PrFile[],
  total: number,
): ShownFiles {
  const shown = files.slice(0, CHANGE_FILES_SHOWN);
  return { files: shown, more: Math.max(total, files.length) - shown.length };
}

/** The last row of a long file list: the rest are in the review (a PR's
 *  Show source) or on the commit's page (its link). */
export function changeMoreCopy(more: number, kind: "pr" | "commit"): string {
  const files = `${more} more ${more === 1 ? "file" : "files"}`;
  return kind === "pr" ? `${files} in the review` : files;
}
