// The diff block shared by a memory repository's changes and a knowledge
// item's history, and the line the history writes under each change.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnowledgeCommit } from "../../lib/api/knowledge";
import { CommitDiff } from "./CommitDiff";
import { KnowledgeHistoryRow } from "./knowledge/KnowledgeHistory";

const DIFF = [
  "diff --git a/articles/export.md b/articles/export.md",
  "--- a/articles/export.md",
  "+++ b/articles/export.md",
  "@@ -1,3 +1,3 @@",
  " title: Exporting a project",
  "-Old answer",
  "+New answer",
  "",
].join("\n");

/** Each line's class list, in order, as the markup carries it. */
function lineClasses(html: string): string[] {
  return [...html.matchAll(/<div class="([^"]*)">/g)].map((m) => m[1]!);
}

test("a diff keeps the tones the memory repository page used", () => {
  const html = renderToStaticMarkup(<CommitDiff diff={DIFF} />);
  expect(html).toStartWith(
    '<pre class="m-0 max-h-96 overflow-auto rounded-xl bg-code-well p-3 font-mono text-meta leading-relaxed text-code-well-ink">',
  );
  const line = "whitespace-pre-wrap break-words";
  expect(lineClasses(html)).toEqual([
    `${line} text-dim`,
    `${line} text-dim`,
    `${line} text-dim`,
    `${line} text-dim`,
    line,
    `${line} text-red`,
    `${line} text-green`,
    line,
  ]);
  expect(html).toContain(">-Old answer</div>");
  expect(html).toContain(">+New answer</div>");
});

const APPROVAL: KnowledgeCommit = {
  sha: "a".repeat(40),
  author: "Ada",
  date: "2026-10-20T09:00:00Z",
  subject: "Approve Exporting a project",
  body: "Suggested-by: Pat",
  files: [
    { status: "D", path: "suggestions/export.md" },
    { status: "A", path: "articles/export.md" },
  ],
};

test("an approval reads suggested by Pat, approved by Ada", () => {
  const html = renderToStaticMarkup(
    <KnowledgeHistoryRow
      project="acme"
      path="articles/export.md"
      commit={APPROVAL}
      onReverted={() => {}}
    />,
  );
  expect(html).toContain("Approve Exporting a project");
  expect(html).toMatch(/suggested by Pat, approved by Ada/i);
  expect(html).toContain("Revert");
});
