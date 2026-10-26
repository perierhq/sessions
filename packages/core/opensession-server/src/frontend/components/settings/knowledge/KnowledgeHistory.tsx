import { useState } from "react";
import useSWR, { mutate as revalidateApiResources } from "swr";
import { apiSWRKey, knowledgeKeyFilter } from "../../../lib/api-swr";
import {
  fetchKnowledgeDiff,
  fetchKnowledgeHistory,
  fetchKnowledgeItem,
  revertKnowledge,
  type KnowledgeCommit,
} from "../../../lib/api/knowledge";
import { relativeTime } from "../../../lib/api/request";
import {
  HISTORY_ACTIONS,
  HISTORY_CHEVRON,
  HISTORY_LINE,
  HISTORY_LOADING,
  HISTORY_REVERT,
  HISTORY_ROW,
  HISTORY_ROW_HEAD,
  HISTORY_SHA,
  HISTORY_SUBJECT,
  HISTORY_TOGGLE,
} from "../../../lib/knowledge-history-classes";
import { commitByline, revertCopy } from "../../../lib/knowledge/history";
import {
  knowledgeAlert,
  knowledgeErrorMessage,
} from "../../../lib/knowledge/models";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { useConfirm } from "../../../ui/confirm";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsHeader,
} from "../../../ui/settings";
import { EmptyState, InlineAlert, LoadingState } from "../../../ui/state";
import { toast } from "../../../ui/toast";
import { IconChevronRight } from "../../icons";
import { CommitDiff } from "../CommitDiff";

/**
 * One knowledge item's history (`path`; the whole repository's without
 * one): every commit that touched it, newest first, each opening onto its
 * diff and offering Revert behind a confirm.
 */
export function KnowledgeHistory({
  project,
  path,
}: {
  project: string;
  path?: string;
}) {
  // The item's title for the header; the same read the editor made.
  const item = useSWR(
    path ? apiSWRKey.knowledgeItem(project, path) : null,
    () => fetchKnowledgeItem(project, path ?? ""),
  );
  const history = useSWR(apiSWRKey.knowledgeHistory(project, path), () =>
    fetchKnowledgeHistory(project, { path }),
  );
  const title = item.data?.item.title;
  const header = (
    <SettingsHeader
      title="History"
      description={path ? (title ?? path) : "Every change to this knowledge"}
    />
  );
  if (history.error && !history.data)
    return (
      <>
        {header}
        <InlineAlert
          {...knowledgeAlert(
            history.error,
            "Couldn't load the history",
            () => void history.mutate(),
          )}
        />
      </>
    );
  if (!history.data)
    return (
      <>
        {header}
        <SettingCardSkeleton rows={4} />
      </>
    );
  if (!history.data.length)
    return (
      <>
        {header}
        <EmptyState placement="card">No changes yet</EmptyState>
      </>
    );
  return (
    <>
      {header}
      <SettingCard>
        {history.data.map((commit) => (
          <KnowledgeHistoryRow
            key={commit.sha}
            project={project}
            path={path}
            commit={commit}
            // A revert moves the item, its lists and this history.
            onReverted={() =>
              void revalidateApiResources(knowledgeKeyFilter(project))
            }
          />
        ))}
      </SettingCard>
    </>
  );
}

/** One commit: subject, who and when, its diff on demand, and Revert. */
export function KnowledgeHistoryRow({
  project,
  path,
  commit,
  onReverted,
}: {
  project: string;
  path?: string;
  commit: KnowledgeCommit;
  onReverted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  async function loadDiff() {
    setFailure(null);
    try {
      setDiff(await fetchKnowledgeDiff(project, commit.sha));
    } catch (error) {
      setOpen(false);
      setFailure(knowledgeErrorMessage(error, "Couldn't load the change"));
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && diff === null) void loadDiff();
  }

  async function revert() {
    setBusy(true);
    setFailure(null);
    try {
      await revertKnowledge(project, commit.sha);
      toast("Change reverted", { variant: "success" });
      onReverted();
    } catch (error) {
      // A 409 says later changes touched the same lines.
      setFailure(knowledgeErrorMessage(error, "Couldn't revert the change"));
    }
    setBusy(false);
  }

  return (
    <div className={HISTORY_ROW}>
      <div className={HISTORY_ROW_HEAD}>
        <Button
          variant="ghost"
          aria-expanded={open}
          className={HISTORY_TOGGLE}
          onClick={toggle}
        >
          <IconChevronRight
            size={14}
            className={cn(HISTORY_CHEVRON, open && "rotate-90")}
          />
          <span className="min-w-0 flex-1">
            <span className={HISTORY_SUBJECT}>{commit.subject}</span>
            <span className={HISTORY_LINE}>
              {commitByline(commit)} ·{" "}
              <time dateTime={commit.date}>{relativeTime(commit.date)}</time>
              {" · "}
              <span className={HISTORY_SHA}>{commit.sha.slice(0, 8)}</span>
            </span>
          </span>
        </Button>
        <div className={HISTORY_ACTIONS}>
          <Button
            size="sm"
            variant="default"
            className={HISTORY_REVERT}
            disabled={busy}
            onClick={() =>
              confirm({
                ...revertCopy(commit, path),
                confirmLabel: "Revert",
                onConfirm: () => void revert(),
              })
            }
          >
            Revert
          </Button>
        </div>
      </div>
      {failure && <InlineAlert>{failure}</InlineAlert>}
      {open &&
        (diff === null ? (
          <LoadingState placement="row" className={HISTORY_LOADING}>
            Loading the change
          </LoadingState>
        ) : (
          <CommitDiff diff={diff} path={path} />
        ))}
      {confirmDialog}
    </div>
  );
}
