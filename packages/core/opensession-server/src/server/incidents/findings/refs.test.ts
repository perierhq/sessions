import { expect, test } from "bun:test";
import type {
  AgentRun,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { MAIN_LANE } from "../observation-store";
import {
  checkWindow,
  COMMITS_PER_CALL,
  createRefMemo,
  OBSERVATION_TOLERANCE_MS,
  parseIsoTime,
  prOwner,
  type RefDeps,
  type RefScope,
  resolveRef,
  shown,
} from "./refs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const AT = "2026-10-27T10:00:00.000Z";
const SHA = "abc1234def5678abc1234def5678abc1234def56";
const iso = (ms: number) => new Date(ms).toISOString();

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
    ghRepo: "acme/web",
    memo: createRefMemo(),
    ...over,
  };
}

function deps(over: Partial<RefDeps> = {}): RefDeps {
  return {
    lookupCommitIn: async () => null,
    hasObservation: async () => false,
    nearestObservation: async () => null,
    releases: async () => [],
    nowMs: NOW,
    ...over,
  };
}

const boom = async (): Promise<never> => {
  throw new Error("disk on fire");
};

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
    'No ledger entry "led_x" on this incident.',
  );
  expect(await resolveRef({ type: "event", id: "ev_x" }, s, d)).toBe(
    'No event "ev_x" on this incident.',
  );
  expect(await resolveRef({ type: "action", id: "act_x" }, s, d)).toBe(
    'No action run "act_x" on this incident.',
  );
});

test("agent values in notes are flattened, clipped and quoted", async () => {
  expect(shown("  a\n\tb  ")).toBe('"a b"');
  expect(shown("x".repeat(100))).toBe(`"${"x".repeat(59)}…"`);
  expect(shown('say "hi"')).toBe('"say \\"hi\\""');
  expect(
    await resolveRef(
      { type: "ledger", id: `led\n${"y".repeat(200)}` },
      scope(),
      deps(),
    ),
  ).toBe(`No ledger entry "led ${"y".repeat(55)}…" on this incident.`);
});

test("times must be ISO 8601 with a time zone", () => {
  expect(parseIsoTime("2026-10-27T10:00:00Z")).toBe(Date.parse(AT));
  expect(parseIsoTime("2026-10-27T10:00:00.000Z")).toBe(Date.parse(AT));
  expect(parseIsoTime("2026-10-27T10:00Z")).toBe(Date.parse(AT));
  expect(parseIsoTime("2026-10-27T12:00:00.5+02:00")).toBe(
    Date.parse(AT) + 500,
  );
  expect(parseIsoTime("2026-10-27T05:30:00.123456-04:30")).toBe(
    Date.parse(AT) + 123,
  );
  expect(parseIsoTime("2024-02-29T00:00:00Z")).toBe(
    Date.parse("2024-02-29T00:00:00Z"),
  );
  for (const bad of [
    "2026-10-27T10:00:00",
    "2026-10-27",
    "2026-10-27 10:00:00Z",
    " 2026-10-27T10:00:00Z",
    "2026-10-27T10:00:00+0200",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-10-27T24:00:00Z",
    "2026-10-27T10:60:00Z",
    "2026-10-27T10:00:60Z",
    "2026-10-27T10:00:00+24:00",
    "Tue, 27 Oct 2026 10:00:00 GMT",
    "1793095200000",
    "",
  ])
    expect(parseIsoTime(bad)).toBeNull();
});

test("observation refs snap to a stored observation, main lane by default", async () => {
  const asked: unknown[] = [];
  const found = deps({
    nearestObservation: async (signalId, atMs, toleranceMs, lane) => {
      asked.push([signalId, atMs, toleranceMs, lane]);
      return { at: AT };
    },
  });
  expect(
    await resolveRef(
      { type: "observation", signal: "sig-a", lane: "p95", at: AT },
      scope(),
      found,
    ),
  ).toEqual({ type: "observation", signal: "sig-a", lane: "p95", at: AT });
  // No lane: the main lane is looked up, and the stored ref leaves the lane
  // off, which reads as the main lane (as on a signal window).
  expect(
    await resolveRef(
      {
        type: "observation",
        signal: "sig-a",
        at: "2026-10-27T12:00:00.4+02:00",
      },
      scope(),
      found,
    ),
  ).toEqual({ type: "observation", signal: "sig-a", at: AT });
  expect(asked).toEqual([
    ["sig-a", Date.parse(AT), OBSERVATION_TOLERANCE_MS, "p95"],
    ["sig-a", Date.parse(AT) + 400, OBSERVATION_TOLERANCE_MS, MAIN_LANE],
  ]);

  expect(
    await resolveRef(
      { type: "observation", signal: "sig-a", at: AT },
      scope(),
      deps(),
    ),
  ).toBe(`No observation of "sig-a" at "${AT}".`);
  expect(
    await resolveRef(
      { type: "observation", signal: "sig-a", lane: "p95", at: AT },
      scope(),
      deps(),
    ),
  ).toBe(`No observation of "sig-a" (lane "p95") at "${AT}".`);
  expect(
    await resolveRef(
      { type: "observation", signal: "sig-a", at: "2026-10-27T10:00:00" },
      scope(),
      found,
    ),
  ).toBe(
    'Time "2026-10-27T10:00:00" must be ISO 8601 with a time zone, like 2026-10-27T10:00:00Z.',
  );
  expect(
    await resolveRef(
      { type: "observation", signal: "sig-b", at: AT },
      scope(),
      found,
    ),
  ).toBe('Signal "sig-b" is not part of this incident.');
});

test("one call looks each observation and window up once", async () => {
  let nearest = 0;
  let has = 0;
  const d = deps({
    nearestObservation: async () => {
      nearest++;
      return { at: AT };
    },
    hasObservation: async () => {
      has++;
      return true;
    },
  });
  const s = scope();
  const ref = { type: "observation", signal: "sig-a", at: AT } as const;
  const w = { signalId: "sig-a", from: "2026-10-27T09:00:00Z", to: AT };
  await Promise.all([
    resolveRef(ref, s, d),
    resolveRef(ref, s, d),
    checkWindow(w, s, d),
    checkWindow({ ...w, from: "2026-10-27T09:00:00.000Z" }, s, d),
  ]);
  expect([nearest, has]).toEqual([1, 1]);
  // A new call starts with a fresh memo.
  await checkWindow(w, scope(), d);
  expect(has).toBe(2);
});

test("release refs match the project's releases", async () => {
  const projects: string[] = [];
  const d = deps({
    releases: async (project) => {
      projects.push(project);
      return [{ at: AT, ref: "v1.2.0" }];
    },
  });
  const s = scope();
  expect(
    await resolveRef({ type: "release", at: AT, ref: "v1.2.0" }, s, d),
  ).toEqual({
    type: "release",
    at: AT,
    ref: "v1.2.0",
  });
  expect(await resolveRef({ type: "release", at: AT }, s, d)).toEqual({
    type: "release",
    at: AT,
    ref: "v1.2.0",
  });
  expect(
    await resolveRef({ type: "release", at: AT, ref: "v9.9.9" }, s, d),
  ).toBe(`No release "v9.9.9" at "${AT}" in acme.`);
  expect(
    await resolveRef({ type: "release", at: "2026-10-27T11:00:00.000Z" }, s, d),
  ).toBe('No release at "2026-10-27T11:00:00.000Z" in acme.');
  // The release list is read once per call.
  expect(projects).toEqual(["acme"]);
});

test("PRs resolve to the agent session that owns them, in the project's repo", async () => {
  const d = deps();
  const url12 = "https://github.com/acme/web/pull/12";
  expect(await resolveRef({ type: "pr", number: 12 }, scope(), d)).toEqual({
    type: "pr",
    number: 12,
    url: url12,
    sessionId: "os-inv",
  });
  // GitHub names are case-insensitive.
  expect(
    await resolveRef(
      { type: "pr", number: 12 },
      scope({ ghRepo: "Acme/Web" }),
      d,
    ),
  ).toMatchObject({ number: 12 });
  // Same number, another repository: not this incident's PR.
  expect(
    await resolveRef(
      { type: "pr", number: 12 },
      scope({ ghRepo: "acme/api" }),
      d,
    ),
  ).toBe("PR #12 isn't one this incident's agents opened.");
  expect(
    await resolveRef(
      { type: "pr", number: 12 },
      scope({ ghRepo: undefined }),
      d,
    ),
  ).toBe("PR #12 isn't one this incident's agents opened.");

  const url14 = "https://github.com/acme/web/pull/14";
  const withOpen = scope({
    incident: incident({
      openPrs: [
        {
          url: "https://github.com/acme/api/pull/14",
          number: 14,
          sessionId: "os-elsewhere",
        },
        { url: url14, number: 14, sessionId: "os-old" },
      ],
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
  const agents = [
    run({ sessionId: "os-r1" }),
    run({ role: "verifier", round: 2, sessionId: "os-v2" }),
    run({
      round: 2,
      attempt: 1,
      sessionId: "os-r2a",
      supersededBy: "os-r2b",
    }),
    run({ round: 2, attempt: 2, sessionId: "os-r2b" }),
  ];
  const response = incident({
    agents,
    candidate: { round: 2, prUrl: url15 } as IncidentResponse["candidate"],
  }).response as IncidentResponse;
  expect(prOwner(response, 15, "acme/web")).toEqual({
    url: url15,
    sessionId: "os-r2b",
  });
  expect(prOwner(response, 16, "acme/web")).toBeNull();
  expect(prOwner(response, 15, "acme/api")).toBeNull();

  // Only the PR snapshot carries the URL.
  const fromSnapshot = incident({
    agents,
    candidate: {
      round: 2,
      pr: { url: url15, number: 15, ghRepo: "acme/web" },
    } as IncidentResponse["candidate"],
  }).response as IncidentResponse;
  expect(prOwner(fromSnapshot, 15, "acme/web")).toEqual({
    url: url15,
    sessionId: "os-r2b",
  });
});

test("commits are read from the project's own checkout and must be on its default branch", async () => {
  const asked: unknown[] = [];
  const lookup =
    (found: { onDefaultBranch: boolean } | null): RefDeps["lookupCommitIn"] =>
    async (sha, repoId) => {
      asked.push([sha, repoId]);
      return found && { ...found, sha: SHA };
    };
  expect(
    await resolveRef(
      { type: "commit", sha: "ABC1234" },
      scope(),
      deps({ lookupCommitIn: lookup({ onDefaultBranch: true }) }),
    ),
  ).toEqual({ type: "commit", sha: SHA, repo: "acme" });
  expect(asked).toEqual([["abc1234", "acme"]]);
  const miss = "No commit abc1234 on acme's default branch.";
  expect(
    await resolveRef(
      { type: "commit", sha: "abc1234" },
      scope(),
      deps({ lookupCommitIn: lookup({ onDefaultBranch: false }) }),
    ),
  ).toBe(miss);
  expect(
    await resolveRef(
      { type: "commit", sha: SHA },
      scope(),
      deps({ lookupCommitIn: lookup(null) }),
    ),
  ).toBe(miss);
  // A lookup that answers with some other commit is a miss too.
  expect(
    await resolveRef(
      { type: "commit", sha: "fff1234" },
      scope(),
      deps({ lookupCommitIn: lookup({ onDefaultBranch: true }) }),
    ),
  ).toBe("No commit fff1234 on acme's default branch.");
  expect(
    await resolveRef({ type: "commit", sha: "HEAD~1" }, scope(), deps()),
  ).toBe('"HEAD~1" isn\'t a commit sha.');
});

test("one call looks a commit up once and at most 12 commits in all", async () => {
  const asked: string[] = [];
  const d = deps({
    lookupCommitIn: async (sha) => {
      asked.push(sha);
      return { sha: sha.padEnd(40, "0"), onDefaultBranch: true };
    },
  });
  const s = scope();
  const shas = Array.from(
    { length: COMMITS_PER_CALL + 1 },
    (_, i) => `abc${String(i).padStart(4, "0")}`,
  );
  await resolveRef({ type: "commit", sha: shas[0]! }, s, d);
  await resolveRef({ type: "commit", sha: shas[0]!.toUpperCase() }, s, d);
  expect(asked).toEqual([shas[0]]);
  const results = await Promise.all(
    shas.map((sha) => resolveRef({ type: "commit", sha }, s, d)),
  );
  expect(asked).toEqual(shas.slice(0, COMMITS_PER_CALL));
  expect(results.at(-1)).toBe(
    `Commit ${shas.at(-1)} wasn't checked: one call checks at most 12 commits.`,
  );
  // Commits already checked in this call still resolve.
  expect(await resolveRef({ type: "commit", sha: shas[1]! }, s, d)).toEqual({
    type: "commit",
    sha: shas[1]!.padEnd(40, "0"),
    repo: "acme",
  });
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
  ).toBe('No block "x" in your findings.');
  expect(
    await resolveRef(
      { type: "block", id: "z" },
      scope({ role: "verifier" }),
      d,
    ),
  ).toBe('No block "z" in your findings or the investigator\'s.');
});

test("windows: main lane by default, refused outside retention or without data", async () => {
  const asked: unknown[] = [];
  const some = deps({
    hasObservation: async (signalId, fromMs, toMs, lane) => {
      asked.push([signalId, fromMs, toMs, lane]);
      return true;
    },
  });
  const from = "2026-10-27T09:00:00.000Z";
  expect(
    await checkWindow({ signalId: "sig-a", from, to: AT }, scope(), some),
  ).toBe(true);
  expect(
    await checkWindow(
      { signalId: "sig-a", lane: "p95", from, to: AT },
      scope(),
      some,
    ),
  ).toBe(true);
  expect(asked).toEqual([
    ["sig-a", Date.parse(from), Date.parse(AT), MAIN_LANE],
    ["sig-a", Date.parse(from), Date.parse(AT), "p95"],
  ]);

  expect(
    await checkWindow(
      { signalId: "sig-a", from: iso(NOW - 40 * DAY), to: iso(NOW - 31 * DAY) },
      scope(),
      some,
    ),
  ).toBe("That window is older than the 30 days of kept observations.");
  expect(
    await checkWindow({ signalId: "sig-a", from, to: AT }, scope(), deps()),
  ).toBe('No observations of "sig-a" in that window.');
  expect(
    await checkWindow(
      { signalId: "sig-a", lane: "p95", from, to: AT },
      scope(),
      deps(),
    ),
  ).toBe('No observations of "sig-a" in that window (lane "p95").');
  expect(
    await checkWindow({ signalId: "sig-b", from, to: AT }, scope(), some),
  ).toBe('Signal "sig-b" is not part of this incident.');
  for (const bad of [
    { from: AT, to: from },
    { from: "2026-10-27T09:00:00", to: AT },
    { from, to: "later" },
  ])
    expect(
      await checkWindow({ signalId: "sig-a", ...bad }, scope(), some),
    ).toBe("That window has no valid times.");
});

test("windows are clamped to retention, 31 days and now", async () => {
  const asked: Array<[number, number]> = [];
  const d = deps({
    hasObservation: async (_signalId, fromMs, toMs) => {
      asked.push([fromMs, toMs]);
      return true;
    },
  });
  const check = (from: number, to: number) =>
    checkWindow(
      { signalId: "sig-a", from: iso(from), to: iso(to) },
      scope(),
      d,
    );

  // 40 days ending now: from the retention cutoff.
  expect(await check(NOW - 40 * DAY, NOW)).toBe(true);
  // 40 days ending in the future: to is now, from the cutoff.
  expect(await check(NOW - 40 * DAY, NOW + 9 * DAY)).toBe(true);
  // A future `to`: up to now only.
  expect(await check(NOW - 3_600_000, NOW + 5 * 3_600_000)).toBe(true);
  expect(asked).toEqual([
    [NOW - 30 * DAY, NOW],
    [NOW - 30 * DAY, NOW],
    [NOW - 3_600_000, NOW],
  ]);
  // Every queried span fits the findings window limit.
  for (const [from, to] of asked)
    expect(to - from).toBeLessThanOrEqual(31 * DAY);

  expect(await check(NOW + 3_600_000, NOW + 7_200_000)).toBe(
    "That window hasn't started yet.",
  );
  expect(asked).toHaveLength(3);
});

test("a dependency that fails becomes a note, never a throw", async () => {
  const d = deps({
    lookupCommitIn: boom,
    hasObservation: boom,
    nearestObservation: boom,
    releases: boom,
  });
  const s = scope();
  expect(
    await resolveRef({ type: "observation", signal: "sig-a", at: AT }, s, d),
  ).toBe('Couldn\'t check observations of "sig-a" right now.');
  expect(
    await checkWindow(
      { signalId: "sig-a", from: "2026-10-27T09:00:00Z", to: AT },
      s,
      d,
    ),
  ).toBe('Couldn\'t check observations of "sig-a" right now.');
  expect(await resolveRef({ type: "release", at: AT }, s, d)).toBe(
    "Couldn't check acme's releases right now.",
  );
  expect(await resolveRef({ type: "commit", sha: "abc1234" }, s, d)).toBe(
    "Couldn't check commit abc1234 right now.",
  );
  // A synchronous throw is caught the same way.
  const sync = deps({
    hasObservation: () => {
      throw new Error("bad");
    },
  });
  expect(
    await checkWindow(
      { signalId: "sig-a", from: "2026-10-27T09:00:00Z", to: AT },
      scope(),
      sync,
    ),
  ).toBe('Couldn\'t check observations of "sig-a" right now.');
});
