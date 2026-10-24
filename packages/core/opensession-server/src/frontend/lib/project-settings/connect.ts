// Waiting for a new sandbox connection's check, so the checklist's connect
// form only makes it the global default once it can run agents.

import type { SandboxConnectionInfo } from "../api/automations";

type Connections = { connections: SandboxConnectionInfo[] };

export interface WaitDeps {
  fetch: () => Promise<Connections>;
  sleep: (ms: number) => Promise<void>;
  /** How often to look again, and how many times before giving up. */
  intervalMs?: number;
  attempts?: number;
}

/** The provider's connection once its check has finished (ready or needing
 *  attention), or `null` if it is still checking after every attempt. */
export async function waitForConnection(
  provider: string,
  first: Connections,
  deps: WaitDeps,
): Promise<SandboxConnectionInfo | null> {
  const find = (r: Connections) =>
    r.connections.find((c) => c.provider === provider);
  let current = find(first);
  const attempts = deps.attempts ?? 60;
  for (let i = 0; i < attempts; i++) {
    if (current && current.state !== "checking") return current;
    await deps.sleep(deps.intervalMs ?? 2_000);
    current = find(await deps.fetch());
  }
  return current && current.state !== "checking" ? current : null;
}
