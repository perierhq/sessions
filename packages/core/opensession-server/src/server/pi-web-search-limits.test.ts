import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as claudeAccounts from "./claude-accounts";
import { PiAttemptAccounts } from "./pi-account-walk";
import {
  makePiWebSearch,
  webSearchModelId,
  type SearchRuntime,
} from "./pi-web-search";

const haiku = {
  id: "claude-haiku-5-5",
  api: "anthropic-messages",
  provider: "anthropic",
};

const account = {
  id: "claude-acct-1",
  name: "Pool one",
  token: "t",
  createdAt: "2026-01-01T00:00:00.000Z",
} as claudeAccounts.ClaudeAccount;

const throttle =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}';

/** A runtime whose one request fails with `error`; with `status`, it goes
 *  through the request's fetch first and that response carries the unified
 *  rate-limit status header. */
function failingRuntime(error: string, status?: string): SearchRuntime {
  return {
    async completeSimple(_model, _context, options) {
      if (status !== undefined)
        await options?.fetch?.("https://api.anthropic.test/v1/messages");
      return {
        content: [],
        stopReason: "error",
        errorMessage: error,
      };
    },
  };
}

/** One web search whose side request runs on a Claude pool account, wired
 *  the way pi-runner's bind wires it. */
async function searchOnce(error: string, status?: string) {
  const fetchSpy =
    status === undefined
      ? undefined
      : spyOn(globalThis, "fetch").mockResolvedValue(
          new Response("{}", {
            status: 429,
            headers: { "anthropic-ratelimit-unified-status": status },
          }),
        );
  const audits: Record<string, unknown>[] = [];
  const search = makePiWebSearch({
    setting: "auto",
    sessionProvider: "anthropic",
    modelFor: (p) => webSearchModelId(p, undefined),
    bind: async (provider, modelID) => {
      const side = new PiAttemptAccounts({
        walk: { excluded: new Set(), rotate: false },
        providerID: provider,
        modelID,
        opts: { accountId: account.id, accountStrict: true },
        accountUser: undefined,
        affinity: "s",
        claudeSessionKey: undefined,
        speed: "standard" as never,
        auditBase: {},
      });
      side.onEvidence({ pickedClaude: account, sidelineableClaude: account });
      return {
        runtime: failingRuntime(error, status),
        model: haiku,
        usesNativeAnthropic: true,
        accountId: account.id,
        usageLimited: (e) => side.isSideRequestUsageLimit(e),
        sideline: (e) => side.sideline(e),
        onRateLimit: (snapshot) => {
          side.rateLimit = snapshot;
        },
        canRotate: false,
      };
    },
    onAudit: (event) => audits.push(event),
    now: () => 0,
  });
  await expect(search("acme", new AbortController().signal)).rejects.toThrow();
  fetchSpy?.mockRestore();
  return audits;
}

describe("a web side request's usage limit", () => {
  let mark: ReturnType<typeof spyOn> | undefined;
  afterEach(() => mark?.mockRestore());
  const watch = () =>
    (mark = spyOn(claudeAccounts, "markExhausted").mockImplementation(
      () => {},
    ));

  test("a bare 429 throttle without rate-limit headers benches nothing", async () => {
    const marked = watch();
    const audits = await searchOnce(throttle);
    expect(marked).not.toHaveBeenCalled();
    expect(audits[0]?.sidelined).toBeUndefined();
  });

  test("a 429 whose unified status is allowed benches nothing", async () => {
    const marked = watch();
    await searchOnce(throttle, "allowed");
    expect(marked).not.toHaveBeenCalled();
  });

  test("a 429 whose unified status is rejected benches the account", async () => {
    const marked = watch();
    const audits = await searchOnce(throttle, "rejected");
    expect(marked).toHaveBeenCalledTimes(1);
    expect(marked.mock.calls[0]?.[0]).toBe(account.id);
    expect(audits[0]?.sidelined).toBe(true);
  });

  test("an explicit usage-limit message benches the account", async () => {
    const marked = watch();
    await searchOnce("You've hit your limit · resets 3am (UTC)");
    expect(marked).toHaveBeenCalledTimes(1);
    expect(marked.mock.calls[0]?.[0]).toBe(account.id);
  });
});
