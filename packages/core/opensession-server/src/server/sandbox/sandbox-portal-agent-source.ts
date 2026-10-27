/**
 * The Sandbox Portal relay sidecar's source, as copied into session scratch
 * on every relay launch (portal-supervisor.ts ensureRemoteSandboxPortalAgent).
 *
 * Imported as text so it is inlined wherever this module goes: a release is
 * a compiled binary with no repository tree beside it, where a read from
 * `src/runner-host/` at run time fails. Same pattern as
 * sandbox-agent-source.ts.
 */
// @ts-expect-error TypeScript types a module import, not Bun's text import.
import source from "../../runner-host/sandbox-portal-agent.ts" with { type: "text" };

const text: string = source;

export function sandboxPortalAgentSource(): string {
  return text;
}
