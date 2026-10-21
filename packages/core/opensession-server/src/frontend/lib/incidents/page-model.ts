// What the incident page shows above the next action: the dot, headline and
// facts, the strip's title, live line and future markers, how each lane is
// drawn, and which agent sessions belong to the incident. Pure.
import type { RedactedProjectSettings } from "../../../shared/incident-response";
import {
  type Incident,
  isOpenIncident,
  type SignalState,
  type SignalView,
  type StripLane,
  type StripResponse,
  stripIntervalMs,
} from "../../../shared/incidents";
import { clockTime } from "../time";
import { incidentFacts, incidentHeadline } from "./copy";
import {
  everyPhrase,
  formatSignalValue,
  laneKindFor,
  signalCaption,
} from "./signal-summary";
import {
  liveLineText,
  type StripLaneMeta,
  type StripLiveLine,
} from "./strip-layout";
import { type DotTone, incidentDot, signalDotTone } from "./tone";

export interface IncidentPageModel {
  dot: { tone: DotTone; pulse: boolean };
  headline: string;
  facts: string[];
  stripTitle: string;
  liveLine: StripLiveLine | null;
  future: Array<{ at: string; label: string }>;
  laneMeta: (lane: StripLane) => StripLaneMeta;
  primaryName: string;
  primaryState: SignalState | null;
  agentSessionIds: string[];
}

function laneMetaFor(
  signals: SignalView[],
): (lane: StripLane) => StripLaneMeta {
  return (lane) => {
    const signal = signals.find((s) => s.id === lane.signalId);
    if (!signal) return { kind: "passfail", label: lane.label, format: String };
    const meta: StripLaneMeta = {
      kind: laneKindFor(signal),
      label: lane.label,
      format: (value) => formatSignalValue(signal, value),
    };
    const rule = signal.rule;
    if (rule.kind === "threshold") meta.threshold = rule.above;
    if (rule.kind === "deadline") {
      meta.warnDays = rule.warnDays;
      meta.failDays = rule.failDays;
    }
    return meta;
  };
}

export function pageModel(input: {
  incident: Incident;
  signals: SignalView[];
  settings: RedactedProjectSettings | null;
  /** The incident's strip, for the next run time; absent while loading. */
  strip?: StripResponse;
  now: number;
}): IncidentPageModel {
  const { incident, signals, now } = input;
  const primary =
    signals.find((s) => s.id === incident.primarySignalId) ?? null;
  const primaryState = primary?.evaluation?.state ?? null;
  const primaryName = primary?.name ?? incident.title;
  const own = incident.signalIds.flatMap((id) => {
    const signal = signals.find((s) => s.id === id);
    return signal ? [signal] : [];
  });
  const open = isOpenIncident(incident);

  const headline = incidentHeadline({
    title: primaryName,
    state: incident.state,
    primary: primaryState,
    reason: primary?.evaluation?.reason,
  });
  const facts = incidentFacts({
    incident,
    sources: own.map((s) => s.name),
    now,
  });

  let stripTitle = primaryName;
  if (own.length === 1)
    stripTitle = `${own[0]!.name} · ${signalCaption(own[0]!)}`;
  else if (own.length > 1)
    stripTitle = `${own.length} signals · ${everyPhrase(Math.min(...own.map(stripIntervalMs)))}`;

  let liveLine: StripLiveLine | null = null;
  if (!open && incident.closedAt)
    liveLine = { tone: "faint", text: `Ended ${clockTime(incident.closedAt)}` };
  else if (open && primary) {
    liveLine = {
      tone: signalDotTone(primaryState ?? "unknown"),
      text: liveLineText({
        kind: primary.source.kind,
        nextRunAt: input.strip?.nextRunAt,
        strip: input.strip,
        lastCheckIn:
          primary.evaluation?.lastObservationAt ?? primary.lastObservation?.at,
        now,
      }),
    };
    if (input.strip?.nextRunAt) liveLine.nextRunAt = input.strip.nextRunAt;
  }

  const future: Array<{ at: string; label: string }> = [];
  const response = incident.response;
  if (open && response) {
    const ahead = (at: string) => Date.parse(at) > now;
    if (response.veto && ahead(response.veto.deadline))
      future.push({
        at: response.veto.deadline,
        label: response.candidate?.rollbackFirst ? "Rolls back" : "Deploys",
      });
    if (response.watch && ahead(response.watch.deadline))
      future.push({ at: response.watch.deadline, label: "Closes" });
  }

  return {
    dot: incidentDot(incident, primaryState),
    headline,
    facts,
    stripTitle,
    liveLine,
    future,
    laneMeta: laneMetaFor(signals),
    primaryName,
    primaryState,
    agentSessionIds: (response?.agents ?? [])
      .filter((run) => run.status === "running" || run.status === "waiting")
      .map((run) => run.sessionId),
  };
}
