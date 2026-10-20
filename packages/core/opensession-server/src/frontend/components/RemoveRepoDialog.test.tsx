import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RepoRemovalPreview } from "../lib/api";
import { Modal } from "../ui/modal";
import {
  FOLLOW_INTERVAL_MS,
  FOLLOW_LIMIT_MS,
  RemoveRepoBody,
  RemoveRepoPanel,
  followRemoval,
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

test("worktrees deleting leaves behind are listed and need the typed id", () => {
  const stray = "/home/acme/elsewhere/hand-made";
  const value = preview({ confirmRequired: true, strayWorktrees: [stray] });
  expect(render(value)).not.toContain(stray);
  const markup = render(value, { deleteFiles: true });
  expect(markup).toContain("These worktrees will stop working.");
  expect(markup).toContain(stray);
  expect(markup).toContain("to delete its files");
  // A managed folder: the server made it, so no doubt about that is shown.
  expect(markup).not.toContain("tell whether it created this folder");
  let state = run(
    { type: "open" },
    { type: "loaded", preview: value },
    { type: "setDeleteFiles", value: true },
  );
  expect(removeRequest("widget", state)).toBeNull();
  state = removeRepoDialogReducer(state, {
    type: "setConfirm",
    value: "widget",
  });
  expect(removeRequest("widget", state)).toMatchObject({ confirm: "widget" });
});

test("says so when unpushed branches couldn't be checked", () => {
  expect(render(preview({ unpushedBranches: null }))).toContain(
    "5.0 MB · 1 worktree · Couldn’t check for unpushed branches",
  );
  expect(render(preview())).not.toContain("Couldn’t check");
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

test("a removal still deleting files is followed until it is done", async () => {
  const statuses = [
    { id: "widget", state: "deleting" as const, startedAt: "t", plan: [PATH] },
    new Error("dropped"),
    {
      id: "widget",
      state: "done" as const,
      startedAt: "t",
      finishedAt: "u",
      result: {
        id: "widget",
        archived: 0,
        automationsDisabled: 0,
        deleted: [PATH],
        kept: [],
      },
    },
  ];
  const slept: number[] = [];
  const result = await followRemoval(
    {
      id: "widget",
      removed: true,
      deleting: true,
      archived: 2,
      automationsDisabled: 1,
      plan: [PATH],
    },
    {
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetchStatus: async () => {
        const next = statuses.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    },
  );
  expect(slept).toEqual([
    FOLLOW_INTERVAL_MS,
    FOLLOW_INTERVAL_MS,
    FOLLOW_INTERVAL_MS,
  ]);
  expect(result).toMatchObject({
    deleted: [PATH],
    kept: [],
    archived: 2,
    automationsDisabled: 1,
  });
  expect(removedToast("Widget", result)).toBe("Removed Widget");
});

test("a removal the server forgot, or one that runs too long, says so", async () => {
  const deleting = {
    id: "widget",
    removed: true as const,
    deleting: true as const,
    archived: 0,
    automationsDisabled: 0,
    plan: [PATH],
  };
  const sleep = async () => {};
  const forgotten = await followRemoval(deleting, {
    sleep,
    fetchStatus: async () => null,
  });
  expect(removedToast("Widget", forgotten)).toBe(
    "Removed Widget. Couldn’t confirm its files were deleted.",
  );
  let polls = 0;
  const slow = await followRemoval(deleting, {
    sleep,
    fetchStatus: async () => {
      polls++;
      return { id: "widget", state: "deleting", startedAt: "t", plan: [PATH] };
    },
  });
  expect(polls).toBe(FOLLOW_LIMIT_MS / FOLLOW_INTERVAL_MS);
  expect(removedToast("Widget", slow)).toBe(
    "Removed Widget. Its files are still being deleted.",
  );
  // A finished removal passes straight through.
  const done = {
    id: "widget",
    archived: 0,
    automationsDisabled: 0,
    deleted: [],
    kept: [],
  };
  expect(await followRemoval(done)).toBe(done);
});
