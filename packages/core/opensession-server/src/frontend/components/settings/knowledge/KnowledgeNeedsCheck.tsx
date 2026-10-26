import { useState } from "react";
import useSWR, { mutate as revalidateApiResources } from "swr";
import type { KnowledgeItem } from "../../../../shared/knowledge";
import { apiSWRKey, knowledgeKeyFilter } from "../../../lib/api-swr";
import {
  confirmKnowledge,
  fetchKnowledgeItem,
  fetchNeedsCheck,
  fetchNeedsCheckChange,
  retireKnowledge,
  revalidateKnowledge,
  type KnowledgeRevalidateResult,
} from "../../../lib/api/knowledge";
import type { KnowledgeRoute } from "../../../lib/app-route";
import { errorMessage } from "../../../lib/error-message";
import {
  NC_ACTION,
  NC_ACTIONS,
  NC_BACK,
  NC_FIRST_GROUP,
  NC_HEAD,
  NC_LINK,
  NC_MISSING,
  NC_PANE,
  NC_PANE_BODY,
  NC_PANE_LABEL,
  NC_PANE_TEXT,
  NC_PANE_TEXT_ALONE,
  NC_PANES,
  NC_PATCH_LINE,
  NC_REASON,
  NC_ROW,
  NC_SWITCH,
  NC_TAP,
  NC_TITLE,
  NC_TOOLBAR,
} from "../../../lib/knowledge-needs-check-classes";
import {
  KNOWLEDGE_ROW_HEAD,
  KNOWLEDGE_ROW_LINE,
  KNOWLEDGE_ROW_TITLE,
} from "../../../lib/knowledge-classes";
import { emptyCopy } from "../../../lib/knowledge/models";
import {
  changePane,
  checkNowLine,
  confirmGroupRequest,
  groupByReason,
  rowBadges,
  rowLine,
  type PaneSide,
} from "../../../lib/knowledge/needs-check-model";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { useConfirm } from "../../../ui/confirm";
import { PlainButton } from "../../../ui/plain-button";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
} from "../../../ui/settings";
import { EmptyState, InlineAlert } from "../../../ui/state";
import { toast } from "../../../ui/toast";
import { IconCheck, IconChevronLeft } from "../../icons";
import { KnowledgeEditor } from "./KnowledgeEditor";

/**
 * The Needs check tab: what needs a person's eyes, grouped by the change
 * that caused it, or one item beside that change when `path` is set.
 */
export function KnowledgeNeedsCheck({
  project,
  path,
  onNavigate,
}: {
  project: string;
  /** The item open beside its change; the queue when absent. */
  path?: string;
  onNavigate: (route: KnowledgeRoute) => void;
}) {
  const list = useSWR(apiSWRKey.knowledgeNeedsCheck(project), () =>
    fetchNeedsCheck(project),
  );
  if (path)
    return (
      <NeedsCheckItem
        key={path}
        project={project}
        path={path}
        queue={list.data ?? []}
        onNavigate={onNavigate}
      />
    );
  return (
    <NeedsCheckQueue
      project={project}
      items={list.data}
      error={list.error}
      onRetry={() => void list.mutate()}
      onOpen={(p) => onNavigate({ tab: "needs-check", path: p })}
    />
  );
}

function refresh(project: string) {
  return revalidateApiResources(knowledgeKeyFilter(project));
}

function NeedsCheckQueue({
  project,
  items,
  error,
  onRetry,
  onOpen,
}: {
  project: string;
  items: KnowledgeItem[] | undefined;
  error: unknown;
  onRetry: () => void;
  onOpen: (path: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [ask, confirmDialog] = useConfirm();

  async function checkNow() {
    setChecking(true);
    let result: KnowledgeRevalidateResult;
    try {
      result = await revalidateKnowledge(project);
    } catch (failure) {
      setChecking(false);
      toast(errorMessage(failure, "Couldn't check the knowledge"), {
        variant: "error",
      });
      return;
    }
    setChecking(false);
    const { text, failed } = checkNowLine(result);
    toast(text, { variant: failed ? "error" : "success" });
    void refresh(project);
  }

  const toolbar = (
    <div className={NC_TOOLBAR}>
      <Button
        type="button"
        className={NC_TAP}
        disabled={checking}
        onClick={() => void checkNow()}
      >
        {checking ? "Checking…" : "Check now"}
      </Button>
    </div>
  );

  if (error && !items)
    return (
      <>
        {toolbar}
        <InlineAlert onRetry={onRetry}>
          {errorMessage(error, "Couldn't load what needs a check")}
        </InlineAlert>
      </>
    );
  if (!items)
    return (
      <>
        {toolbar}
        <SettingCardSkeleton rows={4} />
      </>
    );
  if (!items.length)
    return (
      <>
        {toolbar}
        <EmptyState placement="card">{emptyCopy("needs-check")}</EmptyState>
      </>
    );

  return (
    <>
      {toolbar}
      {groupByReason(items).map((group, index) => {
        const request = confirmGroupRequest(project, group, confirmKnowledge);
        const confirmAll = () =>
          ask({
            ...request,
            onConfirm: () => {
              setConfirming(group.key);
              request
                .onConfirm()
                .then(() => {
                  toast(`Marked ${group.items.length} still true`, {
                    variant: "success",
                  });
                  return refresh(project);
                })
                .catch((failure: Error) =>
                  toast(errorMessage(failure, "Couldn't confirm"), {
                    variant: "error",
                  }),
                )
                .finally(() => setConfirming(null));
            },
          });
        return (
          <section key={group.key} aria-label={group.reason}>
            <SettingsGroupLabel
              className={cn(index === 0 && NC_FIRST_GROUP)}
              actions={
                group.items.length > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    className={NC_TAP}
                    disabled={confirming === group.key}
                    onClick={confirmAll}
                  >
                    {request.confirmLabel}
                  </Button>
                ) : null
              }
            >
              {group.line}
            </SettingsGroupLabel>
            <SettingCard>
              {group.items.map((item) => (
                <PlainButton
                  key={item.path}
                  className={NC_ROW}
                  onClick={() => onOpen(item.path)}
                >
                  <span className={KNOWLEDGE_ROW_HEAD}>
                    <span className={KNOWLEDGE_ROW_TITLE}>{item.title}</span>
                    {rowBadges(item).map((badge) => (
                      <Badge key={badge.label} tone={badge.tone}>
                        {badge.label}
                      </Badge>
                    ))}
                  </span>
                  <span className={KNOWLEDGE_ROW_LINE}>{rowLine(item)}</span>
                </PlainButton>
              ))}
            </SettingCard>
          </section>
        );
      })}
      {confirmDialog}
    </>
  );
}

type Side = "article" | "change";

function NeedsCheckItem({
  project,
  path,
  queue,
  onNavigate,
}: {
  project: string;
  path: string;
  /** The queue as last loaded, for where to go once this one is done. */
  queue: KnowledgeItem[];
  onNavigate: (route: KnowledgeRoute) => void;
}) {
  const read = useSWR(apiSWRKey.knowledgeNeedsCheckChange(project, path), () =>
    fetchNeedsCheckChange(project, path),
  );
  const [side, setSide] = useState<Side>("article");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"confirm" | "retire" | null>(null);

  const queued = new Set(queue.map((i) => i.path));
  // The next item in the queue's order, or the queue once this was the last.
  const next = () => {
    const order = groupByReason(queue).flatMap((g) => g.items);
    const at = order.findIndex((i) => i.path === path);
    const after = order[at + 1] ?? order[at - 1];
    onNavigate(
      after && after.path !== path
        ? { tab: "needs-check", path: after.path }
        : { tab: "needs-check" },
    );
  };

  async function act(kind: "confirm" | "retire") {
    setBusy(kind);
    try {
      if (kind === "confirm") await confirmKnowledge(project, [path]);
      else await retireKnowledge(project, [path]);
    } catch (failure) {
      setBusy(null);
      toast(
        errorMessage(
          failure,
          kind === "confirm" ? "Couldn't confirm" : "Couldn't retire",
        ),
        { variant: "error" },
      );
      void read.mutate();
      return;
    }
    setBusy(null);
    toast(kind === "confirm" ? "Marked still true" : "Retired", {
      variant: "success",
    });
    void refresh(project);
    next();
  }

  // Saving the editor confirms the item: the person has just read it
  // against the change. An item saved as retired stays retired.
  async function saved(savedPath: string) {
    try {
      const after = await fetchKnowledgeItem(project, savedPath);
      if (after.item.status !== "retired")
        await confirmKnowledge(project, [savedPath]);
    } catch (failure) {
      toast(
        `Saved, but not marked still true: ${errorMessage(failure, "try Still true again")}`,
        { variant: "error" },
      );
      setEditing(false);
      void read.mutate();
      return;
    }
    void refresh(project);
    next();
  }

  const back = (
    <div className={NC_BACK}>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={NC_TAP}
        icon={<IconChevronLeft size={18} />}
        onClick={() =>
          editing ? setEditing(false) : onNavigate({ tab: "needs-check" })
        }
      >
        {editing ? "What changed" : "Needs check"}
      </Button>
    </div>
  );

  if (editing)
    return (
      <>
        {back}
        <KnowledgeEditor
          project={project}
          path={path}
          onSaved={(p) => void saved(p)}
          onHistory={(p) => onNavigate({ tab: "history", path: p })}
        />
      </>
    );

  if (read.error && !read.data)
    return (
      <>
        {back}
        <InlineAlert onRetry={() => void read.mutate()}>
          {errorMessage(read.error, "Couldn't load what changed")}
        </InlineAlert>
      </>
    );
  if (!read.data)
    return (
      <>
        {back}
        <SettingCardSkeleton rows={6} />
      </>
    );

  const { item, body, change } = read.data;
  const pane = changePane(change, body);
  const openLink = (link: string) =>
    onNavigate(
      queued.has(link)
        ? { tab: "needs-check", path: link }
        : { tab: "articles", path: link },
    );

  return (
    <>
      {back}
      <div className={NC_HEAD}>
        <h2 className={NC_TITLE}>{item.title}</h2>
        <p className={NC_REASON}>{pane.title}</p>
      </div>
      <div className={NC_ACTIONS}>
        <Button
          type="button"
          variant="primary"
          className={NC_ACTION}
          icon={<IconCheck size={18} />}
          disabled={busy !== null}
          onClick={() => void act("confirm")}
        >
          Still true
        </Button>
        <Button
          type="button"
          variant="soft"
          className={NC_ACTION}
          disabled={busy !== null}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="danger"
          className={NC_ACTION}
          disabled={busy !== null}
          onClick={() => void act("retire")}
        >
          Retire
        </Button>
      </div>
      <div className={NC_SWITCH}>
        <Segmented
          label="Show"
          value={side}
          onValueChange={(value) =>
            setSide(value === "change" ? "change" : "article")
          }
          className="flex w-full"
        >
          <SegmentedOption value="article" className="flex-1 min-h-11">
            Article
          </SegmentedOption>
          <SegmentedOption value="change" className="flex-1 min-h-11">
            What changed
          </SegmentedOption>
        </Segmented>
      </div>
      <div className={NC_PANES}>
        <Pane
          side={{ label: pane.left.label, text: pane.left.text }}
          hidden={side !== "article"}
          switchLabel="Article"
        />
        <Pane
          side={pane.right}
          hidden={side !== "change"}
          switchLabel="What changed"
          onOpen={change.kind === "conflict" ? openLink : undefined}
        />
      </div>
    </>
  );
}

/** One side of the comparison. On a phone only the chosen side shows. */
function Pane({
  side,
  hidden,
  switchLabel,
  onOpen,
}: {
  side: PaneSide;
  hidden: boolean;
  /** What the phone's switch calls this side; a label that only repeats
   *  it is left out there. */
  switchLabel: string;
  /** Opens `side.link` in the app (another article); without it a link is
   *  a web address. */
  onOpen?: (link: string) => void;
}) {
  const link = side.link;
  const labelAlone = side.label === switchLabel && !link;
  return (
    <SettingCard className={cn(NC_PANE, hidden && "phone:hidden")}>
      <div className={NC_PANE_BODY}>
        <div className={cn(NC_PANE_LABEL, labelAlone && "phone:hidden")}>
          <span className="shrink-0">{side.label}</span>
          {link && onOpen ? (
            <PlainButton className={NC_LINK} onClick={() => onOpen(link)}>
              {link}
            </PlainButton>
          ) : link ? (
            <a
              className={NC_LINK}
              href={link}
              target="_blank"
              rel="noreferrer noopener"
            >
              {link}
            </a>
          ) : null}
        </div>
        <pre
          className={cn(
            NC_PANE_TEXT,
            labelAlone && NC_PANE_TEXT_ALONE,
            side.missing && NC_MISSING,
          )}
        >
          {side.patchLines
            ? side.patchLines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    NC_PATCH_LINE,
                    line.tone === "add" && "text-green",
                    line.tone === "remove" && "text-red",
                    line.tone === "meta" && "text-dim",
                  )}
                >
                  {line.text || " "}
                </div>
              ))
            : side.text}
        </pre>
      </div>
    </SettingCard>
  );
}
