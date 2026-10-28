/**
 * This machine (container)'s sandbox image after an update, as the running
 * server reports it (`/api/health` → `sandboxImage`).
 *
 * A release that changes the image's Containerfile names a new image. The
 * server builds it on its own at boot, in the background, and a session that
 * starts meanwhile waits for it (podman-image-rollout.ts). `opensession
 * update` and `opensession doctor` only say where that stands.
 */

import { dim, info, ok, warn } from "./ui";

export interface SandboxImageHealth {
  tag: string;
  state: "current" | "building" | "failed";
  at?: string;
  error?: string;
}

export type SandboxImageLine = {
  level: "ok" | "info" | "warn";
  message: string;
  detail?: string;
};

const LABEL = "This machine (container) image";

/** The line to print, or undefined when the server has nothing to say (no
 *  qualified container connection). */
export function sandboxImageLine(
  health: unknown,
): SandboxImageLine | undefined {
  if (!health || typeof health !== "object") return undefined;
  const { tag, state, error } = health as Partial<SandboxImageHealth>;
  if (typeof tag !== "string") return undefined;
  if (state === "current")
    return { level: "ok", message: `${LABEL} is current`, detail: tag };
  if (state === "building")
    return {
      level: "info",
      message: `${LABEL}: building ${tag} for this release in the background`,
      detail:
        "sessions that start meanwhile wait for it; progress in Workspace → Sandboxes",
    };
  if (state === "failed")
    return {
      level: "warn",
      message: `${LABEL}: building ${tag} failed`,
      detail: `${error ? `${error}; ` : ""}the next session start tries again, or Test again in Workspace → Sandboxes`,
    };
  return undefined;
}

/** Print it. Returns whether it was a warning. */
export function reportSandboxImage(health: unknown): boolean {
  const line = sandboxImageLine(health);
  if (!line) return false;
  if (line.level === "ok") ok(line.message, line.detail);
  else if (line.level === "warn") warn(line.message, line.detail);
  else info(`${line.message}${line.detail ? ` ${dim(line.detail)}` : ""}`);
  return line.level === "warn";
}

/**
 * After an update's restart: when a container connection is qualified, wait
 * briefly for the new server's first image check and report it. Never fails
 * the update; the build goes on in the server either way.
 */
export async function reportSandboxImageAfterRestart(
  base: string,
  deps: {
    qualified?: () => Promise<boolean>;
    fetchHealth?: (base: string) => Promise<unknown>;
    sleep?: (ms: number) => Promise<unknown>;
    waitMs?: number;
  } = {},
): Promise<void> {
  const qualified =
    deps.qualified ??
    (async () => {
      const { sandboxConnectionReady } =
        await import("../../packages/core/opensession-server/src/server/sandbox/connections");
      return sandboxConnectionReady("podman");
    });
  const fetchHealth =
    deps.fetchHealth ??
    (async (url: string) => {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? ((await res.json()) as { sandboxImage?: unknown }) : null;
    });
  const sleep = deps.sleep ?? Bun.sleep;
  try {
    if (!(await qualified())) return;
  } catch {
    return;
  }
  const deadline = Date.now() + (deps.waitMs ?? 20_000);
  for (;;) {
    const health = (await fetchHealth(base).catch(() => null)) as {
      sandboxImage?: unknown;
    } | null;
    if (sandboxImageLine(health?.sandboxImage)) {
      reportSandboxImage(health?.sandboxImage);
      return;
    }
    if (Date.now() >= deadline) return;
    await sleep(1000);
  }
}
