import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Modal } from "../ui/modal";
import { InlineAlert, Skeleton, SkeletonBar } from "../ui/state";
import { errorMessage } from "../lib/error-message";
import { formatBytes } from "../lib/images";
import {
  fetchRepoRemovalPreview,
  removeRepoApi,
  type RepoRemovalPreview,
  type RepoRemovalResult,
} from "../lib/api";

// Settings → Repositories → ⋯ → Remove…: the confirmation for taking a
// repository out of the registry. Shaped like ui/confirm's alert (same title
// and consequence treatment, focus parked on Cancel, a solid red commit) but
// with the parts a plain confirm can't hold: the opt-in to delete the
// checkout, the block while a session is running, and a failure kept inside
// the dialog instead of a toast behind it.

function sessionsSentence(preview: RepoRemovalPreview | null): string {
  const leaves = "It leaves the sidebar and the new-session pickers";
  if (!preview) return `${leaves}, and its sessions are archived.`;
  if (preview.sessions === 0) return `${leaves}.`;
  return preview.sessions === 1
    ? `${leaves}, and its 1 session is archived.`
    : `${leaves}, and its ${preview.sessions} sessions are archived.`;
}

/** "Stop 2 running sessions first", the line that explains a disabled Remove. */
export function runningLine(running: number): string {
  return `Stop ${running} running ${running === 1 ? "session" : "sessions"} first`;
}

/** What deleting would take: its size and worktrees, as far as is known. */
function deleteSummary(preview: RepoRemovalPreview): string | null {
  const parts: string[] = [];
  if (typeof preview.sizeBytes === "number")
    parts.push(formatBytes(preview.sizeBytes));
  if (preview.worktrees)
    parts.push(
      preview.worktrees === 1 ? "1 worktree" : `${preview.worktrees} worktrees`,
    );
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The dialog's body below the title: the delete-files opt-in and whatever
 * stands in the way. Split out so it renders without the portal around it.
 */
export function RemoveRepoBody({
  path,
  preview,
  loadError,
  onRetry,
  deleteFiles,
  onDeleteFilesChange,
  disabled,
  error,
}: {
  path: string;
  preview: RepoRemovalPreview | null;
  loadError: string | null;
  onRetry: () => void;
  deleteFiles: boolean;
  onDeleteFilesChange: (next: boolean) => void;
  disabled: boolean;
  error: string | null;
}) {
  const detailId = useId();
  const canDelete = !!preview?.deletable;
  const summary = preview?.deletable ? deleteSummary(preview) : null;
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
            checked={deleteFiles && canDelete}
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
          <div className="truncate font-mono text-meta text-dim" title={path}>
            {path}
          </div>
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
      {loadError && <InlineAlert onRetry={onRetry}>{loadError}</InlineAlert>}
      {preview && preview.running > 0 && (
        <InlineAlert variant="info">{runningLine(preview.running)}</InlineAlert>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}
    </div>
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
  onRemoved: (result: RepoRemovalResult) => void | Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<RepoRemovalPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);

  // Fresh every time it opens: a session may have started or stopped since.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreview(null);
    setLoadError(null);
    setError(null);
    setDeleteFiles(false);
    fetchRepoRemovalPreview(repo.id)
      .then((value) => alive && setPreview(value))
      .catch(
        (cause: unknown) =>
          alive &&
          setLoadError(errorMessage(cause, "Couldn’t check this repository")),
      );
    return () => {
      alive = false;
    };
  }, [open, repo.id, loadSeq]);

  const blocked = !preview || preview.running > 0;
  const deleting = deleteFiles && !!preview?.deletable;

  async function remove() {
    if (blocked || removing) return;
    setRemoving(true);
    setError(null);
    try {
      const result = await removeRepoApi(repo.id, deleting);
      onOpenChange(false);
      await onRemoved(result);
    } catch (cause) {
      setError(errorMessage(cause, "Couldn’t remove the repository"));
      // A session may have started since the dialog opened; show it.
      setLoadSeq((n) => n + 1);
    }
    setRemoving(false);
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (removing) return;
        onOpenChange(next);
      }}
      disablePointerDismissal={removing}
    >
      <Modal.Content
        role="alertdialog"
        widthClassName="max-w-[28rem]"
        initialFocus={cancelRef}
      >
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
          path={preview?.path ?? repo.path}
          preview={preview}
          loadError={loadError}
          onRetry={() => setLoadSeq((n) => n + 1)}
          deleteFiles={deleteFiles}
          onDeleteFilesChange={setDeleteFiles}
          disabled={removing}
          error={error}
        />
        <Modal.Footer>
          <Button
            ref={cancelRef}
            type="button"
            size="lg"
            variant="soft"
            className="phone:min-h-11 phone:flex-1"
            disabled={removing}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="lg"
            variant="danger-strong"
            className="phone:min-h-11 phone:flex-1"
            disabled={blocked || removing}
            onClick={() => void remove()}
          >
            {removing
              ? "Removing…"
              : deleting
                ? "Remove and delete files"
                : "Remove"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
