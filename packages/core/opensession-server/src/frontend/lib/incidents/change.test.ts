import { expect, test } from "bun:test";
import {
  CHANGE_FILES_SHOWN,
  citedHunk,
  patchFileStats,
  shownFiles,
} from "./change";

const PATCH = [
  "diff --git a/AGENTS.md b/AGENTS.md",
  "index 1..2 100644",
  "--- a/AGENTS.md",
  "+++ b/AGENTS.md",
  "@@ -514,3 +514,3 @@ rules",
  " keep",
  "-old rule",
  "+new rule",
  "diff --git a/src/db.ts b/src/db.ts",
  "index 3..4 100644",
  "--- a/src/db.ts",
  "+++ b/src/db.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const replicas = 2;",
  "+const replicas = 1;",
  "@@ -40,4 +40,6 @@ export function pool() {",
  "   return x;",
  "+  // --- not a header",
  "+  log();",
  " }",
].join("\n");

test("files with their added and removed lines, from a patch", () => {
  expect(patchFileStats(PATCH)).toEqual([
    { path: "AGENTS.md", additions: 1, deletions: 1 },
    { path: "src/db.ts", additions: 3, deletions: 1 },
  ]);
});

test("the cited file's hunk: the one holding the line, else the first", () => {
  const hunk = citedHunk(PATCH, "src/db.ts", 41);
  expect(hunk).toContain("+++ b/src/db.ts");
  expect(hunk).toContain("@@ -40,4 +40,6 @@");
  expect(hunk).not.toContain("replicas");
  expect(hunk).not.toContain("AGENTS.md");
  const first = citedHunk(PATCH, "src/db.ts");
  expect(first).toContain("+const replicas = 1;");
  expect(first).not.toContain("@@ -40");
  // A path given without its folder still finds the file.
  expect(citedHunk(PATCH, "db.ts")).toBe(first);
  expect(citedHunk(PATCH, "missing.ts")).toBeNull();
  expect(citedHunk(PATCH, undefined)).toBeNull();
});

test("a long file list shows its first files and counts the rest", () => {
  const files = Array.from({ length: 8 }, (_, i) => ({
    path: `f${i}.ts`,
    additions: i,
    deletions: 0,
  }));
  expect(shownFiles(files, 8)).toEqual({
    files: files.slice(0, CHANGE_FILES_SHOWN),
    more: 8 - CHANGE_FILES_SHOWN,
  });
  // The PR may count more files than it listed.
  expect(shownFiles(files.slice(0, 2), 4)).toEqual({
    files: files.slice(0, 2),
    more: 2,
  });
});
