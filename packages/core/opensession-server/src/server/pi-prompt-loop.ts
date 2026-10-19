import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { audit } from "./audit";
import { wrapContext } from "./prompt-context";
import { EMPTY_REPLY_RETRY_PROMPT } from "./auto-continue";
import type { ImageInput, StreamEvent } from "./run-events";
import { piImages } from "./pi-transcript";
import type { PiRunHandle } from "./pi-run-registry";
import type { PiAccountWalk } from "./pi-account-walk";
import type { PiSteerController } from "./pi-steer-controller";
import type { PiEventOutcome, PiEventPump } from "./pi-events";

/** How session.prompt (or its last continuation) settled. */
export interface PiPromptOutcome {
  ok: boolean;
  error?: unknown;
}

export interface PiPromptDriveInput {
  session: AgentSession;
  pump: PiEventPump;
  /** The run's registry handle; its steer surface closes when the prompt
   *  settles. */
  handle: PiRunHandle;
  signal: AbortSignal;
  steering: PiSteerController;
  /** The event mapper's outcome, read at call time. */
  outcome: PiEventOutcome;
  promptForEngine: string;
  walk: PiAccountWalk;
  images: ImageInput[] | undefined;
  unsubscribe: () => void;
  auditBase: Record<string, unknown>;
}

/**
 * Drive one pi prompt to its end: start it (unless already cancelled), yield
 * every pumped event, drain late steers (at most twice), retry an empty
 * final completion once, then unsubscribe. Returns how the prompt settled
 * and how many empty-finish retries ran.
 */
export async function* drivePiPrompt(
  input: PiPromptDriveInput,
): AsyncGenerator<
  StreamEvent,
  { result: PiPromptOutcome; emptyFinishRetries: number }
> {
  const {
    session,
    pump,
    handle,
    signal,
    steering,
    outcome,
    promptForEngine,
    walk,
    images,
    unsubscribe,
    auditBase,
  } = input;
  // prompt() resolves after the full accepted run (steers + retries
  // included) — the authoritative end; pre-flight failures reject. A cancel
  // that landed before this point must not start the run at all —
  // session.abort() only stops a run already in flight.
  let promptOutcome: PiPromptOutcome | null = null;
  const settlePrompt = (settled: PiPromptOutcome) => {
    promptOutcome = settled;
    // Same tick as the outcome, BEFORE the pump wakes: steers accepted from
    // here on could only queue into a settling/soon-disposed session, so
    // steerPiRun must return false and let run-session queue them for the
    // next turn instead.
    handle.steer = undefined;
    pump.wake();
  };
  if (signal.aborted) {
    promptOutcome = { ok: true };
    handle.steer = undefined;
  } else {
    void session
      .prompt(promptForEngine, {
        images: walk.continuation ? undefined : piImages(images),
        expandPromptTemplates: false,
      })
      .then(
        () => settlePrompt({ ok: true }),
        (e: unknown) => settlePrompt({ ok: false, error: e }),
      );
  }

  // Tail-race drain budget: a steer accepted between the agent loop's final
  // steering poll and settlePrompt sits in the in-memory queue that
  // dispose() would discard — while steerPiRun already returned true and
  // run-session dropped the message from its own queue. Drive it through a
  // real continuation run (the same agent.continue() the SDK uses for
  // agent_end-queued messages; the constructor-lifetime event subscription
  // keeps streaming/persisting) instead of losing it.
  let steerDrains = 0;
  // One bounded continuation for an empty final completion (see
  // lastAssistantRenderableBlocks). The nudge is fenced like every other
  // injection, so the transcript never shows it as a user bubble.
  let emptyFinishRetries = 0;
  while (true) {
    while (pump.size) yield pump.take()!;
    if (promptOutcome) {
      if (steering.engineQueueDepth > 0) {
        // An accepted steer is still being staged, so pi's queue count is
        // not final yet. steerPiRun already told the caller "accepted";
        // finishing now would drop it silently. Wait for the chain, then
        // re-read everything (more steers may have joined meanwhile).
        await steering.engineQueue;
        continue;
      }
      if (
        promptOutcome.ok &&
        !signal.aborted &&
        session.pendingMessageCount > 0 &&
        steerDrains < 2
      ) {
        steerDrains++;
        promptOutcome = null;
        void Promise.resolve()
          .then(() => session.agent.continue())
          .then(
            () => settlePrompt({ ok: true }),
            (e: unknown) => settlePrompt({ ok: false, error: e }),
          );
        continue;
      }
      if (
        promptOutcome.ok &&
        !signal.aborted &&
        emptyFinishRetries < 1 &&
        outcome.lastStopReason === "stop" &&
        outcome.lastAssistantRenderableBlocks === 0
      ) {
        emptyFinishRetries++;
        const notice =
          "Model returned an empty response — asking it once more to finish its reply";
        pump.push({ type: "runner_notice", text: notice });
        promptOutcome = null;
        void session
          .prompt(wrapContext(EMPTY_REPLY_RETRY_PROMPT, "auto-continue"), {
            expandPromptTemplates: false,
          })
          .then(
            () => settlePrompt({ ok: true }),
            (e: unknown) => settlePrompt({ ok: false, error: e }),
          );
        continue;
      }
      break;
    }
    await pump.wait();
  }
  while (pump.size) yield pump.take()!;
  unsubscribe();
  if (steering.pendingCount > 0) {
    // Accepted but never delivered (drain budget exhausted or the run
    // failed): no transcript line was written, so on the failure paths the
    // receipt survives as the recovery affordance; on a done terminal the
    // loss is at least audited instead of silent.
    audit({
      ...auditBase,
      direction: "out",
      kind: "steer_undelivered",
      count: steering.pendingCount,
    });
  }
  const result: PiPromptOutcome = promptOutcome!;
  return { result, emptyFinishRetries };
}
