import { expect, test } from "bun:test";
import type { KnowledgeCommit } from "../api/knowledge";
import { commitByline, revertCopy, suggestedBy } from "./history";

const commit = (over: Partial<KnowledgeCommit>): KnowledgeCommit => ({
  sha: "a".repeat(40),
  author: "Ada",
  date: "2026-10-20T09:00:00Z",
  subject: "Edit Exporting a project",
  body: "",
  files: [{ status: "M", path: "articles/export.md" }],
  ...over,
});

test("the Suggested-by trailer names who proposed the change", () => {
  expect(suggestedBy(commit({ body: "Suggested-by: Pat" }))).toBe("Pat");
  expect(
    suggestedBy(commit({ body: "Two lines.\n\nsuggested-by:  Pat  " })),
  ).toBe("Pat");
  expect(suggestedBy(commit({ body: "Reverts: abc" }))).toBeNull();
});

test("an approval names both people; anything else its author", () => {
  expect(
    commitByline(
      commit({ subject: "Approve Exporting", body: "Suggested-by: Pat" }),
    ),
  ).toBe("Suggested by Pat, approved by Ada");
  // Pat's own commits (imports, re-validation) are just Pat's.
  expect(
    commitByline(commit({ author: "Pat", body: "Suggested-by: Pat" })),
  ).toBe("Pat");
  expect(commitByline(commit({}))).toBe("Ada");
});

test("the revert confirm says what else the change touched", () => {
  const one = commit({});
  expect(revertCopy(one, "articles/export.md")).toEqual({
    title: "Revert this change?",
    description: "Adds a new change that undoes “Edit Exporting a project”.",
  });
  const many = commit({
    subject: "Import mail: 3 answers (1 trusted)",
    files: [
      { status: "A", path: "articles/export.md" },
      { status: "A", path: "sources/mail/2026-10/a.md" },
      { status: "A", path: "sources/mail/2026-10/b.md" },
    ],
  });
  expect(revertCopy(many, "articles/export.md").description).toBe(
    "Adds a new change that undoes “Import mail: 3 answers (1 trusted)”, including 2 other files.",
  );
  const two = commit({
    files: [
      { status: "D", path: "suggestions/export.md" },
      { status: "A", path: "articles/export.md" },
    ],
  });
  expect(revertCopy(two, "articles/export.md").description).toEndWith(
    ", including 1 other file.",
  );
  // The whole repository's history: every file counts.
  expect(revertCopy(many, undefined).description).toEndWith("” in 3 files.");
  expect(revertCopy(one, undefined).description).toEndWith("project”.");
});
