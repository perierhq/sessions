import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { audit } from "./audit";
import type { RunToolPolicy } from "./run-policy";
import { guardStripeApprovalCall } from "./stripe-approvals";
import { stampIncidentDeclaration } from "./incident-declarations";
import { sessionLink } from "./run-instructions";
import type { MergeGuard, PrivateTermsGuard } from "./command-policy";
import type { RunAgentOpts } from "./agent-runner";
import type { PiSdk } from "./pi-runtime-binding";
import type { PiMcpBridge } from "./pi-mcp-bridge";
import {
  splitMcpMigrationBoundary,
  type createMcpRuntime,
} from "./mcp-runtime";
import {
  makeRemoteGrepExecute,
  makeRemoteToolOps,
  remoteCommandEnv,
  type RemoteWorkspace,
} from "./remote-workspace";
import {
  makeGuardedGrepExecute,
  makeGuardedToolOps,
  shippedSkillRoots,
} from "./pi-guarded-tools";
import { makePiBashTool } from "./pi-bash-tool";
import { piSteeringBoundaryTools } from "./pi-steering";
import { createWebFetchTool, createWebSearchTool } from "./pi-web-search";

/** Whether a steer is queued for the run. Closures read `pending` when they
 *  run, so a steer queued after the tools were built still holds them. */
export interface PiSteerBoundary {
  pending: boolean;
}

/**
 * The local workspace tools a run enables. Tool policy: ask mode is read-only
 * — no edit/write, and bash screened through ASK_BASH_PERMISSIONS
 * (askBashDenyReason), the same allowlist previous runner's ask agent enforces
 * engine-side. Shipping ask without bash at all was tried first and it blinded
 * every automation that assumed a shell for jq/git/gh reads (the
 * health-monitor incident, 2026-08-19). Code/scratch get the read set +
 * edit/write + the ungated custom bash. disableLocalWorkspaceTools
 * (engine-outside-sandbox) strips all local tools — pi has no sandbox mode,
 * but fail closed if a caller passes it.
 */
export function piLocalToolNames(opts: {
  isAsk: boolean;
  disableLocalWorkspaceTools?: boolean;
}): string[] {
  if (opts.disableLocalWorkspaceTools) return [];
  return opts.isAsk
    ? ["read", "grep", "find", "ls", "bash"]
    : ["read", "grep", "find", "ls", "edit", "write", "bash"];
}

/** The options a run's MCP runtime is created with. */
export function piMcpRuntimeOptions(input: {
  opts: RunAgentOpts;
  policy: RunToolPolicy;
  stripeApprovals: boolean;
  requestId: string;
}): Parameters<typeof createMcpRuntime>[0] {
  const { opts, policy, stripeApprovals, requestId } = input;
  const { mcpServers, user, journal } = opts;
  const mcpMounts = splitMcpMigrationBoundary(opts.inProcessMcp);
  return {
    mcpServers,
    user,
    mcpGrantUser: opts.mcpGrantUser,
    sessionUrl: journal?.osSessionId
      ? sessionLink(journal.osSessionId)
      : undefined,
    deniedToolIds: new Set(Object.keys(policy.disables)),
    inProcessMcp: mcpMounts.sdk,
    legacyProxyMcp: mcpMounts.legacyProxy,
    // An incident this run declares names the session it came from, so the
    // responder and the people in the channel can find the evidence.
    rewriteArgs: (tool, args) => {
      const link = journal?.osSessionId
        ? sessionLink(journal.osSessionId)
        : undefined;
      const stamped = stampIncidentDeclaration(tool.name, args, link);
      return stripeApprovals
        ? guardStripeApprovalCall(tool, stamped, link)
        : stamped;
    },
    onAudit: (e) =>
      audit({
        msg: "pi_mcp_call",
        request_id: requestId,
        session: journal?.osSessionId,
        server: e.server,
        tool: e.tool,
        ok: e.ok,
        ms: e.ms,
      }),
  };
}

/** The custom tool definitions a run registers, and whether codemode runs. */
export function buildPiToolset(input: {
  sdk: PiSdk;
  opts: RunAgentOpts;
  remote: RemoteWorkspace | undefined;
  bashEnv: Record<string, string>;
  runKey: string;
  requestId: string;
  model: string;
  localTools: string[];
  mcpBridge: PiMcpBridge;
  policy: RunToolPolicy;
  bashGated: boolean;
  mergeGuard: MergeGuard | undefined;
  privateTermsGuard: PrivateTermsGuard | undefined;
  abort: AbortController;
  boundary: PiSteerBoundary;
  /** The `web_search` tool's search (pi-web-search.ts); absent when Settings
   *  or the run's policy turns it off. */
  webSearch?: (query: string, signal: AbortSignal) => Promise<string>;
  /** The `web_fetch` tool's page read, gated the same way. */
  webFetch?: (
    page: { url: string; prompt?: string },
    signal: AbortSignal,
  ) => Promise<string>;
}): { customTools: ToolDefinition<any, any, any>[]; codemode: boolean } {
  const {
    sdk,
    opts,
    remote,
    bashEnv,
    runKey,
    requestId,
    model,
    localTools,
    mcpBridge,
    policy,
    bashGated,
    mergeGuard,
    privateTermsGuard,
    abort,
    boundary,
    webSearch,
    webFetch,
  } = input;
  const { cwd, journal } = opts;
  const isAsk = opts.mode === "ask";
  // Every enabled name is derived from a custom definition below. Pi falls
  // back to its in-process built-ins for a name without an override, so a
  // separately maintained enabled-name list would be a containment escape.
  const guardedOps = remote
    ? makeRemoteToolOps(remote, shippedSkillRoots())
    : makeGuardedToolOps(cwd);
  const commandEnv = remote
    ? remoteCommandEnv(bashEnv, remote, runKey, Boolean(opts.publicationPolicy))
    : bashEnv;
  const baseCustomTools: ToolDefinition<any, any, any>[] = [
    ...mcpBridge.discoveryTools,
    ...mcpBridge.directTools,
  ];
  for (const name of localTools) {
    switch (name) {
      case "read":
        baseCustomTools.push(
          sdk.createReadToolDefinition(cwd, {
            operations: guardedOps.read,
          }) as ToolDefinition<any, any, any>,
        );
        break;
      case "grep": {
        const base = sdk.createGrepToolDefinition(cwd);
        baseCustomTools.push({
          ...base,
          execute: remote
            ? makeRemoteGrepExecute(remote)
            : makeGuardedGrepExecute(cwd, bashEnv, guardedOps.guard),
        } as ToolDefinition<any, any, any>);
        break;
      }
      case "find":
        baseCustomTools.push(
          sdk.createFindToolDefinition(cwd, {
            operations: guardedOps.find,
          }) as ToolDefinition<any, any, any>,
        );
        break;
      case "ls":
        baseCustomTools.push(
          sdk.createLsToolDefinition(cwd, {
            operations: guardedOps.ls,
          }) as ToolDefinition<any, any, any>,
        );
        break;
      case "edit":
        baseCustomTools.push(
          sdk.createEditToolDefinition(cwd, {
            operations: guardedOps.edit,
          }) as ToolDefinition<any, any, any>,
        );
        break;
      case "write":
        baseCustomTools.push(
          sdk.createWriteToolDefinition(cwd, {
            operations: guardedOps.write,
          }) as ToolDefinition<any, any, any>,
        );
        break;
      case "bash":
        baseCustomTools.push(
          makePiBashTool({
            cwd,
            env: commandEnv,
            remote,
            gated: bashGated,
            askReadOnly: isAsk,
            unattended: policy.unattended,
            sessionId: journal?.osSessionId,
            runKind: journal?.kind,
            publicationPolicy: opts.publicationPolicy,
            // A remote workspace is its own boundary.
            ...(opts.bashRunAs && !remote ? { runAs: opts.bashRunAs } : {}),
            mergeGuard,
            privateTermsGuard,
            runSignal: abort.signal,
            onAudit: (event) =>
              audit({
                msg: `pi_command_${event.phase}`,
                request_id: requestId,
                run_key: runKey,
                session_id: journal?.osSessionId,
                run_kind: journal?.kind,
                model,
                ...event,
              }),
          }),
        );
        break;
    }
  }
  // Web search and fetch run on this side of any Sandbox, so it needs no Sandbox
  // egress. A run without local tools (a tool-less one-shot) gets none.
  if (webSearch && !opts.disableLocalWorkspaceTools)
    baseCustomTools.push(createWebSearchTool({ search: webSearch }));
  if (webFetch && !opts.disableLocalWorkspaceTools)
    baseCustomTools.push(createWebFetchTool({ fetch: webFetch }));
  const customTools = piSteeringBoundaryTools(
    baseCustomTools,
    () => boundary.pending,
  );
  // Codemode only orchestrates the tools above, so a run without any has
  // nothing for a script to call.
  const codemode = customTools.length > 0;
  return { customTools, codemode };
}

/** What a run put in front of the model: the `mcp-servers` standing record. */
export function piToolScopeRecord(input: {
  opts: RunAgentOpts;
  mcpBridge: PiMcpBridge;
  localTools: string[];
  policy: RunToolPolicy;
}) {
  const { opts, mcpBridge, localTools, policy } = input;
  const { mcpServers } = opts;
  return {
    engine: "pi",
    // Same contract as the choke point's: a non-array scope reads as
    // "all" and must never be spread.
    mcpScope: Array.isArray(mcpServers)
      ? [...mcpServers].sort()
      : (mcpServers ?? "all"),
    inProcess: Object.keys(opts.inProcessMcp || {}).sort(),
    // Post-policy catalog: denied ids are dropped before a definition is
    // ever built (pi-mcp-bridge), so these are the MCP tools the model
    // can actually reach through the two discovery tools.
    mcpTools: mcpBridge.tools.map((t) => t.name).sort(),
    discovery: mcpBridge.discoveryTools.map((t) => t.name).sort(),
    direct: mcpBridge.directTools.map((t) => t.name).sort(),
    // Pi's local tools are enabled by name and every name is backed by a
    // guarded custom definition (see the enabled-name list above).
    local: [...localTools].sort(),
    strip: Object.keys(policy.disables).sort(),
  };
}
