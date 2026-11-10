import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Repo } from "./config";
import {
  __setAskPatDepsForTest,
  askPat,
  FIX_CI_STEER,
  registeredGhRepo,
} from "./supervisor-ask-pat";
import { createSupervisorMcpServer } from "./supervisor-mcp";

const repo = (id: string, ghRepo: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  label: id,
  repo: `/srv/${id}`,
  wtPrefix: id,
  defaultBranch: "main",
  ghRepo,
  ...extra,
});

const REPOS: Record<string, Repo> = {
  web: repo("web", "acme/web"),
  local: repo("local", ""),
  cs: repo("cs", "acme/cs", { host: "codestorage" }),
};

type Call = {
  kind: string;
  pr: number;
  requestedBy: string;
  steer: string | undefined;
  ghRepo: string;
};
let calls: Call[];
let audits: Record<string, unknown>[];
let outcome: { ok: boolean; message: string; url?: string; bksId?: string };

beforeEach(() => {
  calls = [];
  audits = [];
  outcome = {
    ok: true,
    message: "reviewing PR #7",
    url: "https://github.com/acme/web/pull/7",
    bksId: "os-1",
  };
  __setAskPatDepsForTest({
    repos: () => REPOS,
    persona: () => "Pat",
    audit: (event) => {
      audits.push(event);
    },
    trigger: async (kind, pr, requestedBy, steer, ghRepo) => {
      calls.push({ kind, pr, requestedBy, steer, ghRepo });
      return outcome;
    },
  });
});

afterEach(() => __setAskPatDepsForTest(undefined));

function tools() {
  return (
    createSupervisorMcpServer({ user: "Ada" }).instance as unknown as {
      _registeredTools: Record<
        string,
        {
          inputSchema?: { shape?: Record<string, unknown> };
          handler: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
        }
      >;
    }
  )._registeredTools;
}

describe("registeredGhRepo", () => {
  test("takes a registry id or owner/name, any case", () => {
    expect(registeredGhRepo("web", REPOS)).toBe("acme/web");
    expect(registeredGhRepo("ACME/Web", REPOS)).toBe("acme/web");
  });

  test("refuses unknown repos and ones without a GitHub repo", () => {
    expect(registeredGhRepo("acme/other", REPOS)).toBeNull();
    expect(registeredGhRepo("local", REPOS)).toBeNull();
    expect(registeredGhRepo("cs", REPOS)).toBeNull();
    expect(registeredGhRepo("  ", REPOS)).toBeNull();
  });
});

describe("askPat", () => {
  test("review_pr starts the existing review flow as the owner", async () => {
    const result = await askPat({
      owner: "Ada",
      action: "review_pr",
      repo: "web",
      pr: 7,
    });
    expect(calls).toEqual([
      {
        kind: "review",
        pr: 7,
        requestedBy: "Ada",
        steer: undefined,
        ghRepo: "acme/web",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      message:
        "Started: Pat is reviewing acme/web#7. Results go on the PR as Pat (https://github.com/acme/web/pull/7, session os-1).",
    });
    expect(audits).toEqual([
      {
        kind: "supervisor_ask_pat",
        actor: "Blob",
        user: "Ada",
        action: "review_pr",
        repo: "web",
        pr: 7,
        ghRepo: "acme/web",
        ok: true,
        sessionId: "os-1",
      },
    ]);
  });

  test("fix_ci and auto_fix start the os-auto-fix loop; only fix_ci adds the fixed steer", async () => {
    await askPat({ owner: "Ada", action: "fix_ci", repo: "acme/web", pr: 8 });
    await askPat({ owner: "Ada", action: "auto_fix", repo: "acme/web", pr: 9 });
    expect(calls.map((c) => [c.kind, c.pr, c.steer])).toEqual([
      ["autofix", 8, FIX_CI_STEER],
      ["autofix", 9, undefined],
    ]);
    expect(audits.map((a) => a.action)).toEqual(["fix_ci", "auto_fix"]);
  });

  test("an unregistered repo or a bad PR starts nothing and is audited", async () => {
    const other = await askPat({
      owner: "Ada",
      action: "review_pr",
      repo: "evil/repo",
      pr: 1,
    });
    expect(other.ok).toBe(false);
    expect(other.message).toContain("isn't a registered repository");
    const bad = await askPat({
      owner: "Ada",
      action: "review_pr",
      repo: "web",
      pr: -1,
    });
    expect(bad.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(audits.map((a) => [a.ok, a.reason])).toEqual([
      [false, "unregistered repo"],
      [false, "bad pr"],
    ]);
  });

  test("a flow that couldn't start says so and is audited", async () => {
    outcome = {
      ok: false,
      message: "Another PR action may already be running.",
    };
    const result = await askPat({
      owner: "Ada",
      action: "auto_fix",
      repo: "web",
      pr: 3,
    });
    expect(result).toEqual({
      ok: false,
      message: "Pat couldn't start: Another PR action may already be running.",
    });
    expect(audits[0]).toMatchObject({ ok: false, ghRepo: "acme/web" });
  });
});

describe("ask_pat tool", () => {
  test("takes only an action, a repo and a PR number", () => {
    const shape = tools().ask_pat!.inputSchema?.shape ?? {};
    expect(Object.keys(shape).sort()).toEqual(["action", "pr", "repo"]);
  });

  test("passes no free text to GitHub and never signs as Blob", async () => {
    const reply = await tools().ask_pat!.handler(
      { action: "fix_ci", repo: "web", pr: 4 },
      {},
    );
    expect(reply.isError).toBeUndefined();
    expect(reply.content[0]!.text).toStartWith("Started: Pat");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // The owner is the requester; the only text is the server's fixed steer.
    expect(call.requestedBy).toBe("Ada");
    expect(call.steer).toBe(FIX_CI_STEER);
    for (const value of Object.values(call))
      expect(String(value)).not.toMatch(/blob/i);
  });

  test("a refused call is an error result", async () => {
    const reply = await tools().ask_pat!.handler(
      { action: "review_pr", repo: "nowhere", pr: 4 },
      {},
    );
    expect(reply.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
