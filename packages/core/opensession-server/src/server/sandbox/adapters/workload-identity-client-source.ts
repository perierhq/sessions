/**
 * The workload identity client's source, as uploaded into every Sandbox
 * (bootstrap.ts installWorkloadIdentityClient).
 *
 * Imported as text so it is inlined wherever this module goes: a release is
 * a compiled binary with no repository tree beside it, where a read from
 * `scripts/` at run time fails and no remote Sandbox could finish its base
 * runtime.
 */
// @ts-expect-error TypeScript types a module import, not Bun's text import.
import source from "../../../../../../../scripts/workload-identity-client.ts" with { type: "text" };

const text: string = source;

export async function workloadIdentityClientSource(): Promise<string> {
  return text;
}
