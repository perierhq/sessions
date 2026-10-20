// The proof contract (spec 3.5): the baseline fails and the candidate
// passes, measured with the incident's own signal from production's own
// egress (the signal's `runOn` Runner), or with a check the candidate
// declares. Sessions measures here; the verifier judges. A candidate check
// is the signal's request with the agent's changes, on the signal's origin
// only, so an agent can never aim the production Runner anywhere else.
import type {
  CandidateCheck,
  ProofResult,
  ProofSample,
} from "../../../shared/incident-response";
import type {
  HttpSource,
  Observation,
  Signal,
  SignalEvaluation,
} from "../../../shared/incidents";
import { restoreRedactedSource } from "../signal-validation";
import { type SourceRun, runSignalSource } from "../sources";

export const PROOF_SAMPLES = 3;
export const PROOF_SPACING_MS = 2_000;

export interface ProofDeps {
  runSource: (signal: Signal) => Promise<SourceRun>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

type Baseline = ProofResult["baseline"];
type Candidate = ProofResult["candidate"];

const POLLED = new Set<Signal["source"]["kind"]>(["http", "expiry"]);
const METHOD_REFUSED =
  "A request check must use GET or HEAD unless the signal sends that method to that path";

function toSample(o: Observation): ProofSample {
  return { at: o.at, result: o.result, detail: o.detail };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "Failed";
}

async function sampleOnce(signal: Signal, d: ProofDeps): Promise<ProofSample> {
  try {
    const run = await d.runSource(signal);
    const main = run.observations.find((o) => o.lane === undefined);
    if (main) return toSample(main);
    return {
      at: new Date(d.now()).toISOString(),
      result: "unknown",
      detail: "No observation",
    };
  } catch (error) {
    return {
      at: new Date(d.now()).toISOString(),
      result: "unknown",
      detail: errorMessage(error),
    };
  }
}

async function samples(signal: Signal, d: ProofDeps): Promise<ProofSample[]> {
  const out: ProofSample[] = [];
  for (let i = 0; i < PROOF_SAMPLES; i++) {
    if (i > 0) await d.sleep(PROOF_SPACING_MS);
    out.push(await sampleOnce(signal, d));
  }
  return out;
}

function count(list: ProofSample[], result: ProofSample["result"]): number {
  return list.filter((s) => s.result === result).length;
}

function majority(list: ProofSample[]): Baseline["verdict"] {
  const needed = Math.floor(PROOF_SAMPLES / 2) + 1;
  if (count(list, "fail") >= needed) return "fails";
  if (count(list, "ok") >= needed) return "passes";
  return "unclear";
}

async function baselineOf(
  input: {
    signal: Signal;
    evaluation: SignalEvaluation | null;
    recent: Observation[];
  },
  d: ProofDeps,
): Promise<Baseline> {
  if (POLLED.has(input.signal.source.kind)) {
    const list = await samples(input.signal, d);
    return { samples: list, verdict: majority(list) };
  }
  // A pushed signal cannot be run again: its evaluation decides.
  const state = input.evaluation?.state;
  return {
    samples: input.recent
      .filter((o) => o.lane === undefined)
      .slice(-PROOF_SAMPLES)
      .map(toSample),
    verdict:
      state === "failing" || state === "slow"
        ? "fails"
        : state === "ok"
          ? "passes"
          : "unclear",
  };
}

function urlParts(raw: string): { origin: string; path: string } | null {
  try {
    const url = new URL(raw);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return null;
  }
}

/** Why a request check may not run from the signal's Runner, or the
 *  candidate signal it runs as. */
function candidateSignal(
  signal: Signal,
  check: Extract<CandidateCheck, { kind: "request" }>,
): Signal | { refused: string } {
  if (signal.source.kind !== "http")
    return { refused: "A request check needs an http signal" };
  const from = urlParts(signal.source.url);
  const to = urlParts(check.source.url);
  if (!from || !to || from.origin !== to.origin)
    return { refused: "The candidate check leaves the signal's origin" };
  const method = check.source.method ?? "GET";
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    ((signal.source.method ?? "GET") !== method || from.path !== to.path)
  )
    return { refused: METHOD_REFUSED };
  const restored = restoreRedactedSource(signal.source, check.source);
  if ("error" in restored) return { refused: restored.error };
  return { ...signal, source: restored.source as HttpSource };
}

async function candidateOf(
  signal: Signal,
  check: CandidateCheck,
  d: ProofDeps,
): Promise<Candidate> {
  if (check.kind === "after-deploy")
    return { kind: "after-deploy", samples: [], verdict: "after-deploy" };
  const candidate = candidateSignal(signal, check);
  if ("refused" in candidate)
    return {
      kind: "request",
      samples: [],
      verdict: "unclear",
      refused: candidate.refused,
    };
  const list = await samples(candidate, d);
  return {
    kind: "request",
    samples: list,
    verdict:
      count(list, "fail") > 0
        ? "fails"
        : count(list, "ok") === list.length
          ? "passes"
          : "unclear",
  };
}

/** Measures the baseline and the candidate. Never throws. */
export async function runProof(
  input: {
    signal: Signal;
    evaluation: SignalEvaluation | null;
    recent: Observation[];
    check: CandidateCheck;
    round: number;
  },
  deps: Partial<ProofDeps> = {},
): Promise<ProofResult> {
  const d: ProofDeps = {
    runSource: deps.runSource ?? ((signal) => runSignalSource(signal)),
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
    now: deps.now ?? Date.now,
  };
  const at = new Date(d.now()).toISOString();
  const baseline = await baselineOf(input, d);
  const candidate = await candidateOf(input.signal, input.check, d);
  return {
    round: input.round,
    at,
    ...(input.signal.runOn ? { runner: input.signal.runOn } : {}),
    baseline,
    candidate,
  };
}
