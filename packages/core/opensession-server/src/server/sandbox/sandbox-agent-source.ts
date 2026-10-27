/**
 * The Sandbox agent's source, as uploaded into every Sandbox that runs one
 * (agent-driver.ts launchSandboxAgent).
 *
 * Imported as text so it is inlined wherever this module goes: a release is
 * a compiled binary with no repository tree beside it, where a read from
 * `src/runner-host/` at run time fails.
 */
// @ts-expect-error TypeScript types a module import, not Bun's text import.
import source from "../../runner-host/sandbox-agent.ts" with { type: "text" };

const text: string = source;

export async function sandboxAgentSource(): Promise<string> {
  return text;
}
