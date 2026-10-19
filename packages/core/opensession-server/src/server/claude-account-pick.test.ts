/**
 * pickClaudeAccount: the designation read from model-providers.json, pin and
 * pool semantics over resolveAccount, and the refusal wording, each refusal
 * checked against isPiUsageLimitShape so the runner's fallback walk keys
 * correctly. Config and account stores point at throwaway files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as accounts from "./claude-accounts";
import {
  designatedClaudeAccountIds,
  pickClaudeAccount,
} from "./claude-account-pick";
import { isPiUsageLimitShape } from "./pi-runner";

// The config and store modules read their env seams per call, so setting them
// here (after hoisted imports) is safe; afterAll restores the originals.
const dir = mkdtempSync(join(tmpdir(), "claude-account-pick-"));
const providerConfigFile = join(dir, "model-providers.json");
const accountsFile = join(dir, "accounts.json");
const savedEnv = {
  oc: process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG,
  accounts: process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH,
};

beforeAll(() => {
  process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = providerConfigFile;
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = accountsFile;
});

afterAll(() => {
  for (const [envKey, value] of [
    ["OPENSESSION_MODEL_PROVIDERS_CONFIG", savedEnv.oc],
    ["OPENSESSION_CLAUDE_ACCOUNTS_PATH", savedEnv.accounts],
  ] as const) {
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** [] = no designation (pool mode, the default); a non-empty list designates
 *  accounts through the legacy top-level bridgeAccountIds key. */
function designate(bridgeAccountIds: string[]): void {
  if (bridgeAccountIds.length) {
    writeFileSync(
      providerConfigFile,
      JSON.stringify({ enabled: true, bridgeAccountIds }),
    );
  } else {
    rmSync(providerConfigFile, { force: true });
  }
}

function seedAccounts(
  entries: Array<string | { id: string; owner?: string }>,
): void {
  writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: entries.map((e) => {
        const { id, owner } =
          typeof e === "string" ? { id: e, owner: undefined } : e;
        return {
          id,
          name: id,
          token: `sk-ant-oat01-${id}`,
          createdAt: "2026-01-01T00:00:00.000Z",
          ...(owner ? { owner } : {}),
        };
      }),
    }),
  );
}

const freshUsage = {
  fetchedAt: new Date().toISOString(),
  fiveHour: { utilization: 10, resetsAt: null },
  sevenDay: null,
  extraUsage: null,
};
const maxedUsage = {
  ...freshUsage,
  fiveHour: { utilization: 100, resetsAt: null },
};

describe("designatedClaudeAccountIds", () => {
  test("reads bridge.accounts, falling back to the legacy top-level key", () => {
    writeFileSync(
      providerConfigFile,
      JSON.stringify({ enabled: true, bridge: { accounts: ["two"] } }),
    );
    expect(designatedClaudeAccountIds()).toEqual(["two"]);
    writeFileSync(
      providerConfigFile,
      JSON.stringify({ enabled: true, bridgeAccountIds: ["one"] }),
    );
    expect(designatedClaudeAccountIds()).toEqual(["one"]);
  });

  test("is empty while the file is disabled or absent", () => {
    writeFileSync(
      providerConfigFile,
      JSON.stringify({ enabled: false, bridge: { accounts: ["two"] } }),
    );
    expect(designatedClaudeAccountIds()).toEqual([]);
    rmSync(providerConfigFile, { force: true });
    expect(designatedClaudeAccountIds()).toEqual([]);
  });
});

describe("pickClaudeAccount refusal wording", () => {
  test("a dry designation and an exhausted pool keep their exact text", () => {
    designate(["word-a"]);
    seedAccounts(["word-a", "word-b"]);
    accounts.__setUsageCacheForTest("word-a", freshUsage);
    accounts.__setUsageCacheForTest("word-b", freshUsage);
    expect(
      pickClaudeAccount("claude-sonnet-5", { excludeIds: ["word-a"] }),
    ).toEqual({
      error: "no designated bridge account is currently usable (tried: word-a)",
    });
    designate([]);
    expect(
      pickClaudeAccount("claude-sonnet-5", {
        excludeIds: ["word-a", "word-b"],
      }),
    ).toEqual({
      error:
        "no usable Claude account in the pool (all exhausted or sidelined)",
    });
    seedAccounts([]);
    expect(pickClaudeAccount("claude-sonnet-5")).toEqual({
      error: "no Claude accounts configured (add one in Settings → Providers)",
    });
  });

  test("reports which policy step chose the account", () => {
    designate(["reason-b"]);
    seedAccounts(["reason-a", "reason-b"]);
    accounts.__setUsageCacheForTest("reason-a", freshUsage);
    accounts.__setUsageCacheForTest("reason-b", freshUsage);
    const out: { reason?: accounts.PickReason } = {};
    expect((pickClaudeAccount("claude-sonnet-5", {}, out) as any).id).toBe(
      "reason-b",
    );
    expect(out.reason).toBe("designated");
  });
});

describe("pickClaudeAccount pins (the designation is the ceiling)", () => {
  test("a designated, usable pin is picked first", () => {
    designate(["des-a", "des-b"]);
    seedAccounts(["des-a", "des-b"]);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    accounts.__setUsageCacheForTest("des-b", freshUsage);
    const picked = pickClaudeAccount("claude-sonnet-5", { accountId: "des-b" });
    expect("error" in picked).toBe(false);
    expect((picked as any).id).toBe("des-b");
  });

  test("strict pin outside the designation is a config error, not exhaustion", () => {
    designate(["des-a"]);
    seedAccounts(["des-a", "outsider"]);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickClaudeAccount("claude-sonnet-5", {
      accountId: "outsider",
      accountStrict: true,
    });
    // Read the string BEFORE asserting on the object: bun's toMatchObject
    // with an asymmetric matcher mutates the received object in place.
    const error = (picked as any).error as string;
    expect(error).toContain("not a designated bridge account");
    // Deliberately NOT usage-limit-shaped: model-hopping cannot fix a bad pin.
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(false);
  });

  test("non-strict pin outside the designation falls back to the designated walk", () => {
    designate(["des-a"]);
    seedAccounts(["des-a", "outsider"]);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickClaudeAccount("claude-sonnet-5", {
      accountId: "outsider",
    });
    expect((picked as any).id).toBe("des-a");
  });

  test("strict pin on an exhausted designated account fails exhaustion-shaped", () => {
    designate(["des-maxed", "des-a"]);
    seedAccounts(["des-maxed", "des-a"]);
    accounts.__setUsageCacheForTest("des-maxed", maxedUsage);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickClaudeAccount("claude-sonnet-5", {
      accountId: "des-maxed",
      accountStrict: true,
    });
    const error = (picked as any).error as string;
    expect(error).toMatch(/no designated bridge account is currently usable/);
    expect(error).toMatch(/strict pin/);
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(true);
    // Non-strict: the same pin widens to the rest of the designation.
    const widened = pickClaudeAccount("claude-sonnet-5", {
      accountId: "des-maxed",
    });
    expect((widened as any).id).toBe("des-a");
  });

  test("no pin keeps the plain designated walk", () => {
    designate(["des-maxed", "des-a"]);
    seedAccounts(["des-maxed", "des-a"]);
    accounts.__setUsageCacheForTest("des-maxed", maxedUsage);
    accounts.__setUsageCacheForTest("des-a", freshUsage);
    const picked = pickClaudeAccount("claude-sonnet-5");
    expect((picked as any).id).toBe("des-a");
  });
});

describe("pickClaudeAccount pool mode (no designation)", () => {
  test("picks the least-used usable account from the general pool", () => {
    designate([]);
    seedAccounts(["pool-a", "pool-b"]);
    accounts.__setUsageCacheForTest("pool-a", maxedUsage);
    accounts.__setUsageCacheForTest("pool-b", freshUsage);
    const picked = pickClaudeAccount("claude-sonnet-5");
    expect((picked as any).id).toBe("pool-b");
  });

  test("exhausted pool fails usage-limit-shaped; empty pool is a config error", () => {
    designate([]);
    seedAccounts(["pool-maxed"]);
    accounts.__setUsageCacheForTest("pool-maxed", maxedUsage);
    const picked = pickClaudeAccount("claude-sonnet-5");
    const error = (picked as any).error as string;
    expect(error).toMatch(/no usable Claude account in the pool/);
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(true);
    // Zero accounts configured: a config problem, not exhaustion — the
    // model-fallback walk must NOT engage (hopping models can't fix it).
    seedAccounts([]);
    const empty = pickClaudeAccount("claude-sonnet-5");
    const emptyError = (empty as any).error as string;
    expect(emptyError).toMatch(/no Claude accounts configured/);
    expect(isPiUsageLimitShape(emptyError, "anthropic")).toBe(false);
  });

  test("pins are honored; a strict pin never widens to the pool", () => {
    designate([]);
    seedAccounts(["pool-pin-a", "pool-pin-maxed"]);
    accounts.__setUsageCacheForTest("pool-pin-a", freshUsage);
    accounts.__setUsageCacheForTest("pool-pin-maxed", maxedUsage);
    const pinned = pickClaudeAccount("claude-sonnet-5", {
      accountId: "pool-pin-a",
    });
    expect((pinned as any).id).toBe("pool-pin-a");
    const strict = pickClaudeAccount("claude-sonnet-5", {
      accountId: "pool-pin-maxed",
      accountStrict: true,
    });
    const error = (strict as any).error as string;
    expect(error).toMatch(/no usable Claude account/);
    expect(isPiUsageLimitShape(error, "anthropic")).toBe(true);
    // Non-strict pin on an exhausted account widens to the pool.
    const widened = pickClaudeAccount("claude-sonnet-5", {
      accountId: "pool-pin-maxed",
    });
    expect((widened as any).id).toBe("pool-pin-a");
  });

  test("a user's personal account wins for their runs, never for others", () => {
    designate([]);
    seedAccounts(["pool-shared", { id: "pool-personal", owner: "alice" }]);
    accounts.__setUsageCacheForTest("pool-shared", freshUsage);
    accounts.__setUsageCacheForTest("pool-personal", freshUsage);
    const alice = pickClaudeAccount("claude-sonnet-5", { user: "alice" });
    expect((alice as any).id).toBe("pool-personal");
    const bob = pickClaudeAccount("claude-sonnet-5", { user: "bob" });
    expect((bob as any).id).toBe("pool-shared");
    const anonymous = pickClaudeAccount("claude-sonnet-5");
    expect((anonymous as any).id).toBe("pool-shared");
  });

  test("a sticky account beats the least-used round-robin while usable", () => {
    designate([]);
    seedAccounts(["pool-sticky-a", "pool-sticky-b", "pool-sticky-c"]);
    for (const id of ["pool-sticky-a", "pool-sticky-b", "pool-sticky-c"])
      accounts.__setUsageCacheForTest(id, freshUsage);
    // Consume the round-robin turn on the sticky account so the plain pick
    // would move elsewhere; the sticky preference must hold it in place.
    expect((pickClaudeAccount("claude-sonnet-5") as any).id).toBe(
      "pool-sticky-a",
    );
    expect(
      (
        pickClaudeAccount("claude-sonnet-5", {
          stickyId: "pool-sticky-a",
        }) as any
      ).id,
    ).toBe("pool-sticky-a");
    // Burned this turn: the walk moves on instead of retrying the sticky one.
    const walked = pickClaudeAccount("claude-sonnet-5", {
      stickyId: "pool-sticky-a",
      excludeIds: ["pool-sticky-a"],
    });
    expect((walked as any).id).not.toBe("pool-sticky-a");
    // Exhausted: falls through to the least-used pick.
    accounts.__setUsageCacheForTest("pool-sticky-a", maxedUsage);
    const moved = pickClaudeAccount("claude-sonnet-5", {
      stickyId: "pool-sticky-a",
    });
    expect((moved as any).id).not.toBe("pool-sticky-a");
    expect("error" in moved).toBe(false);
  });
});

describe("pickClaudeAccount peek and usage credits", () => {
  test("a peek reports the next account without taking its turn", () => {
    designate([]);
    seedAccounts(["peek-a", "peek-b"]);
    accounts.__setUsageCacheForTest("peek-a", freshUsage);
    accounts.__setUsageCacheForTest("peek-b", freshUsage);
    const pick = (peek?: boolean) =>
      (pickClaudeAccount("claude-sonnet-5", peek ? { peek } : {}) as any).id;
    // Without peeks the round-robin alternates: a, b, a.
    expect(pick()).toBe("peek-a");
    // Peeks announce the next account and leave the turn in place, however
    // many times they run.
    expect(pick(true)).toBe("peek-b");
    expect(pick(true)).toBe("peek-b");
    // So the real picks continue the same a, b, a sequence.
    expect(pick()).toBe("peek-b");
    expect(pick()).toBe("peek-a");
  });

  test("an account past its 5-hour limit serves on credits only when allowed", () => {
    designate([]);
    seedAccounts(["credit-a"]);
    accounts.__setUsageCacheForTest("credit-a", {
      ...maxedUsage,
      fetchedAt: new Date().toISOString(),
      extraUsage: { enabled: true, usedCredits: 10, monthlyLimit: 100 },
    });
    const refused = pickClaudeAccount("claude-sonnet-5");
    expect((refused as any).error).toMatch(/no usable Claude account/);
    const credited = pickClaudeAccount("claude-sonnet-5", {
      usageCredits: true,
    });
    expect((credited as any).id).toBe("credit-a");
    // A spent credit cap leaves no headroom, so credits cannot serve it either.
    accounts.__setUsageCacheForTest("credit-a", {
      ...maxedUsage,
      fetchedAt: new Date().toISOString(),
      extraUsage: { enabled: true, usedCredits: 100, monthlyLimit: 100 },
    });
    const spent = pickClaudeAccount("claude-sonnet-5", { usageCredits: true });
    expect((spent as any).error).toMatch(/no usable Claude account/);
  });
});
