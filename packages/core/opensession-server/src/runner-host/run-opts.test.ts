import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import type { RunHostSpec } from "./protocol";
import { runAgentOptsFromSpec } from "./run-opts";

/** Every field set, each to a value no other field shares. `Required` makes
 *  a new RunHostSpec field a type error here until the fixture names it. */
const spec: Required<RunHostSpec> = {
  hostId: "rh-acme",
  osSessionId: "session-acme",
  lifecycle: "session",
  transcriptTarget: "session",
  prompt: "fix the build",
  promptEntryId: "entry-acme",
  seedTranscriptEntries: [{ uuid: "seed-acme" } as unknown as TranscriptEntry],
  engineSessionId: "engine-acme",
  cwd: "/work/acme",
  mode: "code",
  mcpGrantUser: "owner@example.test",
  model: "pi/anthropic/claude-sonnet-5",
  selectedModel: "pi/anthropic/claude-fable-5-1",
  transientFallback: true,
  images: [{ mediaType: "image/png", data: "aW1n" }],
  files: [{ name: "notes.txt", data: "bm90ZXM=" }],
  forkSession: true,
  resumeSessionAt: "message-acme",
  mcpServers: ["acme-docs"],
  proxyMcpServers: ["opensession-acme"],
  mcpProxyMode: "in-process",
  rpcToken: "rpc-token-acme",
  remoteWorkspace: {
    provider: "daytona",
    sandboxId: "sandbox-acme",
    cwd: "/home/acme",
    scratchDir: "/home/acme/.scratch",
  },
  wsToken: "ws-token-acme",
  reposNote: "repos: acme/app",
  deniedTools: { bash: "not here" },
  webFetchHosts: ["docs.example.test"],
  publicationPolicy: {
    repo: "acme/app",
    branch: "main",
    headBranch: "fix-build",
  },
  bashRunAs: "acme-agent",
  confirmTools: { deploy: "confirm first" },
  aws: true,
  claudeCliEnv: true,
  codexCliEnv: true,
  author: { name: "Ada Acme", email: "ada@example.test" },
  user: "ada@example.test",
  accountUser: "owner@example.test",
  fallbackModel: "pi/openai/gpt-6.1-sol",
  accountAffinityKey: "affinity-acme",
  effort: "high",
  fastMode: true,
  speed: "fast",
  pstackMode: true,
  projectSkillsOnly: true,
  accountId: "account-acme",
  accountStrict: true,
  usageCredits: true,
  prReviewer: "acme/reviewers",
  readRepos: ["acme/shared"],
  attachedRepos: ["acme/web"],
  journalKind: "followup",
  firstJournaledAt: "2026-01-02T03:04:05.000Z",
  resumeAttempts: 2,
  lastResumeAt: "2026-01-02T04:05:06.000Z",
  trustProfile: "automation",
};

/** Run options the run reads under the spec's own name. */
const PASSED_AS_IS = [
  "prompt",
  "promptEntryId",
  "seedTranscriptEntries",
  "cwd",
  "mode",
  "mcpGrantUser",
  "model",
  "selectedModel",
  "transientFallback",
  "images",
  "files",
  "forkSession",
  "resumeSessionAt",
  "mcpServers",
  "reposNote",
  "deniedTools",
  "webFetchHosts",
  "publicationPolicy",
  "bashRunAs",
  "confirmTools",
  "aws",
  "claudeCliEnv",
  "codexCliEnv",
  "author",
  "user",
  "accountUser",
  "fallbackModel",
  "accountAffinityKey",
  "effort",
  "fastMode",
  "speed",
  "pstackMode",
  "projectSkillsOnly",
  "accountId",
  "accountStrict",
  "usageCredits",
  "prReviewer",
  "readRepos",
  "attachedRepos",
] as const;

/** Run options the run reads in another shape (checked below). */
const RESHAPED = [
  "osSessionId",
  "lifecycle",
  "engineSessionId",
  "rpcToken",
  "remoteWorkspace",
  "journalKind",
  "firstJournaledAt",
  "resumeAttempts",
  "lastResumeAt",
] as const;

/** Read by the host or its launcher, never by the run. */
const HOST_ONLY = [
  "hostId",
  "transcriptTarget",
  "proxyMcpServers",
  "mcpProxyMode",
  "wsToken",
  "trustProfile",
] as const;

describe("runAgentOptsFromSpec", () => {
  test("a pstack-mode spec runs in pstack mode", () => {
    expect(
      runAgentOptsFromSpec({ ...spec, pstackMode: true }, {}).pstackMode,
    ).toBe(true);
    expect(
      runAgentOptsFromSpec({ ...spec, pstackMode: undefined }, {}).pstackMode,
    ).toBeUndefined();
  });

  test("every run option in the spec reaches the run", () => {
    const opts = runAgentOptsFromSpec(spec, {}) as unknown as Record<
      string,
      unknown
    >;
    const dropped = PASSED_AS_IS.filter(
      (key) => !Bun.deepEquals(opts[key], spec[key]),
    );
    expect(dropped).toEqual([]);
  });

  test("reshaped fields arrive in the run's shape", () => {
    const onAskUser = async () => ({
      behavior: "deny" as const,
      message: "no",
    });
    const inProcessMcp = { "opensession-acme": {} };
    const opts = runAgentOptsFromSpec(spec, { inProcessMcp, onAskUser });
    expect(opts.sessionId).toBe("engine-acme");
    expect(opts.remoteWorkspace).toEqual({
      ...spec.remoteWorkspace,
      rpcToken: "rpc-token-acme",
    });
    expect(opts.journal).toEqual({
      osSessionId: "session-acme",
      kind: "followup",
      firstJournaledAt: "2026-01-02T03:04:05.000Z",
      resumeAttempts: 2,
      lastResumeAt: "2026-01-02T04:05:06.000Z",
    });
    expect(opts.inProcessMcp).toBe(inProcessMcp);
    expect(opts.onAskUser).toBe(onAskUser);

    const auxiliary = runAgentOptsFromSpec(
      { ...spec, lifecycle: "auxiliary", journalKind: undefined },
      {},
    );
    expect(auxiliary.journal).toEqual({
      kind: "prompt",
      firstJournaledAt: "2026-01-02T03:04:05.000Z",
      resumeAttempts: 2,
      lastResumeAt: "2026-01-02T04:05:06.000Z",
    });
  });

  test("every spec field is either a run option or the host's own", () => {
    expect(Object.keys(spec).sort()).toEqual(
      [...PASSED_AS_IS, ...RESHAPED, ...HOST_ONLY].sort(),
    );
  });
});
