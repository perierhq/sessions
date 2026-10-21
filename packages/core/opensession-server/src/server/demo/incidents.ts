/**
 * Demo incidents (OPENSESSION_DEMO=1 only, called from startDemo, which
 * refuses to run without an isolated OPENSESSION_STATE_DIR). Seeds the demo
 * project with signals, a few hours of observations and incidents in the
 * states the incident views draw: a fix deploying after a veto, one that
 * needs the owner, a flaky heads-up and resolved ones. The demo's signal
 * checks never leave the machine: they answer with the same scripted results
 * the history was made from, so the states hold while the demo runs. A dev
 * instance runs no signal scheduler, so {@link tickDemoSignals} records
 * them; where the scheduler does run, {@link runDemoSignalSource} is its
 * source. Idempotent: a second boot keeps what is there, fills the time it
 * was down and moves the veto's deadline forward again.
 */
import type {
  AgentRun,
  IncidentResponse,
  LedgerEntry,
} from "../../shared/incident-response";
import type {
  FixedBy,
  Incident,
  IncidentEvent,
  IncidentState,
  Observation,
  Signal,
  SignalRule,
  SignalSource,
  StripMarkerKind,
} from "../../shared/incidents";
import {
  createIncident,
  listIncidents,
  updateIncident,
} from "../incidents/incident-store";
import {
  hydrateObservations,
  hydrationLookbackMs,
  recentObservations,
} from "../incidents/observation-store";
import { ingestObservations } from "../incidents/signal-runtime";
import { createSignal, listSignals } from "../incidents/signal-store";
import { runSignalSource, type SourceRun } from "../incidents/sources";
import { DEMO_GH_REPO, DEMO_PR_NUMBER, DEMO_REPO_ID } from "./fixtures";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Who the demo's records say created them; also how a reboot finds them. */
export const DEMO_INCIDENT_AUTHOR = "Demo";
/** How long the demo's veto runs (the default project setting); re-armed
 *  before it ends. */
export const DEMO_VETO_MS = 10 * MINUTE_MS;
const VETO_RULE = "Deploys after a 10 minute veto";
/** History drawn behind the live edge, per polled signal. */
const HISTORY_MS = 6 * HOUR_MS;

type DemoKey =
  | "search"
  | "checkout"
  | "latency"
  | "bounce"
  | "signin"
  | "export"
  | "certificate"
  | "errors";

interface DemoSignal {
  key: DemoKey;
  name: string;
  source: SignalSource;
  rule: SignalRule;
  intervalMs?: number;
  severity: Signal["severity"];
}

const host = "acme.example.test";

const DEMO_SIGNALS: DemoSignal[] = [
  {
    key: "search",
    name: "Search",
    source: { kind: "http", url: `https://${host}/search?q=demo` },
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    intervalMs: 2 * MINUTE_MS,
    severity: "critical",
  },
  {
    key: "checkout",
    name: "Checkout",
    source: { kind: "http", url: `https://${host}/checkout/health` },
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    intervalMs: MINUTE_MS,
    severity: "critical",
  },
  {
    key: "latency",
    name: "Search latency",
    source: { kind: "http", url: `https://${host}/search?q=latency` },
    rule: { kind: "threshold", above: 1500, forMs: 5 * MINUTE_MS },
    intervalMs: MINUTE_MS,
    severity: "minor",
  },
  {
    key: "bounce",
    name: "Bounce webhook",
    source: { kind: "http", url: `https://${host}/hooks/bounce/test` },
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    intervalMs: 2 * MINUTE_MS,
    severity: "major",
  },
  {
    key: "signin",
    name: "Sign-in",
    source: { kind: "http", url: `https://${host}/login` },
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    intervalMs: MINUTE_MS,
    severity: "critical",
  },
  {
    key: "export",
    name: "Nightly export",
    source: { kind: "heartbeat" },
    rule: { kind: "missing", cron: "0 3 * * *", graceMs: 30 * MINUTE_MS },
    severity: "major",
  },
  {
    key: "certificate",
    name: `${host} certificate`,
    source: { kind: "expiry", target: "tls", host },
    rule: { kind: "deadline", warnDays: 14, failDays: 3 },
    severity: "major",
  },
  {
    key: "errors",
    name: "Error reports",
    source: { kind: "webhook" },
    rule: { kind: "rate", windowMs: 10 * MINUTE_MS, atLeast: 5 },
    severity: "major",
  },
];

/** When each scripted failure started, as an age at seed time. The live
 *  checks keep failing (or passing) the way the history ends. */
const SEARCH_DOWN_FOR = 34 * MINUTE_MS;
const CHECKOUT_DOWN_FOR = 72 * MINUTE_MS;
const SIGNIN_DOWN = { from: 5 * HOUR_MS, to: 3 * HOUR_MS };

/** A stable 0–1 from a number, so latencies wobble the same on every run. */
function noise(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function ok(at: number, value: number): Observation {
  return {
    at: new Date(at).toISOString(),
    result: "ok",
    value: Math.round(value),
    detail: "HTTP 200",
  };
}

function fail(at: number, detail: string): Observation {
  return { at: new Date(at).toISOString(), result: "fail", detail };
}

/**
 * The scripted result of a polled demo check at `at`. `ageMs` is how long
 * before the seed `at` is; live checks pass 0 (the state the history ends
 * in).
 */
function scripted(key: DemoKey, at: number, ageMs: number): Observation | null {
  const slot = Math.floor(at / MINUTE_MS);
  const latency = 160 + noise(slot) * 260;
  switch (key) {
    case "search":
      return ageMs < SEARCH_DOWN_FOR
        ? fail(at, "Timed out after 10 s")
        : ok(at, latency + 120);
    case "checkout":
      return ageMs < CHECKOUT_DOWN_FOR
        ? fail(at, "HTTP 502 from the payments service")
        : ok(at, latency);
    case "latency":
      return ok(at, 320 + noise(slot + 7) * 520);
    case "bounce":
      // One failure in five: never three in a row, always some recently.
      return Math.floor(at / (2 * MINUTE_MS)) % 5 === 0
        ? fail(at, "HTTP 500 from the bounce handler")
        : ok(at, latency);
    case "signin":
      return ageMs <= SIGNIN_DOWN.from && ageMs > SIGNIN_DOWN.to
        ? fail(at, "HTTP 500 on POST /login")
        : ok(at, latency - 40);
    case "certificate": {
      const expires = at + 62 * DAY_MS;
      return {
        at: new Date(at).toISOString(),
        result: "ok",
        value: 62,
        detail: `Certificate expires ${new Date(expires).toISOString().slice(0, 10)} (62 days)`,
      };
    }
    case "export":
    case "errors":
      return null;
  }
}

function keyOf(signal: Pick<Signal, "name" | "project">): DemoKey | null {
  if (signal.project !== DEMO_REPO_ID) return null;
  return DEMO_SIGNALS.find((s) => s.name === signal.name)?.key ?? null;
}

/**
 * The scheduler's source in the demo: scripted results for the demo's own
 * checks, the real source for anything created through the UI.
 */
export async function runDemoSignalSource(signal: Signal): Promise<SourceRun> {
  const key = signal.createdBy === DEMO_INCIDENT_AUTHOR ? keyOf(signal) : null;
  if (!key) return runSignalSource(signal);
  const observation = scripted(key, Date.now(), 0);
  return { observations: observation ? [observation] : [] };
}

function history(spec: DemoSignal, now: number): Observation[] {
  const out: Observation[] = [];
  if (spec.key === "export") {
    // Checked in at 03:00 UTC on each of the last three days.
    const today = Date.parse(
      `${new Date(now).toISOString().slice(0, 10)}T03:00:12Z`,
    );
    for (let day = 3; day >= 0; day--) {
      const at = today - day * DAY_MS;
      if (at <= now)
        out.push({
          at: new Date(at).toISOString(),
          result: "ok",
          detail: "Checked in",
        });
    }
    return out;
  }
  if (spec.key === "errors") {
    for (const ago of [
      4.6 * HOUR_MS,
      2.1 * HOUR_MS,
      48 * MINUTE_MS,
      25 * MINUTE_MS,
    ])
      out.push(fail(now - ago, "TypeError: cannot read the cart total"));
    return out;
  }
  const interval =
    spec.intervalMs ??
    (spec.source.kind === "expiry" ? 6 * HOUR_MS : MINUTE_MS);
  const span = spec.key === "certificate" ? 20 * DAY_MS : HISTORY_MS;
  const first = Math.ceil((now - span) / interval) * interval;
  for (let at = first; at < now; at += interval) {
    const observation = scripted(spec.key, at, now - at);
    if (observation) out.push(observation);
  }
  return out;
}

// --- incidents -------------------------------------------------------------

let eventSeq = 0;
function event(
  at: number,
  kind: IncidentEvent["kind"],
  detail: string,
  extra: Partial<IncidentEvent> = {},
): IncidentEvent {
  eventSeq += 1;
  return {
    id: `evt-demo-${eventSeq}`,
    at: new Date(at).toISOString(),
    kind,
    by: "sessions",
    detail,
    ...extra,
  };
}

function marker(
  at: number,
  mark: StripMarkerKind,
  detail: string,
  to?: IncidentState,
): IncidentEvent {
  return event(at, "state", detail, { marker: mark, ...(to ? { to } : {}) });
}

let ledgerSeq = 0;
function ledger(
  at: number,
  actor: LedgerEntry["actor"],
  kind: LedgerEntry["kind"],
  detail: string,
  costUsd?: number,
): LedgerEntry {
  ledgerSeq += 1;
  return {
    id: `led-demo-${ledgerSeq}`,
    at: new Date(at).toISOString(),
    actor,
    kind,
    detail,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

function agent(
  role: AgentRun["role"],
  startedAt: number,
  endedAt: number,
  costUsd: number,
  report: AgentRun["report"],
  prUrl?: string,
): AgentRun {
  return {
    role,
    round: 1,
    attempt: 1,
    sessionId: `demo-incident-${role}`,
    model: role === "investigator" ? "claude-sonnet-4-5" : "claude-opus-4-1",
    provider: "anthropic",
    ...(role === "verifier" ? { independence: "same-provider" as const } : {}),
    workspace: { kind: "sandbox", provider: "local" },
    accessSummary: "Reads logs and the repository; no production writes",
    accessRevision: "demo",
    status: "done",
    startedAt: iso(startedAt),
    turnSentAt: iso(startedAt),
    endedAt: iso(endedAt),
    costUsd,
    tokens: Math.round(costUsd * 90_000),
    reminded: false,
    ...(report ? { report } : {}),
    ...(prUrl ? { prUrl } : {}),
  };
}

function baseResponse(
  startedAt: number,
  now: number,
  over: Partial<IncidentResponse>,
): IncidentResponse {
  return {
    phase: "done",
    round: 1,
    maxRounds: 2,
    agents: [],
    actionRuns: [],
    costUsd: 0,
    ownerTouched: false,
    next: { kind: "done", detail: "Fixed", options: [] },
    ledger: [],
    droppedLedger: 0,
    startedAt: iso(startedAt),
    updatedAt: iso(now),
    ...over,
  };
}

/** The search fix: found, proved, verified, deploying after the veto. */
function vetoResponse(openedAt: number, now: number): IncidentResponse {
  const found = openedAt + 14 * MINUTE_MS;
  const verified = openedAt + 26 * MINUTE_MS;
  const vetoStart = now - 30_000;
  const deadline = vetoStart + DEMO_VETO_MS;
  // The demo's own pull request, so the Change row has one to show.
  const prUrl = `https://github.com/${DEMO_GH_REPO}/pull/${DEMO_PR_NUMBER}`;
  return baseResponse(openedAt + MINUTE_MS, now, {
    phase: "veto",
    agents: [
      agent(
        "investigator",
        openedAt + MINUTE_MS,
        found,
        2.6,
        {
          role: "investigator",
          summary: "Search times out since the 12:02 release",
          cause:
            "The 12:02 release dropped the search index's read replica, so every query waits on the primary until it times out",
          readFirst: [],
          attempts: [],
          candidate: { pr: true, actions: [] },
          check: {
            kind: "request",
            source: { kind: "http", url: `https://${host}/search?q=demo` },
          },
          claims: [
            {
              text: "The replica was removed in the release config",
              source: `${prUrl}/files`,
            },
          ],
          notePath: "docs/incidents/search-replica.md",
          runbookPaths: [],
        },
        prUrl,
      ),
      agent("verifier", found, verified, 1.2, {
        role: "verifier",
        verdict: "certain",
        reasons: ["The proof request passes against the fix"],
        claims: [],
        proofAccepted: true,
      }),
    ],
    candidate: {
      round: 1,
      plan: { pr: true, actions: [] },
      check: {
        kind: "request",
        source: { kind: "http", url: `https://${host}/search?q=demo` },
      },
      claims: [],
      notePath: "docs/incidents/search-replica.md",
      runbookPaths: [],
      prUrl,
    },
    proof: {
      round: 1,
      at: iso(verified - 2 * MINUTE_MS),
      baseline: {
        verdict: "fails",
        samples: [0, 1, 2].map((i) => ({
          at: iso(found + i * 20_000),
          result: "fail" as const,
          detail: "Timed out after 10 s",
        })),
      },
      candidate: {
        kind: "request",
        verdict: "passes",
        samples: [0, 1, 2, 3, 4].map((i) => ({
          at: iso(found + 4 * MINUTE_MS + i * 60_000),
          result: "ok" as const,
          detail: "HTTP 200 in 310 ms",
        })),
      },
    },
    verdict: {
      round: 1,
      at: iso(verified),
      verdict: "certain",
      reasons: ["The proof request passes against the fix"],
    },
    decision: {
      kind: "act",
      after: "veto",
      vetoMs: DEMO_VETO_MS,
      rule: VETO_RULE,
    },
    veto: { startedAt: iso(vetoStart), deadline: iso(deadline) },
    costUsd: 3.8,
    next: {
      kind: "veto",
      deadline: iso(deadline),
      rule: VETO_RULE,
    },
    ledger: [
      ledger(
        openedAt + MINUTE_MS,
        "sessions",
        "agent-started",
        "Investigator started",
      ),
      ledger(
        found,
        "investigator",
        "agent-finished",
        "Found the cause and opened a fix",
        2.6,
      ),
      ledger(
        verified - 2 * MINUTE_MS,
        "sessions",
        "proof",
        "The proof request passes against the fix",
      ),
      ledger(verified, "verifier", "verdict", "Certain", 1.2),
      ledger(vetoStart, "sessions", "veto", VETO_RULE),
    ],
  });
}

function needsYouResponse(openedAt: number, now: number): IncidentResponse {
  const found = openedAt + 22 * MINUTE_MS;
  const since = openedAt + 41 * MINUTE_MS;
  const reason =
    "The fix changes the payments schema, and schema changes need you";
  return baseResponse(openedAt + MINUTE_MS, now, {
    phase: "needs-you",
    agents: [
      agent("investigator", openedAt + MINUTE_MS, found, 1.1, {
        role: "investigator",
        summary: "Checkout answers 502 since the payments migration",
        cause:
          "A migration renamed the payments table's currency column, and the checkout service still reads the old name",
        readFirst: [],
        attempts: [],
        candidate: { pr: true, actions: [] },
        check: { kind: "after-deploy", reason: "Needs the migration applied" },
        claims: [],
        notePath: "docs/incidents/checkout-currency.md",
        runbookPaths: [],
      }),
      agent("verifier", found, since, 0.5, {
        role: "verifier",
        verdict: "certain",
        reasons: ["The column rename matches the 502s"],
        claims: [],
        proofAccepted: true,
      }),
    ],
    verdict: {
      round: 1,
      at: iso(since),
      verdict: "certain",
      reasons: ["The column rename matches the 502s"],
    },
    decision: { kind: "ask", reason, rule: "Schema changes need you" },
    needsYou: {
      kind: "policy",
      reason,
      since: iso(since),
      resumePhase: "merging",
    },
    costUsd: 1.6,
    next: {
      kind: "needs-you",
      reason,
      needsYou: "policy",
      rule: "Schema changes need you",
      options: ["approve", "send-back", "stop"],
    },
  });
}

interface PastSpec {
  title: string;
  signal: DemoKey;
  openedAgo: number;
  lasted: number;
  fixedBy: FixedBy;
  costUsd: number | null;
}

const PAST: PastSpec[] = [
  {
    title: "Sign-in errors",
    signal: "signin",
    openedAgo: SIGNIN_DOWN.from,
    lasted: SIGNIN_DOWN.from - SIGNIN_DOWN.to,
    fixedBy: "agents",
    costUsd: 1.2,
  },
  {
    title: "Search down",
    signal: "search",
    openedAgo: 9 * DAY_MS,
    lasted: 2 * HOUR_MS,
    fixedBy: "agents",
    costUsd: 3.8,
  },
  {
    title: "Checkout connection limit",
    signal: "checkout",
    openedAgo: 20 * DAY_MS,
    lasted: 3 * HOUR_MS,
    fixedBy: "agents-with-you",
    costUsd: 2.1,
  },
  {
    title: "Search latency over 2 s",
    signal: "latency",
    openedAgo: 60 * DAY_MS,
    lasted: DAY_MS,
    fixedBy: "by-hand",
    costUsd: null,
  },
  {
    title: "Email provider outage",
    signal: "errors",
    openedAgo: 140 * DAY_MS,
    lasted: 50 * MINUTE_MS,
    fixedBy: "provider-recovered",
    costUsd: 0,
  },
];

async function seedIncidents(
  ids: Map<DemoKey, string>,
  now: number,
): Promise<void> {
  const id = (key: DemoKey) => ids.get(key)!;
  const open = async (
    title: string,
    key: DemoKey,
    openedAt: number,
    state: "heads-up" | "investigating",
    detail: string,
  ): Promise<Incident> =>
    createIncident({
      project: DEMO_REPO_ID,
      title,
      state,
      severity: state === "heads-up" ? "minor" : "critical",
      owner: DEMO_INCIDENT_AUTHOR,
      openedBy: { kind: "rule" },
      signalIds: [id(key)],
      primarySignalId: id(key),
      at: iso(openedAt),
      detail,
    });

  for (const past of PAST) {
    const openedAt = now - past.openedAgo;
    const closedAt = openedAt + past.lasted;
    const created = await open(
      past.title,
      past.signal,
      openedAt,
      "investigating",
      "Opened by its signal",
    );
    await updateIncident(created.id, (incident) => ({
      ...incident,
      state: "resolved",
      closedAt: iso(closedAt),
      updatedAt: iso(closedAt),
      fixedBy: past.fixedBy,
      ...(past.costUsd === null
        ? {}
        : {
            response: baseResponse(openedAt, closedAt, {
              costUsd: past.costUsd,
              next: { kind: "done", detail: "Fixed", options: [] },
            }),
          }),
      events: [
        ...incident.events,
        marker(closedAt, "resolved", "Back to normal", "resolved"),
      ],
    }));
  }

  const searchOpened = now - SEARCH_DOWN_FOR + 4 * MINUTE_MS;
  const search = await open(
    "Search down",
    "search",
    searchOpened,
    "investigating",
    "3 failures in a row",
  );
  await updateIncident(search.id, (incident) => {
    const response = vetoResponse(searchOpened, now);
    return {
      ...incident,
      state: "veto",
      updatedAt: iso(now),
      response,
      events: [
        ...incident.events,
        marker(
          Date.parse(response.verdict!.at),
          "fix-ready",
          "Fix ready",
          "fix-ready",
        ),
        event(
          Date.parse(response.veto!.startedAt),
          "state",
          "Deploys after the veto",
          { to: "veto" },
        ),
      ],
    };
  });

  const checkoutOpened = now - CHECKOUT_DOWN_FOR + 3 * MINUTE_MS;
  const checkout = await open(
    "Checkout fails",
    "checkout",
    checkoutOpened,
    "investigating",
    "3 failures in a row",
  );
  await updateIncident(checkout.id, (incident) => {
    const response = needsYouResponse(checkoutOpened, now);
    return {
      ...incident,
      state: "needs-you",
      resumeState: "fix-ready",
      updatedAt: iso(now),
      response,
      events: [
        ...incident.events,
        marker(
          Date.parse(response.needsYou!.since),
          "fix-ready",
          "Fix ready",
          "needs-you",
        ),
      ],
    };
  });

  await open(
    "Bounce webhook fails on and off",
    "bounce",
    now - 50 * MINUTE_MS,
    "heads-up",
    "Failing on and off",
  );
}

const pollIntervalMs = (spec: DemoSignal) =>
  spec.intervalMs ?? (spec.source.kind === "expiry" ? 6 * HOUR_MS : 0);

/**
 * Record each polled demo check that is due, from its last observation (or
 * the start of the history) to `now`, then re-evaluate every demo signal so
 * time-based rules move on. Does nothing while the signal scheduler runs:
 * it polls the same checks through {@link runDemoSignalSource}.
 */
export async function tickDemoSignals(now: number = Date.now()): Promise<void> {
  if (globalThis.__incidentSignals) return;
  const signals = (await listSignals()).filter(
    (s) => s.createdBy === DEMO_INCIDENT_AUTHOR && s.enabled,
  );
  for (const signal of signals) {
    const key = keyOf(signal);
    const spec = DEMO_SIGNALS.find((s) => s.key === key);
    if (!key || !spec) continue;
    const interval = pollIntervalMs(spec);
    const due: Observation[] = [];
    if (interval > 0) {
      await hydrateObservations(
        signal.id,
        now,
        hydrationLookbackMs(signal, now),
      );
      const last = recentObservations(signal.id).at(-1);
      const start = last
        ? Date.parse(last.at) + interval
        : Math.ceil((now - HISTORY_MS) / interval) * interval;
      for (let at = start; at <= now; at += interval) {
        const observation = scripted(key, at, 0);
        if (observation) due.push(observation);
      }
    }
    await ingestObservations(signal.id, due, now);
  }
}

/**
 * Move the demo veto's deadline forward once it is within a minute of
 * ending, so the page always shows a fix about to deploy.
 */
export async function rearmDemoVeto(now: number = Date.now()): Promise<void> {
  const open = await listIncidents({ open: true, project: DEMO_REPO_ID });
  for (const incident of open) {
    const veto = incident.response?.veto;
    if (
      incident.state !== "veto" ||
      !veto ||
      incident.owner !== DEMO_INCIDENT_AUTHOR
    )
      continue;
    if (Date.parse(veto.deadline) - now > MINUTE_MS) continue;
    const startedAt = iso(now);
    const deadline = iso(now + DEMO_VETO_MS);
    await updateIncident(incident.id, (current) => {
      if (!current.response) return current;
      return {
        ...current,
        response: {
          ...current.response,
          veto: { startedAt, deadline },
          next: {
            kind: "veto",
            deadline,
            rule: VETO_RULE,
          },
        },
      };
    });
  }
}

/** Seed once; on later boots only re-arm the veto. Never throws. */
export async function seedDemoIncidents(
  now: number = Date.now(),
): Promise<void> {
  try {
    const existing = (await listSignals()).filter(
      (s) => s.project === DEMO_REPO_ID && s.createdBy === DEMO_INCIDENT_AUTHOR,
    );
    if (existing.length) {
      await rearmDemoVeto(now);
      return;
    }
    const ids = new Map<DemoKey, string>();
    for (const spec of DEMO_SIGNALS) {
      const created = await createSignal(
        {
          name: spec.name,
          project: DEMO_REPO_ID,
          source: spec.source,
          rule: spec.rule,
          severity: spec.severity,
          ...(spec.intervalMs ? { intervalMs: spec.intervalMs } : {}),
        },
        DEMO_INCIDENT_AUTHOR,
      );
      if ("error" in created) {
        console.error(`[demo] signal ${spec.name} refused: ${created.error}`);
        return;
      }
      ids.set(spec.key, created.id);
    }
    // Incidents first, so the engine finds the failing signals covered and
    // opens nothing of its own when the observations land.
    await seedIncidents(ids, now);
    for (const spec of DEMO_SIGNALS)
      await ingestObservations(ids.get(spec.key)!, history(spec, now), now);
    console.log(`[demo] incidents seeded: ${DEMO_SIGNALS.length} signals`);
  } catch (e) {
    console.error("[demo] incident seed failed:", e);
  }
}
