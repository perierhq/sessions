/**
 * Whether a provider has room for unattended background work (project
 * leads and other goals) right now. Interactive turns never call this.
 *
 * The question is asked per route (`pi/<provider>/<model>`, as routeModel
 * gives it) and answered by the first headroom source that serves the
 * route. A source reads whatever the instance knows about the accounts
 * behind that route; today there is one:
 *
 * - `localClaudeAccounts` serves `pi/anthropic/*`: the Claude account pool
 *   this instance calls directly. Each account has a 5-hour and a weekly
 *   usage window, polled by claude-accounts.ts into the shared usage file.
 *
 * When the instance moves Claude behind a self-hosted hub (the owner's
 * subscriptions behind one API), a `hub` source takes the same place: it
 * serves the routes the hub carries and reports headroom from the hub's
 * usage endpoint. A route no source serves, or a hub without a usage
 * endpoint, is allowed: nothing here can tell it is low.
 *
 * Whatever the source says, a provider that refused a background run with
 * a usage limit or a 429 (classified by pi-usage-limit.ts) holds every
 * background goal on it for USAGE_LIMIT_BACKOFF_MS. That is the only
 * signal a source-less route has, and it keeps a pool that just ran dry
 * from being asked again on the next tick. The backoff lives in this
 * process only; a restart forgets it.
 *
 * localClaudeAccounts decides on the shared accounts it has data for:
 * those that report a usage window or are sidelined (the sideline file,
 * account-wide or for this route's model). One of them that isn't
 * sidelined and leaves at least BACKGROUND_FIVE_HOUR_HEADROOM and
 * BACKGROUND_WEEKLY_HEADROOM percent (utilization at most 80% and 90%) is
 * room. A window that has reset since the last poll counts as room, as the
 * picker treats it. Accounts with no data don't count either way, and when
 * none has data the source has no answer, so the work is allowed.
 * Personal accounts (with an owner) don't count: background runs have no
 * user, so they run on the shared pool.
 *
 * Reads the files asynchronously; never on the gateway's synchronous path.
 */
import { readFile } from "node:fs/promises";
import {
  claudeAccountsSidelinePath,
  claudeAccountsStorePath,
  claudeAccountsUsagePath,
} from "./claude-account-shared-state";
import type { AccountUsage } from "./claude-accounts";

export const BACKGROUND_FIVE_HOUR_HEADROOM = 20;
export const BACKGROUND_WEEKLY_HEADROOM = 10;
/** How long background goals on a provider wait after it refused a run
 *  with a usage limit. */
export const USAGE_LIMIT_BACKOFF_MS = 30 * 60_000;

/** What knows the usage of the accounts behind some routes. */
export interface HeadroomSource {
  /** Whose accounts, for the waiting reason: "Claude accounts". */
  readonly label: string;
  /** Whether this source answers for the route (`pi/<provider>/<model>`). */
  serves(route: string): boolean;
  /** true: room for background work; false: near the limits; null: no
   *  data to decide on, so the work is allowed. */
  headroom(route: string, now: number): Promise<boolean | null>;
}

export type HeadroomVerdict = { ok: true } | { ok: false; reason: string };

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

type Window = { utilization: number | null; resetsAt: string | null };

function reported(w: Window | null | undefined): w is Window {
  return !!w && typeof w.utilization === "number";
}

function utilization(w: Window | null | undefined, now: number): number {
  if (!reported(w)) return 0;
  if (w.resetsAt) {
    const t = Date.parse(w.resetsAt);
    if (Number.isFinite(t) && t <= now) return 0;
  }
  return w.utilization ?? 0;
}

function sidelined(
  until: Record<string, unknown>,
  id: string,
  model: string,
  now: number,
): boolean {
  const keys = [id, `${id}#credits`, `${id}#oauth-refused`];
  if (model) keys.push(`${id}:${model}`);
  return keys.some((key) => {
    const t = until[key];
    return typeof t === "number" && t > now;
  });
}

const ANTHROPIC_ROUTE = "pi/anthropic/";

/** The Claude account pool this instance calls directly. */
export const localClaudeAccounts: HeadroomSource = {
  label: "Claude accounts",
  serves: (route) => route.startsWith(ANTHROPIC_ROUTE),
  async headroom(route, now) {
    const model = route.slice(ANTHROPIC_ROUTE.length);
    const [store, usageFile, state] = await Promise.all([
      readJson(claudeAccountsStorePath()),
      readJson(claudeAccountsUsagePath()),
      readJson(claudeAccountsSidelinePath()),
    ]);
    const accounts = (store as { accounts?: unknown } | null)?.accounts;
    const shared = Array.isArray(accounts)
      ? accounts.filter(
          (a): a is { id: string } =>
            !!a && typeof a.id === "string" && !a.owner,
        )
      : [];
    const usage = ((
      usageFile as { usage?: Record<string, AccountUsage> } | null
    )?.usage ?? {}) as Record<string, AccountUsage>;
    const until = ((
      state as { exhaustedUntil?: Record<string, unknown> } | null
    )?.exhaustedUntil ?? {}) as Record<string, unknown>;
    let known = false;
    for (const a of shared) {
      const u = Object.hasOwn(usage, a.id) ? usage[a.id] : undefined;
      if (sidelined(until, a.id, model, now)) {
        known = true;
        continue;
      }
      if (!reported(u?.fiveHour) && !reported(u?.sevenDay)) continue;
      known = true;
      if (
        utilization(u?.fiveHour, now) <= 100 - BACKGROUND_FIVE_HOUR_HEADROOM &&
        utilization(u?.sevenDay, now) <= 100 - BACKGROUND_WEEKLY_HEADROOM
      )
        return true;
    }
    return known ? false : null;
  },
};

let sources: readonly HeadroomSource[] = [localClaudeAccounts];
/** Until when each provider is held after a usage limit. */
const backoffUntil = new Map<string, number>();

export function __setHeadroomSourcesForTest(
  list: readonly HeadroomSource[] | undefined,
): void {
  sources = list ?? [localClaudeAccounts];
  backoffUntil.clear();
}

/** The provider segment of a route: `anthropic` for `pi/anthropic/x`. */
function routeProvider(route: string): string {
  return route.split("/")[1] ?? route;
}

/** A background run on `route` was refused with a usage limit: hold the
 *  route's provider for USAGE_LIMIT_BACKOFF_MS. */
export function noteBackgroundUsageLimit(
  route: string,
  now: number = Date.now(),
): void {
  backoffUntil.set(routeProvider(route), now + USAGE_LIMIT_BACKOFF_MS);
}

/** Whether background work on `route` may start now, and why not. */
export async function backgroundHeadroom(
  route: string,
  now: number = Date.now(),
): Promise<HeadroomVerdict> {
  const provider = routeProvider(route);
  const held = backoffUntil.get(provider);
  if (held !== undefined) {
    if (held > now)
      return {
        ok: false,
        reason: "The last background run hit a usage limit",
      };
    backoffUntil.delete(provider);
  }
  const source = sources.find((s) => s.serves(route));
  if (!source) return { ok: true };
  if ((await source.headroom(route, now)) === false)
    return {
      ok: false,
      reason: `Your ${source.label} are near their limits`,
    };
  return { ok: true };
}
