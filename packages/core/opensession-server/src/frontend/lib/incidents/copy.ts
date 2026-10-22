// What the incident views say: headlines, fact lines, the home summary,
// durations and amounts. Sentence case, no trailing periods, `·` only
// between parallel fragments (the caller joins facts with it). Pure.
import type {
  FixedBy,
  Incident,
  IncidentImpact,
  IncidentState,
  IncidentSummary,
  SignalState,
  SignalView,
} from "../../../shared/incidents";
import { isTerminalIncidentState } from "../../../shared/incidents";
import { clockTime } from "../time";
import { type DotTone, SIGNAL_RANK, signalDotTone } from "./tone";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The Past incidents column (spec 4.2), exactly these words. */
export const FIXED_BY_LABEL: Record<FixedBy, string> = {
  agents: "Agents",
  "agents-with-you": "Agents with you",
  "by-hand": "By hand",
  "provider-recovered": "Provider recovered",
  recovered: "Recovered on its own",
};

/** How an incident ended, as a phrase that reads after "was" or alone. */
const FIXED_BY_PHRASE: Record<FixedBy, string> = {
  agents: "fixed by the agents",
  "agents-with-you": "fixed by the agents with you",
  "by-hand": "fixed by hand",
  "provider-recovered": "resolved when the provider recovered",
  recovered: "recovered on its own",
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "50 min", "26 h" ("1 h 32 min" precise), "3 days". */
export function formatSpan(ms: number, precise = false): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  if (ms < 48 * HOUR_MS) {
    if (!precise) return `${Math.round(ms / HOUR_MS)} h`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return plural(Math.round(ms / DAY_MS), "day");
}

/** "$3.80"; `whole` drops ".00" ("$20"). */
export function formatUsd(n: number, opts: { whole?: boolean } = {}): string {
  if (opts.whole && Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(2)}`;
}

export function relativeAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!(ms >= MINUTE_MS)) return "just now";
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h ago`;
  return `${plural(Math.floor(ms / DAY_MS), "day")} ago`;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Lower-cases a sentence's first letter to continue another one, leaving
 *  an acronym ("HTTP 503") as it is. */
function continueSentence(text: string): string {
  const first = text.split(/\s/, 1)[0] ?? "";
  if (first.length > 1 && first === first.toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function incidentHeadline(input: {
  title: string;
  state: IncidentState;
  primary: SignalState | null;
  reason?: string;
}): string {
  const { title } = input;
  if (input.state === "resolved") return `${title} works again`;
  if (input.state === "closed-without-action")
    return `${title} is back to normal`;
  switch (input.primary) {
    case "failing":
      return `${title} is down`;
    case "slow":
      return `${title} is slow`;
    case "flaky":
      return `${title} fails on and off`;
    case "upcoming":
      return input.reason ? `${title}: ${input.reason}` : title;
    case "external":
      return `${title} has a provider problem`;
    case "unknown":
      return `${title} has no data`;
    case "ok":
      return `${title} passes again`;
    case null:
      return title;
  }
}

/** "~140 searches failed for 23 people"; null without a measured count. */
export function impactFact(impact: IncidentImpact | undefined): string | null {
  if (!impact || impact.count === undefined) return null;
  const count = `${impact.approximate ? "~" : ""}${impact.count.toLocaleString()} ${impact.noun}`;
  if (impact.people === undefined) return count;
  return `${count} for ${plural(impact.people, "person", "people")}`;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

let dayFormat: Intl.DateTimeFormat | undefined;
/** "20 Oct" in the locale's order. */
export function dayMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  return (dayFormat ??= new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  })).format(d);
}

/** The status line's facts, in order; the caller joins them with `·`. */
export function incidentFacts(input: {
  incident: Pick<
    Incident,
    "state" | "openedAt" | "closedAt" | "fixedBy" | "impact"
  >;
  sources: string[];
  now: number;
}): string[] {
  const { incident, now } = input;
  const impact = impactFact(incident.impact);
  if (incident.state === "closed-without-action")
    return [
      ...(incident.fixedBy ? [FIXED_BY_PHRASE[incident.fixedBy]] : []),
      ...(incident.closedAt
        ? [`back to normal ${clockTime(incident.closedAt)}`]
        : []),
    ];
  if (isTerminalIncidentState(incident.state)) {
    const facts: string[] = [];
    if (incident.fixedBy) facts.push(FIXED_BY_PHRASE[incident.fixedBy]);
    if (incident.closedAt)
      facts.push(
        `down for ${formatSpan(Date.parse(incident.closedAt) - Date.parse(incident.openedAt))}`,
      );
    if (impact) facts.push(impact);
    return facts;
  }
  const opened = new Date(incident.openedAt);
  const facts = [
    sameLocalDay(opened, new Date(now))
      ? `since ${clockTime(incident.openedAt)}`
      : `since ${dayMonth(incident.openedAt)}`,
  ];
  if (impact) facts.push(impact);
  const sources = [
    ...input.sources,
    ...(impact && incident.impact ? [incident.impact.label] : []),
  ];
  if (sources.length) facts.push(`from ${joinNames(sources)}`);
  return facts;
}

const HOME_COUNTS: Array<[SignalState, string]> = [
  ["ok", "green"],
  ["failing", "failing"],
  ["slow", "slow"],
  ["external", "provider"],
  ["flaky", "flaky"],
  ["upcoming", "due soon"],
  ["unknown", "with no data"],
];

const stateOf = (signal: Pick<SignalView, "evaluation">): SignalState =>
  signal.evaluation?.state ?? "unknown";

export interface HomeSummary {
  tone: DotTone;
  headline: string;
  sentence: string;
}

/** The home status line: counts by state and one sentence on the worst. */
export function homeSummary(input: {
  signals: SignalView[];
  lastClosed?: Pick<IncidentSummary, "closedAt" | "fixedBy">;
  now: number;
}): HomeSummary {
  const counted = input.signals.filter((signal) => signal.enabled);
  const counts = new Map<SignalState, number>();
  for (const signal of counted)
    counts.set(stateOf(signal), (counts.get(stateOf(signal)) ?? 0) + 1);
  const headline = HOME_COUNTS.flatMap(([state, word]) => {
    const n = counts.get(state) ?? 0;
    return n ? [`${n} ${word}`] : [];
  }).join(", ");
  const worst = counted
    .filter((signal) => stateOf(signal) !== "ok")
    .sort(
      (a, b) =>
        SIGNAL_RANK[stateOf(a)] - SIGNAL_RANK[stateOf(b)] ||
        a.name.localeCompare(b.name),
    )[0];
  const worstState = counted.length
    ? [...counts.keys()].sort((a, b) => SIGNAL_RANK[a] - SIGNAL_RANK[b])[0]!
    : null;
  const sentences: string[] = [];
  if (worst)
    sentences.push(
      `${worst.name}: ${continueSentence(worst.evaluation?.reason ?? "No data yet")}`,
    );
  if (input.lastClosed?.closedAt)
    sentences.push(
      `The last incident was ${
        input.lastClosed.fixedBy
          ? FIXED_BY_PHRASE[input.lastClosed.fixedBy]
          : "closed"
      } ${relativeAgo(input.lastClosed.closedAt, input.now)}`,
    );
  return {
    tone: worstState ? signalDotTone(worstState) : "faint",
    headline: headline || "No signals yet",
    sentence: sentences.join(". "),
  };
}
