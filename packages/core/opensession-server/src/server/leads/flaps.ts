// Flap or outage: how a project's signals behaved over a window, from the
// incidents they opened, and a concrete change for each signal that only
// flaps or only ever recovers by itself. Pure and deterministic: the caller
// passes the signals, the incidents and the time. An incident counts for
// the signal that opened it (its primary signal); signals attached later
// don't share it. A signal with an incident still open is undecided
// (mixed), and a disabled one gets no proposal.
import {
  type Incident,
  type Signal,
  type SignalRule,
  isOpenIncident,
  stripIntervalMs,
} from "../../shared/incidents";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const DEFAULT_FLAP_WINDOW_MS = 14 * DAY_MS;
/** An incident that closed by itself this soon after opening is a flap. */
export const DEFAULT_SELF_CLOSE_MINUTES = 30;
/** Fewer incidents than this never make a signal flapping. */
export const MIN_FLAP_INCIDENTS = 3;
/** The share of a signal's incidents that must be flaps to call it flapping. */
export const FLAPPING_SHARE = 0.75;
/** Above this many failures in a row, a rate rule replaces a longer run. */
const MAX_CONSECUTIVE_PROPOSAL = 10;
/** The signal validator's bounds (incidents/signal-validation.ts). */
const MAX_CONSECUTIVE = 50;
const MAX_RATE_AT_LEAST = 10_000;

/**
 * - `flapping`: most incidents closed by themselves quickly
 * - `slow-recoveries`: every closed incident recovered by itself, some
 *   only after longer than the flap window; nobody acted
 * - `real-outages`: every incident needed an agent or a person
 * - `mixed`: anything else, or an incident is still open
 * - `quiet`: no incidents
 */
export type FlapClass =
  | "flapping"
  | "slow-recoveries"
  | "real-outages"
  | "quiet"
  | "mixed";

export interface RuleProposal {
  /** The fields to change on the signal, as the signal API takes them. */
  change: Partial<Pick<Signal, "rule" | "provider" | "dependsOn">>;
  reason: string;
}

export interface SignalFlapReport {
  signalId: string;
  name: string;
  enabled: boolean;
  provider: boolean;
  rule: SignalRule;
  opened: number;
  closedWithoutAction: number;
  resolved: number;
  /** Resolved by agents or a person, not by recovering on its own. */
  resolvedWithAction: number;
  stillOpen: number;
  /** Bad runs its incidents stayed closed through while quiet. */
  quietFlaps: number;
  medianOpenMs: number | null;
  maxOpenMs: number | null;
  /** Incidents that closed by themselves within `minutes` of opening. */
  selfClosed: { minutes: number; count: number; share: number };
  /** Incidents that closed by themselves after longer than that. */
  slowRecoveries: number;
  classification: FlapClass;
  proposal?: RuleProposal;
}

export interface FlapReport {
  project: string;
  from: string;
  to: string;
  windowMs: number;
  selfCloseMinutes: number;
  signals: SignalFlapReport[];
  counts: Record<FlapClass, number>;
  /** Incidents in the window whose primary signal no longer exists. */
  orphanIncidents: number;
}

export interface FlapInput {
  project: string;
  signals: readonly Signal[];
  incidents: readonly Incident[];
  now: number;
  windowMs?: number;
  selfCloseMinutes?: number;
}

/** Closed with no action taken: back to normal before any agent ran, or a
 *  provider recovered. */
function closedByItself(i: Incident): boolean {
  if (i.state === "closed-without-action") return true;
  return (
    i.state === "resolved" &&
    (i.fixedBy === "recovered" || i.fixedBy === "provider-recovered")
  );
}

function openMs(i: Incident): number | null {
  if (isOpenIncident(i) || !i.closedAt) return null;
  const ms = Date.parse(i.closedAt) - Date.parse(i.openedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Whole minutes, at least 1: "4 min". */
export function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
}

function days(ms: number): string {
  const d = Math.round(ms / DAY_MS);
  return d === 1 ? "1 day" : `${d} days`;
}

function signalHost(signal: Signal): string | undefined {
  try {
    if (signal.source.kind === "http")
      return new URL(signal.source.url).hostname.toLowerCase() || undefined;
    if (signal.source.kind === "expiry")
      return signal.source.host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
  return undefined;
}

/** The last two labels of a host: a stand-in for its registrable domain,
 *  good enough to tell the project's own hosts from someone else's. */
function domainOf(host: string): string {
  return host.split(".").filter(Boolean).slice(-2).join(".");
}

/** The domain most of the project's signals point at, when one does. */
function ownDomain(signals: readonly Signal[]): string | undefined {
  const counts = new Map<string, number>();
  for (const s of signals) {
    const host = signalHost(s);
    if (host) counts.set(domainOf(host), (counts.get(domainOf(host)) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0]![1] < 2) return undefined;
  if (ranked[1] && ranked[1][1] === ranked[0]![1]) return undefined;
  return ranked[0]![0];
}

function roundUp(ms: number, step: number): number {
  return Math.ceil(ms / step) * step;
}

/**
 * How long each flap's bad run lasted, estimated from its incident: it
 * opened once the rule saw enough failures and closed once enough checks
 * passed, so the bad run is the open time plus the failures to open minus
 * the passes to close.
 */
function badRunMs(
  signal: Signal,
  incidentOpenMs: number,
  intervalMs: number,
): number {
  const rule = signal.rule;
  const toOpen =
    rule.kind === "consecutive"
      ? rule.failures
      : rule.kind === "rate"
        ? rule.atLeast
        : 1;
  const toClose =
    rule.kind === "consecutive" || rule.kind === "threshold"
      ? (rule.recoveries ?? 2)
      : 2;
  return Math.max(intervalMs, incidentOpenMs + (toOpen - toClose) * intervalMs);
}

function ruleProposal(
  signal: Signal,
  longestFlapMs: number,
  stats: string,
): RuleProposal | undefined {
  const rule = signal.rule;
  const interval = stripIntervalMs(signal);
  // Failures in a row that a flap as long as the longest one never reaches.
  const needed = Math.floor(longestFlapMs / interval) + 1;
  switch (rule.kind) {
    case "consecutive": {
      const failures = Math.min(
        MAX_CONSECUTIVE,
        Math.max(rule.failures + 1, needed),
      );
      if (failures <= MAX_CONSECUTIVE_PROPOSAL)
        return {
          change: { rule: { ...rule, failures } },
          reason: `${stats}. Needing ${failures} failures in a row instead of ${rule.failures} rides out the longest flap (${minutes(longestFlapMs)} at one check every ${minutes(interval)}).`,
        };
      // A run that long would make real outages wait too: count failures
      // over a window twice the longest flap instead, which a flap fills
      // at most halfway.
      const windowMs = Math.min(
        DAY_MS,
        roundUp(2 * longestFlapMs, 5 * MINUTE_MS),
      );
      const atLeast = Math.min(
        MAX_RATE_AT_LEAST,
        Math.ceil((0.6 * windowMs) / interval),
      );
      return {
        change: { rule: { kind: "rate", windowMs, atLeast, ratio: 0.6 } },
        reason: `${stats}. Failing 60% of checks over ${minutes(windowMs)} (twice the longest flap) instead of ${rule.failures} failures in a row.`,
      };
    }
    case "rate": {
      const atLeast = Math.min(
        MAX_RATE_AT_LEAST,
        Math.max(rule.atLeast + 1, needed),
      );
      const windowMs = Math.min(
        DAY_MS,
        Math.max(rule.windowMs, roundUp(2 * atLeast * interval, MINUTE_MS)),
      );
      return {
        change: { rule: { ...rule, atLeast, windowMs } },
        reason: `${stats}. Needing ${atLeast} failures in ${minutes(windowMs)} instead of ${rule.atLeast} in ${minutes(rule.windowMs)} rides out the longest flap.`,
      };
    }
    case "threshold": {
      const forMs = Math.min(
        DAY_MS,
        roundUp(Math.max(2 * rule.forMs, longestFlapMs + interval), MINUTE_MS),
      );
      return {
        change: { rule: { ...rule, forMs } },
        reason: `${stats}. Holding over the threshold for ${minutes(forMs)} instead of ${minutes(rule.forMs)} rides out the longest flap.`,
      };
    }
    case "missing": {
      const graceMs = Math.min(
        DAY_MS,
        roundUp(
          Math.max(2 * rule.graceMs, rule.graceMs + longestFlapMs),
          MINUTE_MS,
        ),
      );
      return {
        change: { rule: { ...rule, graceMs } },
        reason: `${stats}. A grace of ${minutes(graceMs)} instead of ${minutes(rule.graceMs)} covers the late check-ins.`,
      };
    }
    case "deadline":
      // An expiry date doesn't flap; a failing check means the host or
      // its certificate is wrong, which a rule change would hide.
      return undefined;
  }
}

interface ProposalContext {
  windowMs: number;
  selfCloseMinutes: number;
  own?: string;
  /** Every signal, other projects' too: a provider elsewhere may already
   *  watch the same outside host. */
  allSignals: readonly Signal[];
}

/** For an http signal that polls outside the project's own domain: depend
 *  on a provider signal of another project that already watches that
 *  domain, else become a provider itself. Either way its outages become
 *  findings on the project's own incidents instead of incidents of their
 *  own. */
function providerProposal(
  signal: Signal,
  stats: string,
  ctx: ProposalContext,
): RuleProposal | undefined {
  const host = signalHost(signal);
  if (
    signal.provider ||
    !host ||
    !ctx.own ||
    domainOf(host) === ctx.own ||
    signal.source.kind !== "http"
  )
    return undefined;
  const outside = `It polls ${host}, outside ${ctx.own} where the project's other signals point`;
  const speaker = ctx.allSignals.find((p) => {
    if (p.id === signal.id || !p.provider || !p.enabled) return false;
    if (p.project === signal.project) return false;
    const h = signalHost(p);
    return !!h && domainOf(h) === domainOf(host);
  });
  if (speaker && !signal.dependsOn?.includes(speaker.id))
    return {
      change: { dependsOn: [...(signal.dependsOn ?? []), speaker.id] },
      reason: `${stats}. ${outside}, and provider signal ${speaker.name} (\`${speaker.id}\`, project ${speaker.project}) already watches ${domainOf(host)}: depend on it, so its outages become findings on the project's own incidents instead of incidents of their own.`,
    };
  return {
    change: { provider: true },
    reason: `${stats}. ${outside}: mark it a provider, so its outages become findings on the project's own incidents instead of incidents of their own.`,
  };
}

function proposalFor(
  signal: Signal,
  flaps: Incident[],
  opened: number,
  ctx: ProposalContext,
): RuleProposal | undefined {
  const durations = flaps.map((i) => openMs(i) ?? 0);
  const longestOpen = Math.max(...durations);
  const stats = `Opened ${opened} times in ${days(ctx.windowMs)}; ${flaps.length} closed by themselves within ${ctx.selfCloseMinutes} min (median ${minutes(median(durations) ?? 0)}, longest ${minutes(longestOpen)})`;
  const provider = providerProposal(signal, stats, ctx);
  if (provider) return provider;
  const interval = stripIntervalMs(signal);
  const longestFlap = Math.max(
    ...durations.map((ms) => badRunMs(signal, ms, interval)),
  );
  return ruleProposal(signal, longestFlap, stats);
}

/** A signal whose incidents only ever recovered by themselves, some slowly:
 *  a longer rule would only delay real outages, so the one change worth
 *  proposing is about where it points. */
function slowProposal(
  signal: Signal,
  slow: Incident[],
  opened: number,
  ctx: ProposalContext,
): RuleProposal | undefined {
  const durations = slow.map((i) => openMs(i) ?? 0);
  const stats = `Opened ${opened} times in ${days(ctx.windowMs)}; every one recovered by itself, ${slow.length} after more than ${ctx.selfCloseMinutes} min (longest ${minutes(Math.max(...durations))}), and nobody acted on any`;
  return providerProposal(signal, stats, ctx);
}

function classify(counts: {
  opened: number;
  stillOpen: number;
  flaps: number;
  slow: number;
  acted: number;
}): FlapClass {
  const { opened, stillOpen, flaps, slow, acted } = counts;
  if (opened === 0) return "quiet";
  // An open incident may still turn out either way.
  if (stillOpen > 0) return "mixed";
  if (opened >= MIN_FLAP_INCIDENTS && flaps / opened >= FLAPPING_SHARE)
    return "flapping";
  if (acted === opened) return "real-outages";
  if (acted === 0 && slow > 0) return "slow-recoveries";
  return "mixed";
}

/** The project's signals over the window, flapping ones first, then by
 *  incidents opened. */
export function triageFlaps(input: FlapInput): FlapReport {
  const windowMs = input.windowMs ?? DEFAULT_FLAP_WINDOW_MS;
  const selfCloseMinutes = input.selfCloseMinutes ?? DEFAULT_SELF_CLOSE_MINUTES;
  const since = input.now - windowMs;
  const signals = input.signals.filter((s) => s.project === input.project);
  const own = ownDomain(signals);
  const byPrimary = new Map<string, Incident[]>();
  let orphanIncidents = 0;
  const known = new Set(signals.map((s) => s.id));
  for (const i of input.incidents) {
    if (i.project !== input.project) continue;
    const at = Date.parse(i.openedAt);
    if (!(at >= since && at <= input.now)) continue;
    if (!known.has(i.primarySignalId)) {
      orphanIncidents++;
      continue;
    }
    const list = byPrimary.get(i.primarySignalId) ?? [];
    list.push(i);
    byPrimary.set(i.primarySignalId, list);
  }
  const reports = signals.map((signal): SignalFlapReport => {
    const incidents = byPrimary.get(signal.id) ?? [];
    const durations = incidents
      .map(openMs)
      .filter((ms): ms is number => ms !== null);
    const quick = (i: Incident) =>
      (openMs(i) ?? Infinity) <= selfCloseMinutes * MINUTE_MS;
    const flaps = incidents.filter((i) => closedByItself(i) && quick(i));
    const slow = incidents.filter((i) => closedByItself(i) && !quick(i));
    const opened = incidents.length;
    const stillOpen = incidents.filter(isOpenIncident).length;
    const acted = incidents.filter(
      (i) => i.state === "resolved" && !closedByItself(i),
    ).length;
    const classification = classify({
      opened,
      stillOpen,
      flaps: flaps.length,
      slow: slow.length,
      acted,
    });
    const report: SignalFlapReport = {
      signalId: signal.id,
      name: signal.name,
      enabled: signal.enabled,
      provider: signal.provider === true,
      rule: signal.rule,
      opened,
      closedWithoutAction: incidents.filter(
        (i) => i.state === "closed-without-action",
      ).length,
      resolved: incidents.filter((i) => i.state === "resolved").length,
      resolvedWithAction: acted,
      stillOpen,
      quietFlaps: incidents.reduce((n, i) => n + (i.quiet?.flaps ?? 0), 0),
      medianOpenMs: median(durations),
      maxOpenMs: durations.length ? Math.max(...durations) : null,
      selfClosed: {
        minutes: selfCloseMinutes,
        count: flaps.length,
        share: opened ? Math.round((flaps.length / opened) * 100) / 100 : 0,
      },
      slowRecoveries: slow.length,
      classification,
    };
    // A disabled signal opens nothing: changing it would change nothing.
    if (!signal.enabled) return report;
    const ctx = { windowMs, selfCloseMinutes, own, allSignals: input.signals };
    const proposal =
      classification === "flapping"
        ? proposalFor(signal, flaps, opened, ctx)
        : classification === "slow-recoveries"
          ? slowProposal(signal, slow, opened, ctx)
          : undefined;
    if (proposal) report.proposal = proposal;
    return report;
  });
  const order: Record<FlapClass, number> = {
    flapping: 0,
    "slow-recoveries": 1,
    mixed: 2,
    "real-outages": 3,
    quiet: 4,
  };
  reports.sort(
    (a, b) =>
      order[a.classification] - order[b.classification] ||
      b.opened - a.opened ||
      a.name.localeCompare(b.name) ||
      a.signalId.localeCompare(b.signalId),
  );
  const counts: Record<FlapClass, number> = {
    flapping: 0,
    "slow-recoveries": 0,
    "real-outages": 0,
    quiet: 0,
    mixed: 0,
  };
  for (const r of reports) counts[r.classification]++;
  return {
    project: input.project,
    from: new Date(since).toISOString(),
    to: new Date(input.now).toISOString(),
    windowMs,
    selfCloseMinutes,
    signals: reports,
    counts,
    orphanIncidents,
  };
}

const CLASS_LABELS: Record<FlapClass, string> = {
  flapping: "flapping",
  "slow-recoveries": "slow recoveries",
  "real-outages": "real outages",
  quiet: "quiet",
  mixed: "mixed",
};

/** One line per signal, then each proposal: for the lead and the digest. */
export function flapReportMarkdown(report: FlapReport): string {
  const lines = [
    `Signals over the last ${days(report.windowMs)}: ${report.counts.flapping} flapping, ${report.counts["slow-recoveries"]} recovering slowly by themselves, ${report.counts["real-outages"]} with real outages, ${report.counts.mixed} mixed, ${report.counts.quiet} quiet.`,
  ];
  for (const s of report.signals) {
    const bits = [
      `${s.opened} opened`,
      `${s.selfClosed.count} closed by themselves within ${s.selfClosed.minutes} min`,
      `${s.resolvedWithAction} fixed`,
    ];
    if (s.slowRecoveries)
      bits.push(`${s.slowRecoveries} recovered by themselves after longer`);
    if (s.stillOpen) bits.push(`${s.stillOpen} still open`);
    if (s.medianOpenMs !== null)
      bits.push(`median open ${minutes(s.medianOpenMs)}`);
    if (s.provider) bits.push("provider");
    if (!s.enabled) bits.push("disabled");
    lines.push(
      `- ${s.name} (\`${s.signalId}\`): ${CLASS_LABELS[s.classification]}; ${bits.join(", ")}`,
    );
    if (s.proposal)
      lines.push(
        `  - Proposed: \`${JSON.stringify(s.proposal.change)}\`. ${s.proposal.reason}`,
      );
  }
  if (report.orphanIncidents)
    lines.push(
      `${report.orphanIncidents} incidents came from signals that no longer exist.`,
    );
  return lines.join("\n");
}
