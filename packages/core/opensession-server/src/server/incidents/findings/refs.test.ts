import { expect, test } from "bun:test";
import type {
  AgentRun,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import {
  checkWindow,
  prOwner,
  type RefDeps,
  type RefScope,
  resolveRef,
} from "./refs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const AT = "2026-10-27T10:00:00.000Z";
const SHA = "abc1234def5678abc1234def5678abc1234def56";

function run(over: Partial<AgentRun>): AgentRun {
  return {
    role: "investigator",
    round: 1,
    attempt: 1,
    sessionId: "os-inv",
    model: "m",
    provider: "p",
    workspace: {} as AgentRun["workspace"],
    accessSummary: "",
    accessRevision: "",
    status: "running",
    startedAt: AT,
    turnSentAt: AT,
    costUsd: 0,
    tokens: 0,
    reminded: false,
    ...over,
  };
}

function incident(response: Partial<IncidentResponse> = {}): Incident {
  return {
    id: "inc-1",
    project: "acme",
    signalIds: ["sig-a"],
    events: [
      { id: "ev_1", at: AT, kind: "opened", by: "sessions", detail: "" },
    ],
    response: {
      round: 1,
      agents: [
        run({ prUrl: "https://github.com/acme/web/pull/12" }),
        run({ role: "verifier", sessionId: "os-ver" }),
      ],
      actionRuns: [{ id: "act_1" }],
      ledger: [{ id: "led_1" }],
      ...response,
    },
  } as unknown as Incident;
}

function scope(over: Partial<RefScope> = {}): RefScope {
  return {
    incident: incident(),
    role: "investigator",
    ownIds: new Set(),
    investigatorIds: new Set(),
    ...over,
  };
}

function deps(over: Partial<RefDeps> = {}): RefDeps {
  return {
    lookupCommit: async () => null,
    observations: async () => [],
    releases: async () => [],
    nowMs: NOW,
    ...over,
  };
}

test("ledger, event and action ids must exist on the incident", async () => {
  const s = scope();
  const d = deps();
  expect(await resolveRef({ type: "ledger", id: "led_1" }, s, d)).toEqual({
    type: "ledger",
    id: "led_1",
  });
  expect(await resolveRef({ type: "event", id: "ev_1" }, s, d)).toEqual({
    type: "event",
    id: "ev_1",
  });
  expect(await resolveRef({ type: "action", id: "act_1" }, s, d)).toEqual({
    type: "action",
    id: "act_1",
  });
  expect(await resolveRef({ type: "ledger", id: "led_x" }, s, d)).toBe(
    "No ledger entry led_x on this incident.",
  );
  expect(await resolveRef({ type: "event", id: "ev_x" }, s, d)).toBe(
    "No event ev_x on this incident.",
  );
  expect(await resolveRef({ type: "action", id: "act_x" }, s, d)).toBe(
    "No action run act_x on this incident.",
  );
});

test("observation refs need a stored observation at that time", async () => {
  const asked: unknown[] = [];
  const found = deps({
    observations: async (signalId, fromMs, toMs, lane) => {
      asked.push([signalId, fromMs, toMs, lane]);
      return [{ at: AT }];
    },
  });
  expect(
    await resolveRef(
      { type: "observation", signal: "sig-a", lane: "p95", at: AT },
      scope(),
      found,
    ),
  ).toEqual({ type: "observation", signal: "sig-a", lane: "p95", at: AT });
  expect(asked).toEqual([["sig-a", Date.parse(AT), Date.parse(AT), "p95"]]);

  expect(
    await resolveRef(
      { type: "observation", signal: "sig-a", at: AT },
      scope(),
      deps(),
    ),
  ).toBe(`No observation of sig-a at ${AT}.`);
  expect(
    await resolveRef(
      { type: "observation", signal: "sig-b", at: AT },
      scope(),
      found,
    ),
  ).toBe("Signal sig-b is not part of this incident.");
});

test("release refs match the project's releases", async () => {
  const projects: string[] = [];
  const d = deps({
    releases: async (project) => {
      projects.push(project);
      return [{ at: AT, ref: "v1.2.0" }];
    },
  });
  expect(
    await resolveRef({ type: "release", at: AT, ref: "v1.2.0" }, scope(), d),
  ).toEqual({
    type: "release",
    at: AT,
    ref: "v1.2.0",
  });
  expect(projects).toEqual(["acme"]);
  expect(await resolveRef({ type: "release", at: AT }, scope(), d)).toEqual({
    type: "release",
    at: AT,
    ref: "v1.2.0",
  });
  expect(
    await resolveRef({ type: "release", at: AT, ref: "v9.9.9" }, scope(), d),
  ).toBe(`No release v9.9.9 at ${AT} in acme.`);
  expect(
    await resolveRef(
      { type: "release", at: "2026-10-27T11:00:00.000Z" },
      scope(),
      d,
    ),
  ).toBe("No release at 2026-10-27T11:00:00.000Z in acme.");
});

test("PRs resolve to the agent session that owns them", async () => {
  const d = deps();
  const url12 = "https://github.com/acme/web/pull/12";
  expect(await resolveRef({ type: "pr", number: 12 }, scope(), d)).toEqual({
    type: "pr",
    number: 12,
    url: url12,
    sessionId: "os-inv",
  });

  const url14 = "https://github.com/acme/web/pull/14";
  const withOpen = scope({
    incident: incident({
      openPrs: [{ url: url14, number: 14, sessionId: "os-old" }],
    }),
  });
  expect(await resolveRef({ type: "pr", number: 14 }, withOpen, d)).toEqual({
    type: "pr",
    number: 14,
    url: url14,
    sessionId: "os-old",
  });

  const url13 = "https://github.com/acme/web/pull/13";
  const candidate = incident({
    agents: [
      run({ sessionId: "os-r1" }),
      run({ round: 2, sessionId: "os-r2", prUrl: url13 }),
    ],
    candidate: { round: 2, prUrl: url13 } as IncidentResponse["candidate"],
  });
  expect(
    await resolveRef(
      { type: "pr", number: 13 },
      scope({ incident: candidate }),
      d,
    ),
  ).toEqual({
    type: "pr",
    number: 13,
    url: url13,
    sessionId: "os-r2",
  });

  expect(await resolveRef({ type: "pr", number: 99 }, scope(), d)).toBe(
    "PR #99 isn't one this incident's agents opened.",
  );
});

test("a candidate PR no run recorded belongs to its round's investigator", () => {
  const url15 = "https://github.com/acme/web/pull/15";
  const response = incident({
    agents: [
      run({ sessionId: "os-r1" }),
      run({ role: "verifier", round: 2, sessionId: "os-v2" }),
      run({
        round: 2,
        attempt: 1,
        sessionId: "os-r2a",
        supersededBy: "os-r2b",
      }),
      run({ round: 2, attempt: 2, sessionId: "os-r2b" }),
    ],
    candidate: { round: 2, prUrl: url15 } as IncidentResponse["candidate"],
  }).response as IncidentResponse;
  expect(prOwner(response, 15)).toEqual({ url: url15, sessionId: "os-r2b" });
  expect(prOwner(response, 16)).toBeNull();
});

test("commits must be on the project's default branch", async () => {
  const asked: unknown[] = [];
  const lookup =
    (
      found: { repo: string; onDefaultBranch: boolean } | null,
    ): RefDeps["lookupCommit"] =>
    async (sha, repo) => {
      asked.push([sha, repo]);
      return found && { ...found, sha: SHA };
    };
  expect(
    await resolveRef(
      { type: "commit", sha: "abc1234" },
      scope(),
      deps({ lookupCommit: lookup({ repo: "acme", onDefaultBranch: true }) }),
    ),
  ).toEqual({ type: "commit", sha: SHA, repo: "acme" });
  expect(asked).toEqual([["abc1234", "acme"]]);
  expect(
    await resolveRef(
      { type: "commit", sha: "abc1234" },
      scope(),
      deps({ lookupCommit: lookup({ repo: "acme", onDefaultBranch: false }) }),
    ),
  ).toBe("Commit abc1234 isn't on acme's default branch.");
  expect(
    await resolveRef(
      { type: "commit", sha: SHA },
      scope(),
      deps({ lookupCommit: lookup({ repo: "other", onDefaultBranch: true }) }),
    ),
  ).toBe("Commit abc1234 isn't in acme.");
  expect(
    await resolveRef(
      { type: "commit", sha: "abc1234" },
      scope(),
      deps({ lookupCommit: lookup(null) }),
    ),
  ).toBe("No commit abc1234 in acme.");
});

test("block refs: own set, then for the verifier the investigator's", async () => {
  const d = deps();
  expect(
    await resolveRef(
      { type: "block", id: "x" },
      scope({ ownIds: new Set(["x"]) }),
      d,
    ),
  ).toEqual({ type: "block", id: "x", role: "investigator" });
  expect(
    await resolveRef(
      { type: "block", id: "x" },
      scope({
        role: "verifier",
        ownIds: new Set(["y"]),
        investigatorIds: new Set(["x"]),
      }),
      d,
    ),
  ).toEqual({ type: "block", id: "x", role: "investigator" });
  expect(
    await resolveRef(
      { type: "block", id: "y" },
      scope({
        role: "verifier",
        ownIds: new Set(["y"]),
        investigatorIds: new Set(["y"]),
      }),
      d,
    ),
  ).toEqual({ type: "block", id: "y", role: "verifier" });
  // The investigator never reads the verifier's set, even when the ids match.
  expect(
    await resolveRef(
      { type: "block", id: "x" },
      scope({ investigatorIds: new Set(["x"]) }),
      d,
    ),
  ).toBe("No block x in your findings.");
  expect(
    await resolveRef(
      { type: "block", id: "z" },
      scope({ role: "verifier" }),
      d,
    ),
  ).toBe("No block z in your findings or the investigator's.");
});

test("windows outside retention or without data are refused", async () => {
  const asked: unknown[] = [];
  const some = deps({
    observations: async (signalId, fromMs, toMs, lane) => {
      asked.push([signalId, fromMs, toMs, lane]);
      return [{ at: AT }];
    },
  });
  const from = "2026-10-27T09:00:00.000Z";
  expect(
    await checkWindow({ signalId: "sig-a", from, to: AT }, scope(), some),
  ).toBe(true);
  expect(asked).toEqual([
    ["sig-a", Date.parse(from), Date.parse(AT), undefined],
  ]);

  // A window that starts before retention is queried from the cutoff.
  asked.length = 0;
  const old = new Date(NOW - 35 * DAY).toISOString();
  expect(
    await checkWindow({ signalId: "sig-a", from: old, to: AT }, scope(), some),
  ).toBe(true);
  expect(asked).toEqual([["sig-a", NOW - 30 * DAY, Date.parse(AT), undefined]]);

  expect(
    await checkWindow(
      {
        signalId: "sig-a",
        from: new Date(NOW - 40 * DAY).toISOString(),
        to: new Date(NOW - 31 * DAY).toISOString(),
      },
      scope(),
      some,
    ),
  ).toBe("That window is older than the 30 days of kept observations.");
  expect(
    await checkWindow({ signalId: "sig-a", from, to: AT }, scope(), deps()),
  ).toBe("No observations of sig-a in that window.");
  expect(
    await checkWindow(
      { signalId: "sig-a", lane: "p95", from, to: AT },
      scope(),
      deps(),
    ),
  ).toBe("No observations of sig-a in that window (lane p95).");
  expect(
    await checkWindow({ signalId: "sig-b", from, to: AT }, scope(), some),
  ).toBe("Signal sig-b is not part of this incident.");
});
