import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RepoRemovalPreview } from "../lib/api";
import { Modal } from "../ui/modal";
import {
  RemoveRepoBody,
  RemoveRepoPanel,
  initialRemoveRepoDialogState,
  removeRepoDialogReducer,
  removeRequest,
  removedToast,
  runningLine,
  type RemoveRepoDialogAction,
  type RemoveRepoDialogState,
} from "./RemoveRepoDialog";

const PATH = "/home/acme/checkouts/widget";
const ORIGIN = "/home/acme/checkouts/widget.git";
const WORKTREE =
  "/home/acme/worktrees/widget-a-very-long-branch-name-that-wraps";
const REPO = { id: "widget", label: "Widget", path: PATH };

function preview(over: Partial<RepoRemovalPreview> = {}): RepoRemovalPreview {
  return {
    id: "widget",
    label: "Widget",
    path: PATH,
    sessions: 2,
    running: 0,
    attached: 0,
    attachedSessions: [],
    automations: 0,
    deletable: true,
    tier: "managed",
    deletePaths: [WORKTREE, PATH, ORIGIN],
    worktrees: 1,
    sizeBytes: 5 * 1024 * 1024,
    unpushedBranches: 0,
    planToken: "a".repeat(32),
    ...over,
  };
}

function render(
  value: RepoRemovalPreview | null,
  extra: {
    loadError?: string;
    error?: string;
    deleteFiles?: boolean;
    confirmText?: string;
  } = {},
): string {
  return renderToStaticMarkup(
    <RemoveRepoBody
      repoId="widget"
      path={PATH}
      preview={value}
      loadError={extra.loadError ?? null}
      onRetry={() => {}}
      deleteFiles={extra.deleteFiles ?? false}
      onDeleteFilesChange={() => {}}
      confirmText={extra.confirmText ?? ""}
      onConfirmTextChange={() => {}}
      disabled={false}
      error={extra.error ?? null}
      blockerId="blocker"
    />,
  );
}

/** The whole dialog box (title, body, footer) at `state`, without the
 *  portal Modal.Content would put it in. */
function renderPanel(state: RemoveRepoDialogState): string {
  return renderToStaticMarkup(
    <Modal.Root open>
      <RemoveRepoPanel
        repo={REPO}
        state={state}
        dispatch={() => {}}
        onCancel={() => {}}
        onRemove={() => {}}
        blockerId="blocker"
      />
    </Modal.Root>,
  );
}

function run(...actions: RemoveRepoDialogAction[]): RemoveRepoDialogState {
  return actions.reduce(removeRepoDialogReducer, initialRemoveRepoDialogState);
}

/** The Remove button's opening tag. */
function removeButton(markup: string): string {
  const tags = markup.match(/<button[^>]*>/g) ?? [];
  return tags[tags.length - 1] ?? "";
}

/** The tag carries the disabled attribute (not just a disabled: class). */
function isDisabled(tag: string): boolean {
  return /\sdisabled(=""|\s|>)/.test(tag);
}

test("a managed checkout lists every path it would delete, whole", () => {
  const markup = render(preview({ unpushedBranches: 2 }));
  expect(markup).toContain("Also delete its files on this machine");
  for (const path of [WORKTREE, PATH, ORIGIN]) expect(markup).toContain(path);
  expect(markup).toContain("break-all");
  expect(markup).not.toContain("truncate");
  expect(markup).toContain("5.0 MB · 1 worktree · 2 unpushed branches");
  expect(markup).not.toContain("data-disabled");
  expect(markup).not.toContain("running");
});

test("checking the box warns that it can't be undone", () => {
  expect(render(preview())).not.toContain("can’t be undone");
  expect(render(preview(), { deleteFiles: true })).toContain(
    "This can’t be undone. Unpushed branches and uncommitted changes are lost.",
  );
});

test("a folder the server may not have made asks for the id", () => {
  const unverified = preview({
    tier: "unverified",
    confirmRequired: true,
    reason: "This server can't tell whether it created this folder.",
  });
  expect(render(unverified)).not.toContain('spellCheck="false"');
  const markup = render(unverified, { deleteFiles: true });
  expect(markup).toContain("tell whether it created this folder.");
  expect(markup).toContain("to delete its files");
  expect(markup).toContain('spellCheck="false"');
});

test("a folder added from disk disables deletion and says why", () => {
  const markup = render(
    preview({
      deletable: false,
      tier: "never",
      reason: "Added from an existing folder, so its files stay",
      deletePaths: undefined,
      worktrees: undefined,
      sizeBytes: undefined,
      planToken: undefined,
    }),
  );
  expect(markup).toContain("data-disabled");
  expect(markup).toContain("Added from an existing folder, so its files stay");
  expect(markup).toContain(PATH);
  expect(markup).not.toContain("MB");
});

test("running and attaching sessions are counted, and attached ones named", () => {
  expect(render(preview({ running: 2 }))).toContain(
    "Stop 2 running sessions first",
  );
  expect(runningLine(1)).toBe("Stop 1 running session first");
  expect(runningLine(1, 2)).toBe(
    "Stop 1 running session and archive 2 sessions that also use it first",
  );
  const markup = render(
    preview({
      attached: 1,
      attachedSessions: [{ id: "s9", title: "Cross-repo change" }],
    }),
  );
  expect(markup).toContain("Archive 1 session that also uses it first");
  expect(markup).toContain("Cross-repo change");
  expect(markup).toContain('id="blocker"');
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

test("the whole dialog: a failed removal stays on screen through the reload", () => {
  const first = preview();
  let state = run(
    { type: "open" },
    { type: "loading" },
    { type: "loaded", preview: first },
    { type: "setDeleteFiles", value: true },
  );
  let markup = renderPanel(state);
  expect(markup).toContain("Remove Widget?");
  expect(markup).toContain(
    "It leaves the sidebar and the new-session pickers, and its 2 sessions are archived.",
  );
  expect(markup).toContain("Remove and delete files");
  expect(isDisabled(removeButton(markup))).toBe(false);
  expect(removeRequest("widget", state)).toEqual({
    deleteFiles: true,
    planToken: first.planToken,
  });

  // The server refuses; the dialog fetches the preview again.
  const refused: RemoveRepoDialogAction[] = [
    { type: "open" },
    { type: "loading" },
    { type: "loaded", preview: first },
    { type: "setDeleteFiles", value: true },
    { type: "removeStarted" },
    { type: "removeFailed", message: "The repository changed; review again." },
    { type: "loading" },
  ];
  state = run(...refused);
  expect(state.loadSeq).toBe(1);
  expect(renderPanel(state)).toContain("The repository changed; review again.");
  state = removeRepoDialogReducer(state, {
    type: "loaded",
    preview: preview({ planToken: "b".repeat(32) }),
  });
  markup = renderPanel(state);
  expect(markup).toContain("The repository changed; review again.");
  expect(state.deleteFiles).toBe(true);
  expect(removeRequest("widget", state)?.planToken).toBe("b".repeat(32));

  // Opening it again starts clean.
  state = removeRepoDialogReducer(state, { type: "open" });
  expect(state.error).toBeNull();
  expect(state.deleteFiles).toBe(false);
});

test("the whole dialog: a blocked Remove points at the reason", () => {
  const state = run(
    { type: "open" },
    { type: "loaded", preview: preview({ running: 1, automations: 2 }) },
  );
  const markup = renderPanel(state);
  expect(markup).toContain("its 2 automations are turned off");
  const button = removeButton(markup);
  expect(isDisabled(button)).toBe(true);
  expect(button).toContain('aria-describedby="blocker"');
  expect(markup).toContain('id="blocker"');
  expect(removeRequest("widget", state)).toBeNull();
});

test("the whole dialog: the typed id unlocks deleting an unverified folder", () => {
  let state = run(
    { type: "open" },
    {
      type: "loaded",
      preview: preview({ tier: "unverified", confirmRequired: true }),
    },
    { type: "setDeleteFiles", value: true },
  );
  expect(removeRequest("widget", state)).toBeNull();
  expect(isDisabled(removeButton(renderPanel(state)))).toBe(true);
  state = removeRepoDialogReducer(state, {
    type: "setConfirm",
    value: "widget",
  });
  expect(removeRequest("widget", state)).toEqual({
    deleteFiles: true,
    planToken: "a".repeat(32),
    confirm: "widget",
  });
  // Without deleting, nothing needs typing.
  state = removeRepoDialogReducer(state, {
    type: "setDeleteFiles",
    value: false,
  });
  state = removeRepoDialogReducer(state, { type: "setConfirm", value: "" });
  expect(removeRequest("widget", state)).toEqual({ deleteFiles: false });
});

test("the toast says what happened", () => {
  const done = {
    id: "widget",
    archived: 0,
    automationsDisabled: 0,
    deleted: [],
    kept: [],
  };
  expect(removedToast("Widget", done)).toBe("Removed Widget");
  expect(removedToast("Widget", { ...done, alreadyRemoved: true })).toBe(
    "Widget was already removed",
  );
  expect(removedToast("Widget", { ...done, kept: [PATH] })).toBe(
    "Removed Widget. Some of its files couldn’t be deleted.",
  );
});
