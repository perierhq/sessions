import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describeUsageLimitReset } from "./runner-shared";
import { formatAnthropicReset } from "./anthropic-rate-limit";
import type { TranscriptEntry } from "./types";
import type { StreamEvent } from "./run-events";
import { PI_PROVIDER } from "./pi-common";
import { piErrorContent } from "./pi-usage-limit";
import type { PiTurnLedger } from "./pi-turn-ledger";
import { piSystemEntry, type PiEventOutcome } from "./pi-events";
import type { PiPromptOutcome } from "./pi-prompt-loop";

const PROVIDER = PI_PROVIDER;

/** The visible chip for a turn that ended on an empty completion. */
export function piEmptyReplyEntry(emptyFinishRetries: number): TranscriptEntry {
  return piSystemEntry(
    "The model ended this turn with an empty response (no text or tool calls)" +
      (emptyFinishRetries > 0
        ? " and an automatic retry produced nothing too. Send another message to continue."
        : "."),
  );
}

/** The terminal a settled prompt ends with, whether its failure looks like a
 *  usage limit, and the failure text ("" on done). Sidelining and rotation
 *  are the caller's. */
export function piOutcomeTerminal(input: {
  result: PiPromptOutcome;
  outcome: PiEventOutcome;
  isUsageLimit: (message: string) => boolean;
  providerID: string;
  model: string;
  ledger: PiTurnLedger;
  session: AgentSession;
}): { terminal: StreamEvent; usageLimit: boolean; message: string } {
  const {
    result: failed,
    outcome,
    isUsageLimit,
    providerID,
    model,
    ledger,
    session,
  } = input;
  let terminal: StreamEvent;
  let terminalUsageLimit = false;
  let terminalMessage = "";
  if (!failed.ok) {
    const message = String((failed.error as Error)?.message || failed.error);
    terminalMessage = message;
    const usageLimit = isUsageLimit(message);
    terminalUsageLimit = usageLimit;
    terminal = {
      type: "error",
      content: piErrorContent(message, providerID),
      provider: PROVIDER,
      model,
      ...ledger.usageField(),
      ...(usageLimit ? { usageLimitExhausted: true } : {}),
    };
  } else if (
    outcome.lastStopReason === "error" ||
    outcome.lastStopReason === "aborted"
  ) {
    const message =
      outcome.lastErrorMessage ||
      `run ended with stopReason ${outcome.lastStopReason}`;
    terminalMessage = message;
    const usageLimit = isUsageLimit(message);
    terminalUsageLimit = usageLimit;
    terminal = {
      type: "error",
      content: piErrorContent(message, providerID),
      provider: PROVIDER,
      model,
      ...ledger.usageField(),
      ...(usageLimit ? { usageLimitExhausted: true } : {}),
    };
  } else {
    terminal = {
      type: "done",
      sessionId: ledger.piSessionId,
      result: session.getLastAssistantText() || undefined,
      provider: PROVIDER,
      model,
      ...ledger.usageField(),
    };
  }
  return {
    terminal,
    usageLimit: terminalUsageLimit,
    message: terminalMessage,
  };
}

/** The usage-limit terminal reworded for a Claude pool with no account left
 *  to serve the turn. The account's own message stays inside the sentence,
 *  so the usage-limit classifiers downstream still match it. */
export function piPoolDryTerminal(input: {
  terminal: StreamEvent;
  accountName: string;
  refusal: string;
  resetAt: number | undefined;
  terminalMessage: string;
  modelID: string;
  providerID: string;
}): StreamEvent {
  const {
    terminal,
    accountName,
    refusal,
    resetAt,
    terminalMessage,
    modelID,
    providerID,
  } = input;
  console.warn(
    `[pi-runner] usage limit on Claude account "${accountName}" ` +
      `(${modelID}) and no other account can serve it: ${refusal}`,
  );
  const reset =
    describeUsageLimitReset(terminalMessage) ??
    (resetAt !== undefined ? formatAnthropicReset(resetAt) : undefined);
  return {
    ...terminal,
    content: piErrorContent(
      `every Claude account is usage-limited for ${modelID}` +
        (reset ? `, the soonest resets ${reset}` : "") +
        `. Last account tried ("${accountName}") said: ${terminalMessage}`,
      providerID,
    ),
  };
}

/** The error terminal for a throw out of the run body. */
export function piCaughtTerminal(input: {
  message: string;
  usageLimit: boolean;
  providerID: string;
  model: string;
  ledger: PiTurnLedger;
}): StreamEvent {
  const { message, usageLimit, providerID, model, ledger } = input;
  return {
    type: "error",
    content: piErrorContent(message, providerID),
    provider: PROVIDER,
    model,
    ...ledger.usageField(),
    ...(usageLimit ? { usageLimitExhausted: true } : {}),
  };
}
