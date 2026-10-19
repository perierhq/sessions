import { stateDir } from "./paths";

export const PI_PROVIDER = "pi" as const;

/** State root: server-owned agentDir, per-unified-session pi session dirs,
 *  and the smoke-turn scratch cwd. Never ~/.pi. */
export const PI_STATE_DIR = stateDir("pi");

export function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
