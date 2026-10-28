/**
 * What the owner reads before approving a keychain ask: the ceiling each
 * credential's grant inherits, and the choices with what each permits.
 * Shared by the card in the asking session and Settings → Account.
 */
import {
  ceilingSummary,
  type CeilingSummary,
} from "../../shared/keychain-ceiling";
import type { SessionKeychainAsk } from "./keychain-ask-store";

export type AskDecision = "once" | "standing" | "run" | "release";

export interface AskChoice {
  decision: AskDecision;
  label: string;
  /** What approving this way permits, in one line. */
  terms: string;
  primary: boolean;
}

/** The ceiling of each API credential in the ask. A login has none: its
 *  password is released, not called through the broker. */
export function askCeilings(ask: SessionKeychainAsk): CeilingSummary[] {
  return ask.credentials
    .filter((c) => c.kind !== "login")
    .map((c) => ceilingSummary(c));
}

const ONCE: Omit<AskChoice, "primary"> = {
  decision: "once",
  label: "Allow once",
  terms: "One call, within the next hour",
};
const STANDING: Omit<AskChoice, "primary"> = {
  decision: "standing",
  label: "Allow 7 days",
  terms: "Any number of calls for 7 days",
};

/**
 * The approvals offered, the primary one last. The mode the agent asked for
 * is primary, except that a credential with no method or path limit makes
 * a single call the primary: seven days of anything is not the default.
 */
export function askChoices(ask: SessionKeychainAsk): AskChoice[] {
  if (ask.requestedMode === "release")
    return [
      {
        decision: "release",
        label: "Release password",
        terms: "The agent reads the password once, from a short-lived file",
        primary: true,
      },
    ];
  if (ask.run)
    return [
      {
        decision: "run",
        label: "Allow run",
        terms: `This script, up to ${ask.run.maxCalls.toLocaleString("en-US")} calls, while it runs`,
        primary: true,
      },
    ];
  const open = askCeilings(ask).some((c) => c.open);
  const order =
    ask.requestedMode === "standing" && !open
      ? [ONCE, STANDING]
      : [STANDING, ONCE];
  return order.map((choice, index) => ({
    ...choice,
    primary: index === order.length - 1,
  }));
}
