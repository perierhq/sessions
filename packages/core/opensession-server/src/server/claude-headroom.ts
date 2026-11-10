/**
 * Whether the Claude account pool has room for unattended background work
 * (project leads and other goals) right now.
 *
 * The instance runs on Claude subscriptions: each account has a 5-hour and
 * a weekly usage window, polled by claude-accounts.ts into the shared usage
 * file. Background wakes wait while every shared account is close to a
 * limit, so they never take the last of the capacity the owner's own
 * sessions need. Interactive turns never call this.
 *
 * An account has headroom when it isn't sidelined (the sideline file) and
 * its windows leave at least BACKGROUND_FIVE_HOUR_HEADROOM and
 * BACKGROUND_WEEKLY_HEADROOM percent: utilization at most 80% and 90%. A
 * window that was never reported, or has reset since the last poll, counts
 * as room, as the picker treats it. Personal accounts (with an owner) don't
 * count: background runs have no user, so they run on the shared pool. With
 * no shared accounts at all the answer is true: nothing here to protect.
 *
 * Reads the files asynchronously; never on the gateway's synchronous path.
 */
import { readFile } from "node:fs/promises";
import {
  claudeAccountsStorePath,
  claudeAccountsUsagePath,
} from "./claude-account-shared-state";
import type { AccountUsage } from "./claude-accounts";

export const BACKGROUND_FIVE_HOUR_HEADROOM = 20;
export const BACKGROUND_WEEKLY_HEADROOM = 10;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

function utilization(
  w: { utilization: number | null; resetsAt: string | null } | null | undefined,
  now: number,
): number {
  if (!w) return 0;
  if (w.resetsAt) {
    const t = Date.parse(w.resetsAt);
    if (Number.isFinite(t) && t <= now) return 0;
  }
  return w.utilization ?? 0;
}

function sidelined(
  until: Record<string, unknown>,
  id: string,
  now: number,
): boolean {
  return [id, `${id}#credits`, `${id}#oauth-refused`].some((key) => {
    const t = until[key];
    return typeof t === "number" && t > now;
  });
}

/** True when at least one shared Claude account has headroom above the
 *  background thresholds (see the module comment). */
export async function backgroundHeadroomOk(
  now: number = Date.now(),
): Promise<boolean> {
  const storePath = claudeAccountsStorePath();
  const [store, usageFile, state] = await Promise.all([
    readJson(storePath),
    readJson(claudeAccountsUsagePath()),
    readJson(storePath.replace(/\.json$/, "-state.json")),
  ]);
  const accounts = (store as { accounts?: unknown } | null)?.accounts;
  const shared = Array.isArray(accounts)
    ? accounts.filter(
        (a): a is { id: string } => !!a && typeof a.id === "string" && !a.owner,
      )
    : [];
  if (!shared.length) return true;
  const usage = ((usageFile as { usage?: Record<string, AccountUsage> } | null)
    ?.usage ?? {}) as Record<string, AccountUsage>;
  const until = ((state as { exhaustedUntil?: Record<string, unknown> } | null)
    ?.exhaustedUntil ?? {}) as Record<string, unknown>;
  return shared.some((a) => {
    if (sidelined(until, a.id, now)) return false;
    const u = Object.hasOwn(usage, a.id) ? usage[a.id] : undefined;
    return (
      utilization(u?.fiveHour, now) <= 100 - BACKGROUND_FIVE_HOUR_HEADROOM &&
      utilization(u?.sevenDay, now) <= 100 - BACKGROUND_WEEKLY_HEADROOM
    );
  });
}
