import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RepoRemovalPreview } from "../lib/api";
import { RemoveRepoBody, runningLine } from "./RemoveRepoDialog";

const PATH = "/home/acme/checkouts/widget";

function preview(over: Partial<RepoRemovalPreview> = {}): RepoRemovalPreview {
  return {
    id: "widget",
    label: "widget",
    path: PATH,
    sessions: 2,
    running: 0,
    deletable: true,
    deletePaths: [PATH],
    worktrees: 3,
    sizeBytes: 5 * 1024 * 1024,
    ...over,
  };
}

function render(
  value: RepoRemovalPreview | null,
  extra: { loadError?: string; error?: string; deleteFiles?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <RemoveRepoBody
      path={PATH}
      preview={value}
      loadError={extra.loadError ?? null}
      onRetry={() => {}}
      deleteFiles={extra.deleteFiles ?? false}
      onDeleteFilesChange={() => {}}
      disabled={false}
      error={extra.error ?? null}
    />,
  );
}

test("a managed checkout offers deletion with its path, size and worktrees", () => {
  const markup = render(preview());
  expect(markup).toContain("Also delete its files on this machine");
  expect(markup).toContain(PATH);
  expect(markup).toContain("5.0 MB · 3 worktrees");
  expect(markup).not.toContain("data-disabled");
  expect(markup).not.toContain("running");
});

test("a folder added from disk disables deletion and says why", () => {
  const markup = render(
    preview({
      deletable: false,
      reason: "Added from an existing folder, so its files stay",
      deletePaths: undefined,
      worktrees: undefined,
      sizeBytes: undefined,
    }),
  );
  expect(markup).toContain("data-disabled");
  expect(markup).toContain("Added from an existing folder, so its files stay");
  expect(markup).not.toContain("MB");
});

test("running sessions are named with their count", () => {
  expect(render(preview({ running: 2 }))).toContain(
    "Stop 2 running sessions first",
  );
  expect(runningLine(1)).toBe("Stop 1 running session first");
});

test("while the preview loads the checkbox waits and the detail line is held", () => {
  const markup = render(null);
  expect(markup).toContain("data-disabled");
  expect(markup).toContain('aria-label="Checking this repository"');
});

test("a failed load offers a retry, and a failed removal shows in the dialog", () => {
  expect(
    render(null, { loadError: "Couldn’t check this repository" }),
  ).toContain("Try again");
  expect(
    render(preview(), { error: "Stop 1 running session first" }),
  ).toContain('role="alert"');
});
