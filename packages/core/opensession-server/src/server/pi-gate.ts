import {
  INTERACTIVE_KINDS,
  baseJournalKind,
  isUnattendedKind,
} from "./run-policy";

// ── Gate ─────────────────────────────────────────────────────────────────────

// Armed only inside runPiSmokeTurn (a counter, so overlapping smoke calls
// can't disarm each other). The "pi-smoke" kind passes the gate only while
// armed — request/automation data can name the kind but never arm the bypass.
let smokeGateBypass = 0;

/** Arm the "pi-smoke" gate bypass for one smoke turn. The returned disarm is
 *  idempotent, so a double call can't disarm an overlapping smoke turn. */
export function armPiSmokeGateBypass(): () => void {
  smokeGateBypass++;
  let done = false;
  return () => {
    if (!done) {
      done = true;
      smokeGateBypass--;
    }
  };
}

/** Non-null = the reason this run may not use the pi engine. Same deny-by-
 *  default semantics as previous runnerGateReason: interactive + unattended journal
 *  kinds only, kind-less runs refused. */
export function piGateReason(opts: {
  journal?: { kind?: string };
}): string | null {
  const base = baseJournalKind(opts.journal?.kind);
  if (base === "pi-smoke" && smokeGateBypass > 0) return null;
  if (INTERACTIVE_KINDS.has(base) || isUnattendedKind(base)) return null;
  return base
    ? `The Pi engine is not available to "${base}" runs. Interactive sessions and automations only.`
    : "The Pi engine requires an explicit run kind (journal.kind). Deny by " +
        "default; interactive sessions and automations only.";
}
