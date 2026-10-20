// Revocation of incident agents' credential grants when their access ends:
// an incident that closes or pauses, or access settings that narrow. Work
// runs on one promise chain so a listener never blocks the write that fired
// it, and a failure is logged rather than thrown. Listeners attach only in
// startIncidentAccess(); importing this module has no effect.
import { isTerminalIncidentState } from "../../../shared/incidents";
import {
  ensureKeychainLoaded,
  listIncidentGrants,
  revokeIncidentGrants,
} from "../../keychain";
import { onIncidentChange } from "../incident-store";
import { reconcileIncidentGrants } from "./credentials";
import { onIncidentAccessChange } from "./settings-store";

let started = false;
let chain: Promise<void> = Promise.resolve();

function enqueue(label: string, work: () => Promise<unknown>): void {
  chain = chain.then(work).then(
    () => {},
    (error: unknown) => {
      console.warn(
        `[incidents] access ${label} failed:`,
        error instanceof Error ? error.message : error,
      );
    },
  );
}

/** Start revoking grants when incidents close or pause, or access narrows. */
export function startIncidentAccess(): void {
  if (started) return;
  started = true;
  onIncidentChange((next, previous) => {
    if (previous?.state === next.state) return;
    const reason = isTerminalIncidentState(next.state)
      ? "Incident closed"
      : next.state === "paused"
        ? "Incident agents paused"
        : null;
    if (!reason) return;
    enqueue("revocation", () =>
      revokeIncidentGrants({ incidentId: next.id }, reason),
    );
  });
  onIncidentAccessChange((project) => {
    enqueue("reconciliation", () => reconcileIncidentGrants(project));
  });
  // Grants that outlived their access while the server was down.
  enqueue("startup reconciliation", async () => {
    await ensureKeychainLoaded();
    const projects = new Set(
      listIncidentGrants().flatMap((g) =>
        g.incident ? [g.incident.project] : [],
      ),
    );
    for (const project of projects) await reconcileIncidentGrants(project);
  });
}

/** Resolves when queued revocations and reconciliations are done. */
export async function __incidentAccessIdleForTest(): Promise<void> {
  for (;;) {
    // Change listeners run on their own microtasks; let them enqueue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = chain;
    await current;
    if (current === chain) return;
  }
}
