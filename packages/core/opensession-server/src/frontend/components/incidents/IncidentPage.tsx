import { useEffect } from "react";
import type {
  OwnerDecision,
  RedactedProjectSettings,
} from "../../../shared/incident-response";
import {
  type Incident,
  type IncidentSummary,
  isOpenIncident,
  type StripResponse,
} from "../../../shared/incidents";
import {
  useIncident,
  useIncidents,
  useIncidentStrip,
  useProjectSettings,
  useSignals,
} from "../../hooks/useIncidents";
import { isSeamMissing } from "../../lib/api/incidents";
import type { Route } from "../../lib/app-route";
import { DEFAULT_DOC_TITLE, docTitle } from "../../lib/brand";
import { causeOf } from "../../lib/incidents/cause";
import type { DetailTarget } from "../../lib/incidents/details";
import { earlierIncidents } from "../../lib/incidents/details";
import {
  type IncidentPageModel,
  pageModel,
} from "../../lib/incidents/page-model";
import { proofLane } from "../../lib/incidents/strip-layout";
import { watchIncidentNotifications } from "../../lib/notifications";
import {
  INCIDENT_COLUMN,
  INCIDENT_PAGE,
  INCIDENT_PHONE_TOPBAR,
  INCIDENT_PLATE_SKELETON,
  INCIDENT_SCROLL,
  INCIDENT_SECTIONS,
  INCIDENT_STRIP_ERROR,
  INCIDENT_TOPBAR,
  STATUS_LINE_DOT_SLOT,
} from "../../lib/incident-classes";
import { repoLabel } from "../../lib/repo-label";
import type { SessionSafetyState, UnifiedSession } from "../../lib/types";
import { Button } from "../../ui/button";
import {
  EmptyState,
  InlineAlert,
  ListSkeleton,
  Skeleton,
  SkeletonBar,
} from "../../ui/state";
import {
  PhoneTopBar,
  PhoneTopBarAction,
  PhoneTopBarTitle,
  TopBar,
  TopBarTitle,
} from "../../ui/top-bar";
import { IconChevronLeft, IconChevronRight } from "../icons";
import { RepoTile } from "../RepoTile";
import { IncidentCause } from "./IncidentCause";
import { IncidentDetails } from "./IncidentDetails";
import { NextAction } from "./NextAction";
import { SignalStrip } from "./SignalStrip";
import { StatusLine } from "./StatusLine";

type PrTarget = Extract<DetailTarget, { kind: "pr" }>;

export type IncidentPageBody =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; onRetry: () => void }
  | {
      kind: "ready";
      incident: Incident;
      model: IncidentPageModel;
      strip: StripResponse | undefined;
      onRetryStrip: (() => void) | null;
      earlier: IncidentSummary[];
      settings: RedactedProjectSettings | null;
      safety?: { sessionId: string; state: SessionSafetyState };
      intent?: OwnerDecision;
    };

export interface IncidentPageActions {
  onBack: () => void;
  onOpenAll: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenPr: (target: PrTarget) => void;
  onOpenIncident: (id: string) => void;
  onOpenSettings: (project: string) => void;
  onIntentHandled: () => void;
}

function PageSkeleton() {
  return (
    <Skeleton label="Loading the incident" className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className={STATUS_LINE_DOT_SLOT}>
            <span className="size-3 rounded-full bg-hover" />
          </span>
          <SkeletonBar className="h-7 w-[60%]" />
        </div>
        <SkeletonBar className="ml-6 h-3.5 w-[80%]" />
      </div>
      <SignalStrip
        strip={undefined}
        meta={() => ({ kind: "passfail", label: "", format: String })}
        live={false}
        title=""
        liveLine={null}
      />
      <div className={INCIDENT_PLATE_SKELETON} />
      <ListSkeleton variant="bare" rows={5} />
    </Skeleton>
  );
}

function Sections({
  body,
  actions,
}: {
  body: Extract<IncidentPageBody, { kind: "ready" }>;
  actions: IncidentPageActions;
}) {
  const { incident, model, strip } = body;
  const response = incident.response;
  const verification = strip ? proofLane(response?.proof, strip) : null;
  return (
    <>
      <StatusLine
        tone={model.dot.tone}
        pulse={model.dot.pulse}
        headline={model.headline}
        facts={model.facts}
        level="page"
      />
      {body.onRetryStrip ? (
        <div className={INCIDENT_STRIP_ERROR}>
          <InlineAlert onRetry={body.onRetryStrip}>
            Couldn't load the strip
          </InlineAlert>
        </div>
      ) : (
        <SignalStrip
          strip={strip}
          meta={model.laneMeta}
          verification={verification ? [verification] : undefined}
          future={model.future}
          live={isOpenIncident(incident)}
          title={model.stripTitle}
          liveLine={model.liveLine}
        />
      )}
      {response && (
        <NextAction
          incident={incident}
          settings={body.settings}
          primaryName={model.primaryName}
          agentSessionIds={model.agentSessionIds}
          safety={body.safety}
          onOpenSession={actions.onOpenSession}
          intent={body.intent}
          onIntentHandled={actions.onIntentHandled}
        />
      )}
      <IncidentCause
        cause={causeOf(response)}
        waiting={!!response && isOpenIncident(incident)}
      />
      <IncidentDetails
        incident={incident}
        earlier={body.earlier}
        budgetUsd={body.settings?.budget.perIncidentUsd ?? null}
        onOpenSession={actions.onOpenSession}
        onOpenPr={actions.onOpenPr}
        onOpenIncident={actions.onOpenIncident}
        onOpenSettings={actions.onOpenSettings}
      />
    </>
  );
}

/**
 * The incident page (spec 4.1): status line, signal strip, next action,
 * cause and summary rows in one column under the page's own bar.
 * Presentational over `body`; the containers inside load their own extras.
 */
export function IncidentPageView({
  project,
  title,
  body,
  actions,
}: {
  project: string | null;
  title: string;
  body: IncidentPageBody;
  actions: IncidentPageActions;
}) {
  const label = project ? repoLabel(project) : "Incidents";
  let content: React.ReactNode;
  if (body.kind === "loading") content = <PageSkeleton />;
  else if (body.kind === "missing")
    content = (
      <EmptyState
        title="This incident does not exist"
        action={
          <Button size="sm" onClick={actions.onOpenAll}>
            All incidents
          </Button>
        }
      />
    );
  else if (body.kind === "error")
    content = (
      <InlineAlert onRetry={body.onRetry}>
        Couldn't load this incident
      </InlineAlert>
    );
  else content = <Sections body={body} actions={actions} />;

  return (
    <div className={INCIDENT_PAGE}>
      <TopBar as="header" className={INCIDENT_TOPBAR}>
        {project && <RepoTile name={project} />}
        <span className="shrink-0">{label}</span>
        {title && (
          <>
            <IconChevronRight size={16} dense className="shrink-0 text-faint" />
            <TopBarTitle className="truncate">{title}</TopBarTitle>
          </>
        )}
      </TopBar>
      <PhoneTopBar className={INCIDENT_PHONE_TOPBAR}>
        <PhoneTopBarAction
          className="absolute left-3"
          onClick={actions.onBack}
          title="Incidents"
          aria-label="Incidents"
          icon={<IconChevronLeft size={24} />}
        />
        <PhoneTopBarTitle className="max-w-[60%] truncate">
          {label}
        </PhoneTopBarTitle>
      </PhoneTopBar>
      <div className={INCIDENT_SCROLL}>
        <div className={INCIDENT_COLUMN}>
          <div className={INCIDENT_SECTIONS}>{content}</div>
        </div>
      </div>
    </div>
  );
}

/** The incident page with its data, mounted by the router. */
export function IncidentPage({
  id,
  intent,
  sessions,
  onBack,
  navigate,
}: {
  id: string;
  intent?: OwnerDecision;
  sessions: UnifiedSession[];
  onBack: () => void;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}) {
  const incident = useIncident(id);
  const signals = useSignals();
  const strip = useIncidentStrip(id);
  const data = incident.data;
  const project = data?.project ?? null;
  // Earlier incidents are the project's: wait for the project rather than
  // load every closed incident first.
  const closed = useIncidents(project ? { status: "closed", project } : null);
  const settings = useProjectSettings(project).data?.settings ?? null;
  const now = Date.now();
  const model = data
    ? pageModel({
        incident: data,
        signals: signals.data ?? [],
        settings,
        strip: strip.data,
        now,
      })
    : null;

  // Its inbox row is read while the page is on screen, on every device.
  useEffect(() => watchIncidentNotifications(id), [id]);

  const headline = model?.headline;
  useEffect(() => {
    if (!headline) return;
    document.title = docTitle(`${headline} · Incidents`);
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [headline]);

  const agentIds = new Set(data?.response?.agents.map((r) => r.sessionId));
  const safe = sessions.find((s) => agentIds.has(s.id) && s.safety);

  const actions: IncidentPageActions = {
    onBack,
    onOpenAll: () => navigate({ view: "incidents" }),
    onOpenSession: (sessionId) => navigate({ view: "session", id: sessionId }),
    onOpenPr: (target) => {
      if (target.branch)
        navigate({ view: "pr", repo: target.repo, branch: target.branch });
      else navigate({ view: "pr", repo: target.repo, number: target.number });
    },
    onOpenIncident: (other) => navigate({ view: "incidents", id: other }),
    onOpenSettings: (name) =>
      navigate({ view: "incidentSettings", project: name }),
    onIntentHandled: () =>
      navigate({ view: "incidents", id }, { replace: true }),
  };

  let body: IncidentPageBody;
  if (data && model) {
    const ready: IncidentPageBody = {
      kind: "ready",
      incident: data,
      model,
      strip: strip.data,
      onRetryStrip:
        strip.error && !strip.data ? () => void strip.mutate() : null,
      earlier: earlierIncidents(closed.data ?? [], data),
      settings,
      intent,
    };
    if (safe?.safety) ready.safety = { sessionId: safe.id, state: safe.safety };
    body = ready;
  } else if (incident.error && isSeamMissing(incident.error))
    body = { kind: "missing" };
  else if (incident.error)
    body = { kind: "error", onRetry: () => void incident.mutate() };
  else body = { kind: "loading" };

  return (
    <IncidentPageView
      project={project}
      title={data?.title ?? ""}
      body={body}
      actions={actions}
    />
  );
}
