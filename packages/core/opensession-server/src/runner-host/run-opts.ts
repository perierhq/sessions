/**
 * The run options a detached run host hands to runAgent, built from its
 * spec.json. Kept out of host.ts (a script with top-level effects) so the
 * mapping can be tested: every run option the gateway writes into a
 * RunHostSpec must reach the run, the same way the in-process path passes it
 * (host-client.ts runAgentInProcess).
 */
import type { RunAgentOpts } from "../server/agent-runner";
import type { RunHostSpec } from "./protocol";

/** What only the host process itself can supply. */
export interface RunHostRunContext {
  /** opensession-* servers relayed over the run-rpc socket (mcp-mounts.ts). */
  inProcessMcp?: Record<string, unknown>;
  onAskUser?: RunAgentOpts["onAskUser"];
}

export function runAgentOptsFromSpec(
  spec: RunHostSpec,
  host: RunHostRunContext,
): RunAgentOpts {
  return {
    prompt: spec.prompt,
    promptEntryId: spec.promptEntryId,
    seedTranscriptEntries: spec.seedTranscriptEntries,
    sessionId: spec.engineSessionId || undefined,
    cwd: spec.cwd,
    remoteWorkspace: spec.remoteWorkspace
      ? { ...spec.remoteWorkspace, rpcToken: spec.rpcToken || "" }
      : undefined,
    mode: spec.mode,
    mcpGrantUser: spec.mcpGrantUser,
    model: spec.model,
    selectedModel: spec.selectedModel,
    transientFallback: spec.transientFallback,
    images: spec.images,
    files: spec.files,
    forkSession: spec.forkSession,
    resumeSessionAt: spec.resumeSessionAt,
    mcpServers: spec.mcpServers ?? "all",
    inProcessMcp: host.inProcessMcp,
    reposNote: spec.reposNote,
    deniedTools: spec.deniedTools,
    webFetchHosts: spec.webFetchHosts,
    publicationPolicy: spec.publicationPolicy,
    bashRunAs: spec.bashRunAs,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    claudeCliEnv: spec.claudeCliEnv,
    codexCliEnv: spec.codexCliEnv,
    author: spec.author,
    user: spec.user,
    accountUser: spec.accountUser,
    fallbackModel: spec.fallbackModel,
    accountAffinityKey: spec.accountAffinityKey,
    effort: spec.effort,
    fastMode: spec.fastMode,
    speed: spec.speed,
    pstackMode: spec.pstackMode,
    projectSkillsOnly: spec.projectSkillsOnly,
    accountId: spec.accountId,
    accountStrict: spec.accountStrict,
    usageCredits: spec.usageCredits,
    prReviewer: spec.prReviewer,
    readRepos: spec.readRepos,
    attachedRepos: spec.attachedRepos,
    journal: {
      ...(spec.lifecycle === "auxiliary"
        ? {}
        : { osSessionId: spec.osSessionId }),
      kind: spec.journalKind || "prompt",
      firstJournaledAt: spec.firstJournaledAt,
      resumeAttempts: spec.resumeAttempts,
      lastResumeAt: spec.lastResumeAt,
    },
    onAskUser: host.onAskUser,
  };
}
