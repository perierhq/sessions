import { expect, test } from "bun:test";
import type { PrSnapshot } from "../../../shared/incident-response";
import type {
  PrMergeVerdict,
  PrReadinessCheck,
} from "../../pr-merge-readiness";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  type MergeGithub,
  assessAutoMerge,
  fetchPrSnapshot,
  mergeIncidentPr,
  MAX_PR_FILES,
  parsePrFileList,
  parsePrUrl,
  prFilePaths,
  snapshotFromVerdict,
} from "./merge";

const kit = useIncidentTestKernel();

const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  ghRepo: "acme/web",
  number: 12,
  url: "https://github.com/acme/web/pull/12",
  headSha: "abc1234",
  base: "main",
  state: "OPEN",
  draft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "",
  requiredApprovals: 0,
  strictUpToDate: false,
  failingChecks: [],
  pendingChecks: [],
  missingRequired: [],
  files: [],
  fetchedAt: "x",
  ...over,
});

test.each([
  [pr(), { kind: "ready" }],
  [pr({ state: "MERGED" }), { kind: "merged" }],
  [
    pr({ state: "CLOSED" }),
    { kind: "needs-you", needsYou: "merge", reason: "PR #12 was closed" },
  ],
  [
    pr({ draft: true }),
    { kind: "needs-you", needsYou: "merge", reason: "PR #12 is a draft" },
  ],
  [
    pr({ headSha: "fff9999" }),
    {
      kind: "needs-you",
      needsYou: "merge",
      reason: "PR #12 changed after verification",
    },
  ],
  [
    pr({ reviewDecision: "CHANGES_REQUESTED", requiredApprovals: 1 }),
    {
      kind: "needs-you",
      needsYou: "protection",
      reason: "Changes were requested on PR #12",
    },
  ],
  [
    pr({ requiredApprovals: 1, mergeStateStatus: "CLEAN" }),
    {
      kind: "needs-you",
      needsYou: "protection",
      reason: "Branch protection requires a review on PR #12",
    },
  ],
  [
    pr({ reviewDecision: "REVIEW_REQUIRED" }),
    {
      kind: "needs-you",
      needsYou: "protection",
      reason: "Branch protection requires a review on PR #12",
    },
  ],
  [pr({ requiredApprovals: 1, reviewDecision: "APPROVED" }), { kind: "ready" }],
  [
    pr({ rulesUnreadable: true }),
    {
      kind: "needs-you",
      needsYou: "protection",
      reason: "Sessions could not read the branch rules for PR #12",
    },
  ],
  [
    pr({ mergeable: "CONFLICTING", failingChecks: ["test"] }),
    {
      kind: "needs-you",
      needsYou: "merge",
      reason: "PR #12 has merge conflicts",
    },
  ],
  [
    pr({ failingChecks: ["test"] }),
    { kind: "send-back", reason: "Check test failed on PR #12" },
  ],
  [
    pr({ pendingChecks: ["test", "lint"] }),
    { kind: "wait", detail: "Waiting for 2 checks on PR #12" },
  ],
  [
    pr({ pendingChecks: ["test"], missingRequired: ["deploy-preview"] }),
    { kind: "wait", detail: "Waiting for 2 checks on PR #12" },
  ],
  [
    pr({ missingRequired: ["test"] }),
    { kind: "wait", detail: "Waiting for 1 check on PR #12" },
  ],
  [
    pr({ mergeStateStatus: "BEHIND", strictUpToDate: true }),
    {
      kind: "needs-you",
      needsYou: "protection",
      reason: "PR #12 must be updated with main first",
    },
  ],
  [pr({ mergeStateStatus: "BEHIND" }), { kind: "ready" }],
  [
    pr({ mergeStateStatus: "BLOCKED" }),
    {
      kind: "needs-you",
      needsYou: "protection",
      reason: "GitHub reports PR #12 as blocked",
    },
  ],
])("assess %#", (snapshot, expected) => {
  expect(assessAutoMerge(snapshot, "abc1234")).toEqual(expected as never);
});

const github = (over: Partial<MergeGithub> = {}) => {
  const merges: unknown[] = [];
  const gh: MergeGithub = {
    verdict: async () => {
      throw new Error("unused");
    },
    files: async () => [],
    mergeCommit: async () => undefined,
    mergeMethods: async () => ["squash", "merge"],
    appCredential: async () => ({
      kind: "service",
      principal: "service",
      env: { GH_TOKEN: "app" },
    }),
    merge: async (...args) => {
      merges.push(args);
      return { ok: true, sha: "9f9f9f9" };
    },
    ...over,
  };
  return { gh, merges };
};

test("merges the verified SHA as the App", async () => {
  const { gh, merges } = github();
  expect(
    await mergeIncidentPr(
      {
        incidentId: "inc-1",
        pr: pr(),
        verifiedSha: "abc1234",
        title: "Send the app's user agent",
        now: 0,
      },
      gh,
    ),
  ).toEqual({
    ghRepo: "acme/web",
    number: 12,
    sha: "abc1234",
    status: "merged",
    mergedSha: "9f9f9f9",
    method: "squash",
    at: new Date(0).toISOString(),
  });
  expect(merges[0]).toEqual([
    "acme/web",
    12,
    {
      sha: "abc1234",
      method: "squash",
      title: "Send the app's user agent (#12)",
    },
    { kind: "service", principal: "service", env: { GH_TOKEN: "app" } },
  ]);
  expect(kit.audits).toEqual([
    {
      kind: "incident_merge",
      incidentId: "inc-1",
      ghRepo: "acme/web",
      number: 12,
      sha: "abc1234",
      method: "squash",
      status: "merged",
    },
  ]);
  expect(JSON.stringify(kit.audits)).not.toContain("GH_TOKEN");
});

test("never calls merge when a review is required, even if GitHub would let the App through", async () => {
  const { gh, merges } = github();
  let credentials = 0;
  gh.appCredential = async () => {
    credentials++;
    return { kind: "service", principal: "service", env: {} };
  };
  expect(
    await mergeIncidentPr(
      {
        incidentId: "inc-1",
        pr: pr({ requiredApprovals: 1 }),
        verifiedSha: "abc1234",
        title: "x",
        now: 0,
      },
      gh,
    ),
  ).toMatchObject({
    status: "refused",
    detail: "Branch protection requires a review on PR #12",
  });
  expect(
    await mergeIncidentPr(
      {
        incidentId: "inc-1",
        pr: pr({ headSha: "fff9999" }),
        verifiedSha: "abc1234",
        title: "x",
        now: 0,
      },
      gh,
    ),
  ).toMatchObject({
    status: "refused",
    sha: "abc1234",
    detail: "PR #12 changed after verification",
  });
  expect(
    (
      await mergeIncidentPr(
        {
          incidentId: "inc-1",
          pr: pr({ pendingChecks: ["test"] }),
          verifiedSha: "abc1234",
          title: "x",
          now: 0,
        },
        gh,
      )
    ).detail,
  ).toBe("Waiting for 1 check on PR #12");
  expect(merges).toEqual([]);
  expect(credentials).toBe(0);
  expect(kit.audits.map((a) => a.status)).toEqual([
    "refused",
    "refused",
    "refused",
  ]);
});

test("a GitHub refusal is explained, never retried around", async () => {
  let calls = 0;
  const { gh } = github({
    merge: async () => {
      calls++;
      return {
        ok: false,
        status: 405,
        message: 'Required status check "test" is expected.',
      };
    },
  });
  expect(
    (
      await mergeIncidentPr(
        {
          incidentId: "inc-1",
          pr: pr(),
          verifiedSha: "abc1234",
          title: "x",
          now: 0,
        },
        gh,
      )
    ).detail,
  ).toBe(
    'GitHub refused the merge: Required status check "test" is expected. Sessions never bypasses branch protection, so this needs you.',
  );
  expect(calls).toBe(1);
  const thrown = github({
    appCredential: async () => {
      throw new Error("The selected GitHub bot credential is unavailable");
    },
  });
  expect(
    await mergeIncidentPr(
      {
        incidentId: "inc-1",
        pr: pr(),
        verifiedSha: "abc1234",
        title: "x",
        now: 0,
      },
      thrown.gh,
    ),
  ).toMatchObject({
    status: "refused",
    detail: "The selected GitHub bot credential is unavailable",
  });
  expect(thrown.merges).toEqual([]);
  expect(parsePrUrl("https://github.com/acme/web/pull/12")).toEqual({
    ghRepo: "acme/web",
    number: 12,
  });
  expect(parsePrUrl("https://example.test/acme/web/pull/12")).toBeNull();
  expect(parsePrUrl("https://github.com/acme/web/pull/0")).toBeNull();
  expect(parsePrUrl("https://github.com/acme/web/issues/12")).toBeNull();
});

const check = (name: string): PrReadinessCheck => ({
  name,
  outcome: "failing",
  conclusion: "FAILURE",
  required: true,
});
const verdict = (over: Partial<PrMergeVerdict> = {}): PrMergeVerdict => ({
  ready: false,
  summary: "",
  blockers: [],
  warnings: [],
  pr: {
    repo: "acme",
    ghRepo: "acme/web",
    number: 12,
    title: "Fix search",
    url: "https://github.com/acme/web/pull/12",
    author: "acme-bot",
    base: "main",
    head: "fix-search",
    headSha: "abc1234",
  },
  state: "OPEN",
  draft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  checks: {
    total: 2,
    passing: [],
    failing: [check("test")],
    pending: [check("lint")],
    skipped: [],
    missingRequired: ["deploy-preview"],
  },
  review: {
    decision: "REVIEW_REQUIRED",
    approvedBy: [],
    changesRequestedBy: [],
    awaiting: [],
    requiredApprovals: 1,
  },
  rules: {
    readable: true,
    requiredChecks: ["test"],
    requiredApprovals: 2,
    strictUpToDate: true,
  },
  ...over,
});

test("a snapshot from the readiness verdict; renames count both paths", () => {
  expect(
    snapshotFromVerdict(verdict(), {
      files: [
        "src/search.ts",
        { filename: "src/db/new.ts", previous_filename: "src/db/old.ts" },
        { filename: "docs/incidents/runbook.md" },
      ],
      now: 0,
    }),
  ).toEqual({
    ghRepo: "acme/web",
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    headSha: "abc1234",
    base: "main",
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    requiredApprovals: 2,
    strictUpToDate: true,
    failingChecks: ["test"],
    pendingChecks: ["lint"],
    missingRequired: ["deploy-preview"],
    files: [
      "src/search.ts",
      "src/db/old.ts",
      "src/db/new.ts",
      "docs/incidents/runbook.md",
    ],
    fetchedAt: new Date(0).toISOString(),
  });
  const unread = snapshotFromVerdict(
    verdict({
      state: "MERGED",
      rules: {
        readable: false,
        requiredChecks: [],
        requiredApprovals: 0,
        strictUpToDate: false,
      },
    }),
    { files: null, mergeCommitSha: "9f9f9f9", now: 0 },
  );
  expect(unread).toMatchObject({
    files: null,
    rulesUnreadable: true,
    mergeCommitSha: "9f9f9f9",
    requiredApprovals: 1,
  });
  expect(prFilePaths(null)).toBeNull();
});

test("fetches a snapshot only for the incident's own repository", async () => {
  const targets: unknown[] = [];
  const { gh } = github({
    verdict: async (t) => {
      targets.push(t);
      return verdict({ state: "MERGED" });
    },
    files: async () => [{ filename: "src/search.ts" }],
    mergeCommit: async () => "9f9f9f9",
  });
  const repos = {
    ghRepoOf: (id: string) => (id === "acme" ? "Acme/Web" : "acme/api"),
  };
  const snap = await fetchPrSnapshot(
    { prUrl: "https://github.com/acme/web/pull/12", repoId: "acme", now: 0 },
    gh,
    repos,
  );
  expect(snap).toMatchObject({
    files: ["src/search.ts"],
    mergeCommitSha: "9f9f9f9",
    state: "MERGED",
  });
  expect(targets).toEqual([{ repoId: "acme", ghRepo: "acme/web", number: 12 }]);
  expect(
    await fetchPrSnapshot(
      {
        prUrl: "https://github.com/acme/web/pull/12",
        repoId: "acme-api",
        now: 0,
      },
      gh,
      repos,
    ),
  ).toEqual({ error: "PR belongs to another repository" });
  expect(
    await fetchPrSnapshot(
      { prUrl: "https://example.test/x", repoId: "acme", now: 0 },
      gh,
      repos,
    ),
  ).toEqual({ error: "Not a GitHub pull request URL" });
  const down = github({
    verdict: async () => {
      throw new Error("No PR #12 in acme/web");
    },
  });
  expect(
    await fetchPrSnapshot(
      { prUrl: "https://github.com/acme/web/pull/12", repoId: "acme", now: 0 },
      down.gh,
      repos,
    ),
  ).toEqual({ error: "No PR #12 in acme/web" });
  const noFiles = github({
    verdict: async () => verdict(),
    files: async () => {
      throw new Error("rate limited");
    },
  });
  expect(
    await fetchPrSnapshot(
      { prUrl: "https://github.com/acme/web/pull/12", repoId: "acme", now: 0 },
      noFiles.gh,
      repos,
    ),
  ).toMatchObject({ files: null });
});

test("a PR file list at GitHub's cap is unreadable, never a short list", () => {
  const line = (f: string, prev?: string) =>
    JSON.stringify(prev ? [f, prev] : [f, null]);
  expect(parsePrFileList(`${line("a.ts")}\n${line("b.ts", "c.ts")}\n`)).toEqual(
    [{ filename: "a.ts" }, { filename: "b.ts", previous_filename: "c.ts" }],
  );
  expect(parsePrFileList("not json\n")).toBeNull();
  const full = Array.from({ length: MAX_PR_FILES }, (_, i) => line(`f${i}.ts`));
  expect(parsePrFileList(full.join("\n"))).toBeNull();
  expect(parsePrFileList(full.slice(1).join("\n"))).toHaveLength(
    MAX_PR_FILES - 1,
  );
});
