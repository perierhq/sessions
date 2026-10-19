import { mkdirSync } from "fs";
import { transcript } from "./actor-transcript";
import { PI_STATE_DIR } from "./pi-common";
import { piConfigPath, piEngineEnabled } from "./pi-config";
import { armPiSmokeGateBypass } from "./pi-gate";
import { parsePiModel } from "./pi-model-routing";
import { cancelPiRun } from "./pi-run-registry";
// pi-smoke is a consumer of the runner, like the admin route: pi-runner never
// imports or re-exports this module, so there is no cycle.
import { runPi } from "./pi-runner";
import type { TurnUsage } from "./run-events";

// ── Scripted smoke harness ───────────────────────────────────────────────────

/** Cheap, and any Claude pool account can serve it. */
const SMOKE_MODEL = "pi/anthropic/claude-sonnet-5-5";

export interface PiSmokeResult {
  /** True only for a real turn that reached `done` in time — or an explicit
   *  dryRun probe with the engine enabled. */
  ok: boolean;
  reason?: string;
  /** Throwaway unified session id (`os-test-pi-*`): never gets a session
   *  file, so it can't appear in the UI session list. */
  sessionId: string;
  text: string;
  usage?: TurnUsage;
  durationMs: number;
  enabled: boolean;
  dryRun: boolean;
  engineSessionId?: string;
  model: string;
  eventTypes: string[];
  error?: string;
  timedOut: boolean;
  /** transcript_events rows for the throwaway session after the turn — proves
   *  the store-write path end to end; 0 on dry runs. */
  storeRows: number;
}

/**
 * One tiny scripted turn against a throwaway `os-test-pi-*` session id
 * (mirrors runClaudeDirectSmokeTurn). Config-gated on piEngineEnabled() — with
 * the engine disabled this is a pure dry run: runPi yields its config-gate
 * error before touching a provider or the SDK. The "pi-smoke" journal kind
 * passes the run gate only while the module-scoped bypass is armed here.
 * Never throws; real turns are wall-capped via cancelPiRun.
 */
export async function runPiSmokeTurn(
  opts: {
    dryRun?: boolean;
    timeoutMs?: number;
    prompt?: string;
    model?: string;
  } = {},
): Promise<PiSmokeResult> {
  const prompt = opts.prompt || "Reply with exactly the single word: ok";
  const timeoutMs = Math.max(
    5_000,
    Math.min(opts.timeoutMs ?? 120_000, 600_000),
  );
  // Optional model override so the smoke can exercise either provider path
  // (pi/anthropic via the Claude pool, pi/openai via the codex pool). A provided
  // id that doesn't parse is an explicit error, never a silent fallback —
  // an operator probing pi/openai must not read a default-model turn as
  // proof the openai path works.
  if (opts.model && !parsePiModel(opts.model)) {
    return {
      ok: false,
      enabled: piEngineEnabled(),
      dryRun: !!opts.dryRun,
      reason: `not a pi/<provider>/<model> id: ${opts.model}`,
      sessionId: "",
      model: opts.model,
      eventTypes: [],
      text: "",
      timedOut: false,
      durationMs: 0,
      storeRows: 0,
    };
  }
  const smokeModel = opts.model || SMOKE_MODEL;
  const enabled = piEngineEnabled();
  const sessionId = `os-test-pi-${Date.now().toString(36)}`;
  const started = Date.now();
  const storeRowsFor = async (id: string): Promise<number> => {
    try {
      return await transcript.getLastSeq(id);
    } catch {
      return 0;
    }
  };

  if (enabled && opts.dryRun) {
    return {
      ok: true,
      enabled,
      dryRun: true,
      reason:
        "dry run requested — engine is enabled but no turn was executed (no provider call, no SDK)",
      sessionId,
      model: smokeModel,
      eventTypes: [],
      text: "",
      timedOut: false,
      durationMs: Date.now() - started,
      storeRows: 0,
    };
  }

  const cwd = `${PI_STATE_DIR}/smoke`;
  if (enabled) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {}
  }
  const eventTypes: string[] = [];
  let text = "";
  let error: string | undefined;
  let usage: TurnUsage | undefined;
  let engineSessionId: string | undefined;
  let done = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancelPiRun(sessionId);
  }, timeoutMs);
  const disarm = armPiSmokeGateBypass();
  try {
    for await (const ev of runPi(
      {
        prompt,
        cwd,
        mode: "ask",
        mcpServers: [],
        journal: { osSessionId: sessionId, kind: "pi-smoke" },
      },
      smokeModel,
    )) {
      eventTypes.push(ev.type);
      if (ev.type === "init") engineSessionId = ev.sessionId;
      if (ev.type === "text_chunk") text += ev.text || "";
      if (ev.type === "error") error = ev.content;
      if (ev.type === "done") {
        usage = ev.usage;
        done = true;
      }
    }
  } catch (e) {
    // runPi yields errors rather than throwing; belt-and-braces so the admin
    // route can never blow up off this path.
    error = String((e as Error)?.message || e);
  } finally {
    disarm();
    clearTimeout(timer);
  }
  return {
    ok: done && !timedOut && !error,
    enabled,
    dryRun: !enabled,
    reason: !enabled
      ? `The Pi engine is disabled (${piConfigPath()} missing or enabled:false). The gate error below is the expected dry-run result; no provider or SDK use happened`
      : timedOut
        ? `smoke turn exceeded the ${timeoutMs}ms wall cap and was cancelled`
        : undefined,
    sessionId,
    engineSessionId,
    model: smokeModel,
    eventTypes,
    text,
    error,
    usage,
    timedOut,
    durationMs: Date.now() - started,
    // Store rows prove the write path for REAL turns only; the disabled dry
    // path must not open the transcript store at all (a test/scratch process
    // would otherwise cold-open the live DB just to read a zero).
    storeRows: enabled ? await storeRowsFor(sessionId) : 0,
  };
}
