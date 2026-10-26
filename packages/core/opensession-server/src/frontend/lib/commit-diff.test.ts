import { expect, test } from "bun:test";
import { diffForPath, diffLineTone } from "./commit-diff";

test("diff lines are tagged for colouring", () => {
  expect(diffLineTone("diff --git a/x b/x")).toBe("meta");
  expect(diffLineTone("--- a/x")).toBe("meta");
  expect(diffLineTone("+++ b/x")).toBe("meta");
  expect(diffLineTone("@@ -1 +1 @@")).toBe("meta");
  expect(diffLineTone("+added")).toBe("add");
  expect(diffLineTone("-removed")).toBe("remove");
  expect(diffLineTone(" context")).toBe("plain");
});

const SHOW = [
  " articles/a.md | 2 +-",
  " sources/mail/2026-10/b.md | 1 +",
  " 2 files changed, 2 insertions(+), 1 deletion(-)",
  "",
  "diff --git a/articles/a.md b/articles/a.md",
  "--- a/articles/a.md",
  "+++ b/articles/a.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/sources/mail/2026-10/b.md b/sources/mail/2026-10/b.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/sources/mail/2026-10/b.md",
  "@@ -0,0 +1 @@",
  "+mail",
  "",
].join("\n");

test("a commit's diff narrows to one file", () => {
  expect(diffForPath(SHOW, "articles/a.md")).toBe(
    [
      "diff --git a/articles/a.md b/articles/a.md",
      "--- a/articles/a.md",
      "+++ b/articles/a.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
  );
  expect(diffForPath(SHOW, "sources/mail/2026-10/b.md")).toEndWith("+mail");
});

test("a file the diff doesn't show leaves the whole diff", () => {
  expect(diffForPath(SHOW, "articles/missing.md")).toBe(SHOW);
  // A path that only prefixes another isn't that file.
  expect(diffForPath(SHOW, "articles/a")).toBe(SHOW);
});
