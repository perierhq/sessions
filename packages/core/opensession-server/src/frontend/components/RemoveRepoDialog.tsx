import { type Ref, useEffect, useId, useReducer, useRef } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { InlineAlert, Skeleton, SkeletonBar } from "../ui/state";
import { errorMessage } from "../lib/error-message";
import { formatBytes } from "../lib/images";
import {
  fetchRepoRemovalPreview,
  fetchRepoRemovalStatus,
  isRemovalDeleting,
  removeRepoApi,
  type RepoRemovalOutcome,
  type RepoRemovalPreview,
  type RepoRemovalRequest,
  type RepoRemovalResult,
  type RepoRemovalStatus,
} from "../lib/api";

// Settings → Repositories → ⋯ → Remove…: the confirmation for taking a
// repository out of the registry. Shaped like ui/confirm's alert (same title
// and consequence treatment, focus parked on Cancel, a solid red commit) but
// with the parts a plain confirm can't hold: the opt-in to delete the
// checkout and everything that goes with it, the typed id when the server
// can't tell whether it made the folder, the block while a session is
// running or has the repository attached, and a failure kept inside the
// dialog instead of a toast behind it.

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sessionsSentence(preview: RepoRemovalPreview | null): string {
  const leaves = "It leaves the sidebar and the new-session pickers";
  if (!preview) return `${leaves}, and its sessions are archived.`;
  const parts = [leaves];
  if (preview.sessions === 1) parts.push("its 1 session is archived");
  else if (preview.sessions > 1)
    parts.push(`its ${preview.sessions} sessions are archived`);
  if (preview.automations === 1) parts.push("its 1 automation is turned off");
  else if (preview.automations > 1)
    parts.push(`its ${preview.automations} automations are turned off`);
  if (parts.length === 1) return `${leaves}.`;
  const last = parts.pop();
  return `${parts.join(", ")}, and ${last}.`;
}

/** "Stop 2 running sessions first", the line that explains a disabled
 *  Remove. Sessions of other repositories that attach this one count too. */
export function runningLine(running: number, attached = 0): string {
  const parts: string[] = [];
  if (running)
    parts.push(
      `stop ${plural(running, "running session", "running sessions")}`,
    );
  if (attached)
    parts.push(
      `archive ${plural(attached, "session", "sessions")} that also ${attached === 1 ? "uses" : "use"} it`,
    );
  const line = `${parts.join(" and ")} first`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** What deleting would take: its size, worktrees and unpushed branches, as
 *  far as is known. */
function deleteSummary(preview: RepoRemovalPreview): string | null {
  const parts: string[] = [];
  if (preview.sizeBytes !== undefined && preview.sizeBytes !== null)
    parts.push(formatBytes(preview.sizeBytes));
  if (preview.worktrees)
    parts.push(plural(preview.worktrees, "worktree", "worktrees"));
  if (preview.unpushedBranches)
    parts.push(
      plural(preview.unpushedBranches, "unpushed branch", "unpushed branches"),
    );
  else if (preview.unpushedBranches === null)
    parts.push("Couldn’t check for unpushed branches");
  return parts.length ? parts.join(" · ") : null;
}

/** The toast after a removal: what happened, and what didn't. */
export function removedToast(label: string, result: RepoRemovalResult): string {
  if (result.alreadyRemoved) return `${label} was already removed`;
  if (result.kept.length)
    return `Removed ${label}. Some of its files couldn’t be deleted.`;
  if (result.error) return `Removed ${label}. ${result.error}`;
  if (result.filesUnknown)
    return `Removed ${label}. Couldn’t confirm its files were deleted.`;
  return `Removed ${label}`;
}

/** Whether that toast reports something that went wrong. */
export function removedToastIsError(result: RepoRemovalResult): boolean {
  return !!(result.kept.length || result.error || result.filesUnknown);
}

export interface FollowRemovalDeps {
  fetchStatus: (id: string) => Promise<RepoRemovalStatus | null>;
  sleep: (ms: number) => Promise<void>;
}

const followDefaults: FollowRemovalDeps = {
  fetchStatus: fetchRepoRemovalStatus,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** How often, and for how long, a background delete is polled. */
export const FOLLOW_INTERVAL_MS = 2_000;
export const FOLLOW_LIMIT_MS = 10 * 60_000;

/**
 * The finished result of a removal. One whose files are still being deleted
 * on the server is polled (`GET …/removal-status`) until it is done. When
 * the server forgets it (a restart) the files are reported as unconfirmed;
 * past the time limit, as still being deleted.
 */
export async function followRemoval(
  outcome: RepoRemovalOutcome,
  deps: FollowRemovalDeps = followDefaults,
): Promise<RepoRemovalResult> {
  if (!isRemovalDeleting(outcome)) return outcome;
  const base: RepoRemovalResult = {
    id: outcome.id,
    archived: outcome.archived,
    automationsDisabled: outcome.automationsDisabled,
    deleted: [],
    kept: [],
  };
  for (let waited = 0; waited < FOLLOW_LIMIT_MS; waited += FOLLOW_INTERVAL_MS) {
    await deps.sleep(FOLLOW_INTERVAL_MS);
    let status: RepoRemovalStatus | null;
    try {
      status = await deps.fetchStatus(outcome.id);
    } catch {
      continue; // A dropped poll: try again next tick.
    }
    if (!status) return { ...base, filesUnknown: true };
    if (status.state === "done")
      return {
        ...status.result,
        archived: outcome.archived,
        automationsDisabled: outcome.automationsDisabled,
      };
  }
  return { ...base, error: "Its files are still being deleted." };
}

/** Remove is blocked: no preview yet, or a session stands in the way. */
export function removalBlocked(preview: RepoRemovalPreview | null): boolean {
  return !preview || preview.running > 0 || preview.attached > 0;
}

/**
 * The dialog's body below the title: the delete-files opt-in and whatever
 * stands in the way. Split out so it renders without the portal around it.
 */
export function RemoveRepoBody({
  repoId,
  path,
  preview,
  loadError,
  onRetry,
  deleteFiles,
  onDeleteFilesChange,
  confirmText,
  onConfirmTextChange,
  disabled,
  error,
  blockerId,
}: {
  repoId: string;
  path: string;
  preview: RepoRemovalPreview | null;
  loadError: string | null;
  onRetry: () => void;
  deleteFiles: boolean;
  onDeleteFilesChange: (next: boolean) => void;
  confirmText: string;
  onConfirmTextChange: (next: string) => void;
  disabled: boolean;
  error: string | null;
  /** Id for the alert explaining a blocked Remove (aria-describedby). */
  blockerId?: string;
}) {
  const detailId = useId();
  const confirmId = useId();
  const canDelete = !!preview?.deletable;
  const checked = deleteFiles && canDelete;
  const summary = preview?.deletable ? deleteSummary(preview) : null;
  const paths = preview?.deletable ? (preview.deletePaths ?? [path]) : [path];
  const blocking = preview ? preview.running + preview.attached : 0;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label
          className={
            canDelete && !disabled
              ? "flex cursor-pointer items-center gap-2.5 phone:min-h-11"
              : "flex cursor-default items-center gap-2.5 phone:min-h-11"
          }
        >
          <Checkbox
            checked={checked}
            disabled={!canDelete || disabled}
            onCheckedChange={(next) => onDeleteFilesChange(next === true)}
            aria-describedby={detailId}
          />
          <span
            className={
              canDelete ? "text-supporting text-fg" : "text-supporting text-dim"
            }
          >
            Also delete its files on this machine
          </span>
        </label>
        {/* Indented under the label: the checkbox's 16px plus the 10px gap. */}
        <div id={detailId} className="mt-1 min-w-0 pl-6.5">
          {/* Every path, whole: what gets deleted must never be guessed at
              from a truncated line. */}
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {paths.map((p) => (
              <li key={p} className="break-all font-mono text-meta text-dim">
                {p}
              </li>
            ))}
          </ul>
          {preview ? (
            (preview.deletable ? summary : preview.reason) && (
              <div className="mt-0.5 text-meta text-dim">
                {preview.deletable ? summary : preview.reason}
              </div>
            )
          ) : loadError ? null : (
            // The line the size or the reason lands on, held open so the
            // footer doesn't move when the preview arrives.
            <Skeleton label="Checking this repository" className="mt-1.5">
              <SkeletonBar className="h-2.5 w-28" />
            </Skeleton>
          )}
        </div>
      </div>
      {checked && (
        <InlineAlert variant="warn">
          This can’t be undone. Unpushed branches and uncommitted changes are
          lost.
        </InlineAlert>
      )}
      {checked && preview?.confirmRequired && (
        <div className="flex flex-col gap-1.5">
          {preview.tier === "unverified" && (
            <p className="m-0 text-supporting text-dim">
              {preview.reason ??
                "This server can’t tell whether it created this folder."}
            </p>
          )}
          {!!preview.strayWorktrees?.length && (
            <div>
              <p className="m-0 text-supporting text-dim">
                These worktrees will stop working.
              </p>
              <ul className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0">
                {preview.strayWorktrees.map((p) => (
                  <li
                    key={p}
                    className="break-all font-mono text-meta text-dim"
                  >
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label htmlFor={confirmId} className="text-supporting text-fg">
            Type <span className="font-mono">{repoId}</span> to delete its files
          </label>
          <Input
            id={confirmId}
            size="lg"
            className="font-mono phone:min-h-11"
            value={confirmText}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onConfirmTextChange(event.target.value)}
          />
        </div>
      )}
      {loadError && <InlineAlert onRetry={onRetry}>{loadError}</InlineAlert>}
      {preview && blocking > 0 && (
        <InlineAlert variant="info" id={blockerId}>
          <div>{runningLine(preview.running, preview.attached)}</div>
          {preview.attachedSessions.length > 0 && (
            <ul className="m-0 mt-1 list-disc pl-4">
              {preview.attachedSessions.map((s) => (
                <li key={s.id} className="break-words">
                  {s.title}
                </li>
              ))}
            </ul>
          )}
        </InlineAlert>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}
    </div>
  );
}

export interface RemoveRepoDialogState {
  preview: RepoRemovalPreview | null;
  loadError: string | null;
  deleteFiles: boolean;
  confirmText: string;
  removing: boolean;
  error: string | null;
  /** Bumped to fetch the preview again. */
  loadSeq: number;
}

export type RemoveRepoDialogAction =
  /** The dialog opened: a fresh start, choices and the last failure cleared. */
  | { type: "open" }
  /** A preview fetch started. Choices and the last failure stay. */
  | { type: "loading" }
  | { type: "loaded"; preview: RepoRemovalPreview }
  | { type: "loadFailed"; message: string }
  | { type: "retry" }
  | { type: "setDeleteFiles"; value: boolean }
  | { type: "setConfirm"; value: string }
  | { type: "removeStarted" }
  /** The removal failed: show why, and fetch what is true now. */
  | { type: "removeFailed"; message: string }
  | { type: "removeDone" };

export const initialRemoveRepoDialogState: RemoveRepoDialogState = {
  preview: null,
  loadError: null,
  deleteFiles: false,
  confirmText: "",
  removing: false,
  error: null,
  loadSeq: 0,
};

export function removeRepoDialogReducer(
  state: RemoveRepoDialogState,
  action: RemoveRepoDialogAction,
): RemoveRepoDialogState {
  switch (action.type) {
    case "open":
      return { ...initialRemoveRepoDialogState, loadSeq: state.loadSeq };
    case "loading":
      return { ...state, preview: null, loadError: null };
    case "loaded":
      return { ...state, preview: action.preview, loadError: null };
    case "loadFailed":
      return { ...state, loadError: action.message };
    case "retry":
      return { ...state, loadSeq: state.loadSeq + 1 };
    case "setDeleteFiles":
      return { ...state, deleteFiles: action.value };
    case "setConfirm":
      return { ...state, confirmText: action.value };
    case "removeStarted":
      return { ...state, removing: true, error: null };
    case "removeFailed":
      return {
        ...state,
        removing: false,
        error: action.message,
        loadSeq: state.loadSeq + 1,
      };
    case "removeDone":
      return { ...state, removing: false };
  }
}

/** What Remove would send, or null when it may not be pressed. */
export function removeRequest(
  repoId: string,
  state: RemoveRepoDialogState,
): RepoRemovalRequest | null {
  const { preview } = state;
  if (!preview || removalBlocked(preview) || state.removing) return null;
  const deleting = state.deleteFiles && preview.deletable;
  if (!deleting) return { deleteFiles: false };
  if (preview.confirmRequired) {
    if (state.confirmText.trim() !== repoId) return null;
    return {
      deleteFiles: true,
      planToken: preview.planToken,
      confirm: state.confirmText.trim(),
    };
  }
  return { deleteFiles: true, planToken: preview.planToken };
}

/**
 * Everything inside the dialog box: title, consequence, body and footer.
 * Rendered inside Modal.Content by RemoveRepoDialog; split out so a test can
 * render the whole dialog without the portal.
 */
export function RemoveRepoPanel({
  repo,
  state,
  dispatch,
  onCancel,
  onRemove,
  cancelRef,
  blockerId,
}: {
  repo: { id: string; label: string; path: string };
  state: RemoveRepoDialogState;
  dispatch: (action: RemoveRepoDialogAction) => void;
  onCancel: () => void;
  onRemove: () => void;
  cancelRef?: Ref<HTMLButtonElement>;
  blockerId: string;
}) {
  const { preview, removing } = state;
  const deleting = state.deleteFiles && !!preview?.deletable;
  const request = removeRequest(repo.id, state);
  return (
    <>
      {/* Title and consequence on ui/confirm's rhythm, so this reads as the
			    same kind of question with one more choice in it. */}
      <div className="flex flex-col gap-1.5">
        <Modal.Title className="m-0 text-balance text-dialog-title font-semibold leading-tight tracking-[-0.01em] text-fg">
          Remove {repo.label}?
        </Modal.Title>
        <Modal.Description className="m-0 text-pretty text-supporting font-normal leading-relaxed text-dim">
          {sessionsSentence(preview)}
        </Modal.Description>
      </div>
      <RemoveRepoBody
        repoId={repo.id}
        path={preview?.path ?? repo.path}
        preview={preview}
        loadError={state.loadError}
        onRetry={() => dispatch({ type: "retry" })}
        deleteFiles={state.deleteFiles}
        onDeleteFilesChange={(value) =>
          dispatch({ type: "setDeleteFiles", value })
        }
        confirmText={state.confirmText}
        onConfirmTextChange={(value) => dispatch({ type: "setConfirm", value })}
        disabled={removing}
        error={state.error}
        blockerId={blockerId}
      />
      <Modal.Footer>
        <Button
          ref={cancelRef}
          type="button"
          size="lg"
          variant="soft"
          className="phone:min-h-11 phone:flex-1"
          disabled={removing}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="lg"
          variant="danger-strong"
          className="phone:min-h-11 phone:flex-1"
          disabled={!request}
          aria-describedby={
            preview && removalBlocked(preview) ? blockerId : undefined
          }
          onClick={onRemove}
        >
          {removing
            ? "Removing…"
            : deleting
              ? "Remove and delete files"
              : "Remove"}
        </Button>
      </Modal.Footer>
    </>
  );
}

export function RemoveRepoDialog({
  repo,
  open,
  onOpenChange,
  onRemoved,
}: {
  repo: { id: string; label: string; path: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the dialog has closed, with what the server answered: a
   *  finished removal, or one still deleting files (see followRemoval). */
  onRemoved: (outcome: RepoRemovalOutcome) => void | Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const blockerId = useId();
  const [state, dispatch] = useReducer(
    removeRepoDialogReducer,
    initialRemoveRepoDialogState,
  );

  // The person's choices and the last failure reset only when the dialog
  // opens. A reload after a failed removal must keep the error on screen.
  useEffect(() => {
    if (open) dispatch({ type: "open" });
  }, [open]);

  // Fresh every time it opens, and after a failure: a session may have
  // started or stopped, or the folder changed, since it was shown.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    dispatch({ type: "loading" });
    fetchRepoRemovalPreview(repo.id)
      .then((preview) => alive && dispatch({ type: "loaded", preview }))
      .catch(
        (cause: unknown) =>
          alive &&
          dispatch({
            type: "loadFailed",
            message: errorMessage(cause, "Couldn’t check this repository"),
          }),
      );
    return () => {
      alive = false;
    };
  }, [open, repo.id, state.loadSeq]);

  async function remove() {
    const request = removeRequest(repo.id, state);
    if (!request) return;
    dispatch({ type: "removeStarted" });
    try {
      const result = await removeRepoApi(repo.id, request);
      dispatch({ type: "removeDone" });
      onOpenChange(false);
      await onRemoved(result);
    } catch (cause) {
      dispatch({
        type: "removeFailed",
        message: errorMessage(cause, "Couldn’t remove the repository"),
      });
    }
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (state.removing) return;
        onOpenChange(next);
      }}
      disablePointerDismissal={state.removing}
    >
      <Modal.Content
        role="alertdialog"
        widthClassName="max-w-[28rem]"
        initialFocus={cancelRef}
      >
        <RemoveRepoPanel
          repo={repo}
          state={state}
          dispatch={dispatch}
          onCancel={() => onOpenChange(false)}
          onRemove={() => void remove()}
          cancelRef={cancelRef}
          blockerId={blockerId}
        />
      </Modal.Content>
    </Modal.Root>
  );
}
