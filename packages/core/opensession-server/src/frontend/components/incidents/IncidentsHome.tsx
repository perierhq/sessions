import { useEffect, useState } from "react";
import useSWR from "swr";
import type { IncidentSummary, SignalView } from "../../../shared/incidents";
import { useElementWidth } from "../../hooks/useElementWidth";
import {
  useIncidents,
  useProjectSettings,
  useSignals,
  useSignalStrip,
} from "../../hooks/useIncidents";
import { fetchRepos } from "../../lib/api/repos";
import { DEFAULT_DOC_TITLE, docTitle } from "../../lib/brand";
import { homeSummary } from "../../lib/incidents/copy";
import {
  headsUps as headsUpsOf,
  pastIncidents,
  signalTarget,
} from "../../lib/incidents/home";
import {
  laneKindFor,
  latestValue,
  miniRange,
  signalCaption,
  sortSignals,
} from "../../lib/incidents/signal-summary";
import { incidentStateWord } from "../../lib/incidents/tone";
import {
  HOME_HEADS_UP_ROW,
  HOME_LIST,
  HOME_MINI,
  HOME_ROW_CAPTION,
  HOME_ROW_NAME,
  HOME_ROW_VALUE,
  HOME_SIGNAL_ROW,
  INCIDENT_COLUMN,
  INCIDENT_PAGE,
  INCIDENT_SCROLL,
  INCIDENT_SECTION_LABEL,
  INCIDENT_SECTIONS,
  STATUS_LINE_DOT_SLOT,
} from "../../lib/incident-classes";
import { repoLabel } from "../../lib/repo-label";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import {
  EmptyState,
  InlineAlert,
  ListSkeleton,
  Skeleton,
  SkeletonBar,
} from "../../ui/state";
import { IconOctagonAlert } from "../icons";
import { RepoTile } from "../RepoTile";
import { SignalEditor } from "../settings/incidents/SignalEditor";
import { MiniSignal } from "./MiniSignal";
import { PastIncidents } from "./PastIncidents";
import { StatusLine } from "./StatusLine";

const MINUTE_MS = 60_000;

const VALUE_TONE = {
  fg: "text-fg",
  yellow: "text-yellow",
  red: "text-red",
  faint: "text-faint",
} as const;

export type HomeSignals =
  | { kind: "loading" }
  | { kind: "error"; onRetry: () => void }
  | { kind: "ready"; signals: SignalView[] };

/** One signal: tile, name over caption, mini signal, latest value. The
 *  whole row opens its open incident, or its editor. */
function SignalRow({
  signal,
  now,
  onOpen,
}: {
  signal: SignalView;
  now: number;
  onOpen: (signal: SignalView) => void;
}) {
  // The range moves once a minute, so its key does too.
  const edge = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const strip = useSignalStrip(signal.id, miniRange(signal, edge)).data;
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const value = latestValue(signal, strip, now);
  return (
    <button
      type="button"
      className={HOME_SIGNAL_ROW}
      onClick={() => onOpen(signal)}
    >
      <span className="[grid-area:tile]">
        <RepoTile name={signal.project} />
      </span>
      <span className="flex min-w-0 flex-col [grid-area:text]">
        <span className={HOME_ROW_NAME}>{signal.name}</span>
        <span className={HOME_ROW_CAPTION}>{signalCaption(signal)}</span>
      </span>
      {/* An expiry signal draws no bars: its desktop box stays for the
          column, its phone line goes. */}
      <div
        ref={ref}
        className={cn(
          HOME_MINI,
          laneKindFor(signal) === "days" && "phone:hidden",
        )}
      >
        <MiniSignal signal={signal} strip={strip} width={width} />
      </div>
      <span className={cn(HOME_ROW_VALUE, VALUE_TONE[value.tone])}>
        {value.text}
      </span>
    </button>
  );
}

/** `Add a signal`: straight to the editor with one project, a project menu
 *  with more. */
function AddSignal({
  projects,
  onPick,
  className,
}: {
  projects: string[];
  onPick: (project: string) => void;
  className?: string;
}) {
  if (projects.length <= 1)
    return (
      <Button
        variant="soft"
        className={className}
        disabled={!projects.length}
        onClick={() => projects[0] && onPick(projects[0])}
      >
        Add a signal
      </Button>
    );
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button variant="soft" caret className={className}>
            Add a signal
          </Button>
        }
      />
      <Menu.Popup align="start" className="min-w-[200px] max-w-[320px]">
        <Menu.GroupLabel>Project</Menu.GroupLabel>
        {projects.map((name) => (
          <Menu.Item
            key={name}
            className="phone:min-h-11"
            onClick={() => onPick(name)}
          >
            <RepoTile name={name} size={18} />
            <span className="min-w-0 flex-1 truncate">{repoLabel(name)}</span>
          </Menu.Item>
        ))}
      </Menu.Popup>
    </Menu.Root>
  );
}

function StatusSkeleton() {
  return (
    <Skeleton label="Loading signals" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className={STATUS_LINE_DOT_SLOT}>
          <span className="size-3 rounded-full bg-hover" />
        </span>
        <SkeletonBar className="h-7 w-[40%]" />
      </div>
      <SkeletonBar className="ml-6 h-3.5 w-[80%]" />
    </Skeleton>
  );
}

/**
 * The incidents home (spec 4.2), top to bottom: one status line for
 * everything, open heads-ups, every signal with its mini signal and latest
 * value (problems first), and past incidents. Presentational over its data;
 * each signal row loads its own strip.
 */
export function IncidentsHomeView({
  signals,
  open,
  past,
  onRetryPast,
  projects,
  now,
  onOpenIncident,
  onEditSignal,
  onAddSignal,
}: {
  signals: HomeSignals;
  /** Open incidents; heads-ups and signal rows read them. */
  open: IncidentSummary[];
  /** Resolved incidents, newest first; null while they load. */
  past: IncidentSummary[] | null;
  /** Set when past incidents failed to load. */
  onRetryPast?: () => void;
  /** Where a new signal can go. */
  projects: string[];
  now: number;
  onOpenIncident: (id: string) => void;
  onEditSignal: (signal: SignalView) => void;
  onAddSignal: (project: string) => void;
}) {
  const ready = signals.kind === "ready" ? signals.signals : null;
  const summary = ready
    ? homeSummary({ signals: ready, lastClosed: past?.[0], now })
    : null;
  const headsUps = headsUpsOf(open);
  const openSignal = (signal: SignalView) => {
    const target = signalTarget(signal, open);
    if (target.kind === "incident") onOpenIncident(target.id);
    else onEditSignal(signal);
  };
  const reasonOf = (incident: IncidentSummary) =>
    ready?.find((s) => s.id === incident.primarySignalId)?.evaluation?.reason ??
    "";

  let list: React.ReactNode;
  if (signals.kind === "loading")
    list = <ListSkeleton variant="bare" rows={5} className="px-2" />;
  else if (signals.kind === "error")
    list = (
      <div className="px-2">
        <InlineAlert onRetry={signals.onRetry}>
          Couldn't load the signals
        </InlineAlert>
      </div>
    );
  else if (!signals.signals.length)
    list = (
      <EmptyState
        icon={<IconOctagonAlert size={22} />}
        title="No signals yet"
        action={<AddSignal projects={projects} onPick={onAddSignal} />}
      >
        A signal checks something in production and opens an incident when it
        breaks
      </EmptyState>
    );
  else
    list = (
      <>
        <div className="flex min-w-0 flex-col">
          {sortSignals(signals.signals).map((signal) => (
            <SignalRow
              key={signal.id}
              signal={signal}
              now={now}
              onOpen={openSignal}
            />
          ))}
        </div>
        <div className="px-2 pt-4">
          <AddSignal projects={projects} onPick={onAddSignal} />
        </div>
      </>
    );

  return (
    <div className={cn(INCIDENT_PAGE, INCIDENT_SCROLL)}>
      <div className={INCIDENT_COLUMN}>
        <div className={INCIDENT_SECTIONS}>
          {summary ? (
            <StatusLine
              tone={summary.tone}
              pulse={false}
              headline={summary.headline}
              facts={summary.sentence ? [summary.sentence] : []}
              level="home"
            />
          ) : (
            <StatusSkeleton />
          )}
          {headsUps.length > 0 && (
            <section className={HOME_LIST} aria-label="Heads-up">
              <h2 className={INCIDENT_SECTION_LABEL}>Heads-up</h2>
              {headsUps.map((incident) => {
                const reason = reasonOf(incident);
                return (
                  <button
                    key={incident.id}
                    type="button"
                    className={HOME_HEADS_UP_ROW}
                    onClick={() => onOpenIncident(incident.id)}
                  >
                    <RepoTile name={incident.project} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={HOME_ROW_NAME}>{incident.title}</span>
                      {reason && (
                        <span className={HOME_ROW_CAPTION}>{reason}</span>
                      )}
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-supporting text-yellow">
                      {incidentStateWord(incident).text}
                    </span>
                  </button>
                );
              })}
            </section>
          )}
          <section className={HOME_LIST} aria-label="Signals">
            <h2 className={INCIDENT_SECTION_LABEL}>Signals</h2>
            {list}
          </section>
          <section className={HOME_LIST} aria-label="Past incidents">
            <h2 className={INCIDENT_SECTION_LABEL}>Past incidents</h2>
            {onRetryPast ? (
              <div className="px-2">
                <InlineAlert onRetry={onRetryPast}>
                  Couldn't load past incidents
                </InlineAlert>
              </div>
            ) : past ? (
              <PastIncidents
                incidents={past}
                now={now}
                onOpen={onOpenIncident}
              />
            ) : (
              <ListSkeleton variant="bare" rows={3} className="px-2" />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** The signal editor for one project, with that project's bound Runners. */
function EditorHost({
  editor,
  open,
  signals,
  onClose,
  onSaved,
}: {
  editor: { key: number; project: string; signal: SignalView | null };
  open: boolean;
  signals: SignalView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const settings = useProjectSettings(editor.project);
  return (
    <SignalEditor
      key={editor.key}
      open={open}
      onClose={onClose}
      project={editor.project}
      signal={editor.signal}
      runners={(settings.data?.runners ?? []).filter((r) => r.bound)}
      signals={signals}
      onSaved={onSaved}
    />
  );
}

/** The incidents home with its data, mounted for `/incidents`. */
export function IncidentsHome({
  onOpenIncident,
}: {
  onOpenIncident: (id: string) => void;
}) {
  const signals = useSignals();
  const open = useIncidents({ status: "open" });
  const closed = useIncidents({ status: "closed" });
  const repos = useSWR(["api", "repos-for-incident-settings"], fetchRepos);
  const [editor, setEditor] = useState<{
    key: number;
    project: string;
    signal: SignalView | null;
  } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    document.title = docTitle("Incidents");
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  const openEditor = (project: string, signal: SignalView | null) => {
    setEditor({ key: (editor?.key ?? 0) + 1, project, signal });
    setEditorOpen(true);
  };

  const projects = [
    ...new Set([
      ...(repos.data ?? []).map((repo) => repo.id),
      ...(signals.data ?? []).map((signal) => signal.project),
    ]),
  ];

  let body: HomeSignals;
  if (signals.data) body = { kind: "ready", signals: signals.data };
  else if (signals.error)
    body = { kind: "error", onRetry: () => void signals.mutate() };
  else body = { kind: "loading" };

  return (
    <>
      <IncidentsHomeView
        signals={body}
        open={open.data ?? []}
        past={closed.data ? pastIncidents(closed.data) : null}
        onRetryPast={
          closed.error && !closed.data ? () => void closed.mutate() : undefined
        }
        projects={projects}
        now={Date.now()}
        onOpenIncident={onOpenIncident}
        onEditSignal={(signal) => openEditor(signal.project, signal)}
        onAddSignal={(project) => openEditor(project, null)}
      />
      {editor && (
        <EditorHost
          editor={editor}
          open={editorOpen}
          signals={signals.data ?? []}
          onClose={() => setEditorOpen(false)}
          onSaved={() => void signals.mutate()}
        />
      )}
    </>
  );
}
