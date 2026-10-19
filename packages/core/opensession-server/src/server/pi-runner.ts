/**
 * Pi coding-agent runner. Every production model id routes here.
 *
 * Security invariants:
 *  - run kinds are denied by default and unattended tools are stripped before registration;
 *  - built-in local tools are replaced with cwd-contained, minimal-environment overrides;
 *  - Anthropic and ChatGPT traffic use the server-managed account pools;
 *  - third-party providers receive only their configured API key;
 *  - sessions, transcript writes, steering, cancellation, retries and audit events all use
 *    Open Session's owned stores and detached run-host protocol.
 */

import { join } from "path";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { audit, summarizeText } from "./audit";
import { journalSet, buildRunJournalRecord, journalClear } from "./run-journal";
import { askBashDenyReason, describeUsageLimitReset } from "./runner-shared";
import { pickClaudeAccount } from "./claude-account-pick";
import {
  enableAnthropicPayloadCapture,
  enableAnthropicPromptCompat,
} from "./anthropic-prompt-compat";
import {
  enableAnthropicRateLimitCapture,
  formatAnthropicReset,
} from "./anthropic-rate-limit";
import { modelProviders, readModelProviderConfig } from "./model-providers";
import { bindXaiAccount, xaiSubscriptionModelEfforts } from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import { enableXaiProxyPayload } from "./xai-payload";
import {
  enableOpenaiFastMode,
  pickOpenaiAccount,
  buildSeededOpenaiAuth,
} from "./openai-auth";
import { sessionSpeed } from "@tellahq/opensession-protocol/session";
import { openaiServiceTier } from "./openai-service-tier";
import {
  logInjectedContext,
  logStandingContext,
  sessionStartContext,
} from "./context-log";
import { wrapContext } from "./prompt-context";
import {
  PI_TURN_CHECKPOINT_FILE,
  createPiTurnCheckpointWriter,
  interruptedReplyNote,
  repairInterruptedPiTurn,
  takePiTurnCheckpoint,
  type PiTurnCheckpointWriter,
  type PiTurnRepair,
} from "./pi-turn-checkpoint";
import { stagePromptImages, withImagesNote } from "./prompt-attachments";
import { EMPTY_REPLY_RETRY_PROMPT } from "./auto-continue";
import {
  recordEngineSessionOwner,
  transcriptLineCompactionSummary,
  transcriptLineUser,
  storeAppendUserLineEarly,
} from "./transcript-persistence";
import { transcript } from "./actor-transcript";
import { transcriptForwarder } from "./transcript-forward";
import { providerAccountUser } from "./session-actors";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { piEngineEnabled, piConfigPath } from "./pi-config";
import {
  createPiRuntimeBinding,
  prewarmPiSdk as prewarmPiSdkBinding,
} from "./pi-runtime-binding";
import { createPiMcpBridge, type PiMcpBridge } from "./pi-mcp-bridge";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import { expandSkillCommand } from "./skill-paths";
import {
  remoteAttachmentWriter,
  remoteWorkspaceForRun,
} from "./remote-workspace";
import type { TranscriptEntry } from "./types";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent, ImageInput } from "./run-events";
import { PI_PROVIDER, nowIso } from "./pi-common";
import {
  assistantRenderableBlockCount,
  contentToTextAndImages,
  persistEntries,
  piAppend,
  piAssistantTranscriptEntries,
  piImages,
} from "./pi-transcript";
import {
  buildPiThirdPartyProviderPlan,
  piModelResolutionError,
  resolvePiRoutedModel,
} from "./pi-model-routing";
import {
  aliasPiRun,
  claimPiRun,
  releasePiRun,
  retractPendingSteer,
  type PiRunHandle,
} from "./pi-run-registry";
import {
  PI_CODEMODE_TOOL,
  interruptPiThinkingForSteer,
  piResponseHasOutput,
  piToolNames,
} from "./pi-steering";
import { piGateReason } from "./pi-gate";
import { piErrorContent } from "./pi-usage-limit";
import {
  PiAttemptAccounts,
  evidencePoolRef,
  piStreamEventRequiresAccountContinuation,
  runPiAccountWalk,
  type PiAccountWalk,
} from "./pi-account-walk";
import { PiTurnLedger } from "./pi-turn-ledger";
import { resolvePiRunAuthority } from "./pi-run-authority";
import { buildPiBashEnv, piCliPoolEnv } from "./pi-run-env";
import {
  buildPiToolset,
  piLocalToolNames,
  piMcpRuntimeOptions,
  type PiSteerBoundary,
} from "./pi-tools";
import {
  findPiSessionFile,
  piThinkingLevel,
  preparePiResources,
} from "./pi-session-setup";

export { PI_STATE_DIR } from "./pi-common";
export {
  assistantRenderableBlockCount,
  piAssistantTranscriptEntries,
} from "./pi-transcript";
export {
  GIT_COAUTHOR_ENV,
  agentGitIdentityEnv,
  githubCodeRunEnv,
  githubReadReposRunEnv,
  githubReadRunEnv,
  runGithubEnv,
  runGithubMergeGuard,
  usesHostGithubLogin,
} from "./pi-github-env";
export {
  PI_MODEL_PREFIX,
  buildPiThirdPartyProviderPlan,
  parsePiModel,
  piModelResolutionError,
  resolvePiRoutedModel,
  type PiResolvedModel,
} from "./pi-model-routing";
export {
  assertContainedPiPath,
  makeGuardedGrepExecute,
  makeGuardedToolOps,
} from "./pi-guarded-tools";
export {
  makePiBashTool,
  piBashHomeEnv,
  type PiBashAuditEvent,
} from "./pi-bash-tool";
export {
  acceptSteerOnce,
  activePiRunCount,
  cancelPiRun,
  isPiSessionBusy,
  retractPendingSteer,
  retractPiSteer,
  steerPiRun,
} from "./pi-run-registry";
export {
  PI_CODEMODE_TOOL,
  PI_STEER_TOOL_SKIP,
  interruptPiThinkingForSteer,
  isPiNestedToolCall,
  piCodemodeExtension,
  piResponseHasOutput,
  piSteeringBoundaryTools,
  piToolNames,
  type PiSteerInterruptTarget,
} from "./pi-steering";
export { piGateReason } from "./pi-gate";
export { isPiUsageLimitShape, piErrorContent } from "./pi-usage-limit";
export { piStreamEventRequiresAccountContinuation } from "./pi-account-walk";
export { piLocalToolNames } from "./pi-tools";

const PROVIDER = PI_PROVIDER;

// ── SDK loading ──────────────────────────────────────────────────────────────

/**
 * Idempotent Pi SDK warm-up for the eventual boot call site. Boot wiring is
 * intentionally deferred until this extraction is reviewed; turns still load
 * the SDK on demand through createPiRuntimeBinding.
 */
export function prewarmPiSdk() {
  return prewarmPiSdkBinding();
}

// ── The turn ─────────────────────────────────────────────────────────────────

/**
 * One logical pi turn, across however many provider accounts it takes.
 *
 * This is previous runner-runner's account-rotation discipline, which pi lacked: a
 * usage limit ended the whole run while the rest of the pool sat idle, and
 * the sideline it recorded only helped the NEXT prompt. agent-runner cannot
 * rescue that either, because an explicit engine choice pins the model
 * fallback to "none" rather than silently crossing into an previous runner fallback,
 * so one capped account was simply the end of the turn.
 *
 * pi/openai, pi/xai-oauth and pi/anthropic pick their account once at bind
 * time (the credential is seeded before the SDK is even imported), so there
 * is no per-request catch to rotate from and the loop belongs here. Every
 * pool shares one contract: an exclusion set threaded into the picker and a
 * strict pin that refuses rather than moving onto an account the person did
 * not choose. Once output has streamed, retain
 * the native session and ask it to continue instead of replaying the prompt.
 */
export async function* runPi(
  opts: RunAgentOpts,
  model: string,
): AsyncGenerator<StreamEvent> {
  return yield* runPiAccountWalk((walk) => runPiAttempt(opts, model, walk));
}

async function* runPiAttempt(
  opts: RunAgentOpts,
  model: string,
  walk: PiAccountWalk,
): AsyncGenerator<StreamEvent> {
  // Config gate first: the clearest refusal when the engine is off entirely.
  if (!piEngineEnabled()) {
    yield {
      type: "error",
      content: `The Pi engine is not enabled (${piConfigPath()}). Set {"enabled": true} there to turn it on.`,
      provider: PROVIDER,
      model,
    };
    return;
  }
  const gateReason = piGateReason(opts);
  if (gateReason) {
    audit({
      msg: "pi_gate_denied",
      run_kind: opts.journal?.kind,
      session_id: opts.journal?.osSessionId,
      reason: gateReason,
    });
    yield { type: "error", content: gateReason, provider: PROVIDER, model };
    return;
  }
  const parsed = resolvePiRoutedModel(model);
  if (!parsed) {
    yield {
      type: "error",
      content: piModelResolutionError(model),
      provider: PROVIDER,
      model,
    };
    return;
  }
  const configuredProvider = modelProviders()[parsed.providerID];
  if (
    parsed.providerID !== "anthropic" &&
    parsed.providerID !== "openai" &&
    parsed.providerID !== XAI_OAUTH_PROVIDER &&
    !configuredProvider?.apiKey
  ) {
    yield {
      type: "error",
      content:
        `The Pi engine has no credentials for provider "${parsed.providerID}" ` +
        `(got "${model}"). Configure that model provider first.`,
      provider: PROVIDER,
      model,
    };
    return;
  }

  const { prompt, cwd, mode, mcpServers, confirmTools, journal, user } = opts;
  // `user` remains the exact prompt sender for MCP/GitHub policy and audit.
  // Provider accounts are different: synthetic continuation senders inherit
  // the interactive session owner's personal subscription, and a person who
  // prompts an automation-owned session (which passes no `user`) still
  // spends their own subscription through `accountUser`.
  const accountUser = providerAccountUser(
    opts.accountUser ?? user,
    opts.mcpGrantUser,
  );
  const isAsk = mode === "ask";
  const isScratch = mode === "scratch";
  // A Sandbox session: this loop runs here, its tools act in the Sandbox
  // (remote-workspace.ts). Resolved before anything touches a workspace, and
  // it throws without the run's token rather than fall back to this machine.
  const remote = opts.remoteWorkspace
    ? remoteWorkspaceForRun(opts.remoteWorkspace)
    : undefined;

  // The start token is the immutable physical dispatch identity. Engine and
  // Open Session ids are reusable aliases, so they must never fence a delayed
  // cancel against a successor turn.
  const runKey =
    opts.startToken ||
    opts.sessionId ||
    journal?.osSessionId ||
    crypto.randomUUID();
  const registeredKeys = new Set<string>([runKey]);
  if (opts.sessionId) registeredKeys.add(opts.sessionId);
  if (journal?.osSessionId) registeredKeys.add(journal.osSessionId);
  if (opts.transcriptSessionId) registeredKeys.add(opts.transcriptSessionId);
  const abort = new AbortController();
  const handle: PiRunHandle = { abort };
  if (!claimPiRun(registeredKeys, handle)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }

  // The unified session id every transcript row keys on; kind-only loop runs
  // may pass transcriptSessionId instead (map-only, never journaled).
  const unifiedSessionId = journal?.osSessionId || opts.transcriptSessionId;

  const requestId = crypto.randomUUID();
  const started = Date.now();
  const auditBase = {
    msg: "pi_turn",
    request_id: requestId,
    run_key: runKey,
    session: journal?.osSessionId,
    run_kind: journal?.kind,
    resume: opts.sessionId,
    model,
    mode: mode || "code",
  };
  const ledger = new PiTurnLedger(auditBase, started);
  // Utility callers such as oneShot deliberately have no unified session.
  // They still use Pi's native JSONL while alive, but must not emit degraded
  // transcript writes or create a ghost Open Session transcript.
  const persistRunEntries = (entries: TranscriptEntry[]) => {
    if (unifiedSessionId) persistEntries(ledger.piSessionId, entries);
  };
  const appendRunLines = (lines: Record<string, unknown>[]) => {
    if (unifiedSessionId && ledger.piSessionId)
      piAppend(ledger.piSessionId, lines);
  };
  let session: AgentSession | undefined;
  let mcpRuntime: McpRuntime | undefined;
  let mcpBridge: PiMcpBridge | undefined;
  let checkpointWriter: PiTurnCheckpointWriter | undefined;
  // Runs journaled before `speed` existed carry only fastMode.
  const speed = sessionSpeed(opts);
  // Which session an account pick belongs to: HRW affinity on the Codex and
  // SuperGrok pools.
  const affinity = opts.accountAffinityKey || journal?.osSessionId || cwd;
  // The native Claude pool remembers an account per session, never per
  // checkout: a run keyed only by its cwd (a one-shot, an automation) takes
  // the plain pool pick, so parallel runs in one checkout keep spreading.
  const claudeSessionKey =
    opts.accountAffinityKey || journal?.osSessionId || undefined;
  const accounts = new PiAttemptAccounts({
    walk,
    providerID: parsed.providerID,
    modelID: parsed.modelID,
    opts,
    accountUser,
    affinity,
    claudeSessionKey,
    speed,
    auditBase,
  });

  /** Take the rotation, or return false and let the caller surface the
   *  failure. Records the burn, audits the switch and closes this attempt's
   *  audit; runPi resumes or replays the attempt on the next account. It
   *  never sidelines: the caller decides that. */
  const takeAccountRotation = (
    errorText: string,
    why = "usage limit",
  ): boolean => {
    if (
      !accounts.rotate({
        errorText,
        why,
        sawStreamedOutput: ledger.sawStreamedOutput,
        sessionManager: session?.sessionManager,
      })
    )
      return false;
    ledger.reachedTerminal = true;
    ledger.end({
      ok: false,
      pi_session_id: ledger.piSessionId,
      ...ledger.usageAuditFields(),
      error: errorText,
    });
    return true;
  };

  // Everything from here on runs inside the try: a throw anywhere after the
  // registry writes above must still deregister in the finally, or the
  // session would report busy until the next restart.
  try {
    // Durability before the engine exists (the previous runner two-stage): journal
    // the run with its original prompt — no engine id and NO serverKey, so a
    // death here re-runs from scratch and a restart mid-turn takes the
    // continuation re-prompt path (nothing in-process survives to reattach) —
    // and persist the user line under the unified id with a stable uuid.
    // A replay must reuse the FIRST attempt's uuid: the store upserts by id,
    // so a freshly minted one would show the person's message twice.
    const userLine = transcriptLineUser(
      prompt,
      opts.promptEntryId || walk.promptEntryId,
      undefined,
      opts.images,
    );
    walk.promptEntryId ??= String(userLine.uuid);
    if (journal?.osSessionId) {
      await journalSet(
        buildRunJournalRecord(opts, {
          runKey,
          osSessionId: journal.osSessionId,
          claudeSessionId: opts.sessionId || undefined,
          prompt,
          promptEntryId: String(userLine.uuid),
          cwd,
          mode,
          mcpServers,
          user,
          confirmTools,
          model,
          effort: opts.effort,
          fastMode: opts.fastMode,
          speed: opts.speed,
          pstackMode: opts.pstackMode,
          accountId: opts.accountId,
          accountStrict: opts.accountStrict,
          usageCredits: opts.usageCredits,
          kind: journal.kind,
        }),
      );
      await storeAppendUserLineEarly(journal.osSessionId, userLine, {
        required: true,
      });
    }

    const {
      stripeApprovals,
      policy,
      bashGated,
      cwdRepo,
      publicRepo,
      privateTermsGuard,
      githubUserLogin,
      hostGithubLogin,
      githubEnv,
      agentGitEnv,
      mergeGuard,
    } = await resolvePiRunAuthority(opts, remote);
    const binding = await createPiRuntimeBinding({
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      configuredProvider,
      affinityKey: affinity,
      claudeSessionKey,
      unifiedSessionId: unifiedSessionId || runKey,
      accountUser,
      accountId: opts.accountId,
      accountStrict: opts.accountStrict,
      usageCredits: opts.usageCredits,
      speed,
      excludedOpenaiAccountIds: walk.excluded,
      onAccountEvidence: (evidence) => accounts.onEvidence(evidence),
      beforeRuntimeLoad: (evidence) => {
        const picked = evidencePoolRef(evidence, "picked");
        audit({
          ...auditBase,
          direction: "in",
          ...(picked
            ? {
                account: picked.masked,
                account_id: picked.id.slice(0, 8),
                pick_reason:
                  evidence.openaiPickReason ??
                  evidence.xaiPickReason ??
                  evidence.claudePickReason,
              }
            : {}),
          ...(policy.unattended
            ? { denied_tools: policy.noteGroups.flatMap((grp) => grp.tools) }
            : {}),
          ...summarizeText(prompt),
        });
      },
      dependencies: {
        readOpenaiAccounts: () => readModelProviderConfig()?.openaiAccounts,
        readXaiAccounts: () => readModelProviderConfig()?.xaiAccounts,
        pickOpenaiAccount,
        buildSeededOpenaiAuth,
        pickClaudeAccount,
        buildThirdPartyProviderPlan: buildPiThirdPartyProviderPlan,
        bindXaiAccount,
      },
    });
    const { sdk, runtime, model: piModel } = binding;

    const cliEnv = piCliPoolEnv({ opts, remote, accountUser, runKey });
    const bashEnv = await buildPiBashEnv({
      opts,
      remote,
      runKey,
      hostGithubLogin,
      agentGitEnv,
      githubEnv,
      cliEnv,
    });

    // One engine-neutral MCP runtime owns all connections for this logical
    // turn. Pi only adapts its exact catalog into tool_search/tool_call. The
    // detached runner-host proxy shape remains solely at this named migration
    // boundary until Agent operation routing replaces it.
    mcpRuntime = await createMcpRuntime(
      piMcpRuntimeOptions({ opts, policy, stripeApprovals, requestId }),
    );
    mcpBridge = await createPiMcpBridge(mcpRuntime);
    const localTools = piLocalToolNames({
      isAsk,
      disableLocalWorkspaceTools: opts.disableLocalWorkspaceTools,
    });
    const boundary: PiSteerBoundary = { pending: false };
    const { customTools, codemode } = buildPiToolset({
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
    });

    const { agentDir, sessionDir, settingsManager, loader, sessionContext } =
      await preparePiResources({
        opts,
        remote,
        runKey,
        unifiedSessionId,
        isAsk,
        isScratch,
        authority: {
          stripeApprovals,
          policy,
          cwdRepo,
          publicRepo,
          githubUserLogin,
          githubEnv,
          agentGitEnv,
        },
        binding,
        mcpBridge,
        localTools,
        codemode,
        boundary,
      });

    // Resume: the journaled engine id is pi's session-header uuid — find its
    // jsonl in this unified session's dir. Not found (rotated dir, pruned
    // file) → fresh session; the store already holds the unified history and
    // Cross-engine handoff notes ride the prompt. A detached host also gets a
    // server-read seed snapshot for the resume-miss case because it must never
    // open transcripts.db itself.
    const resumePath =
      !walk.continuation && opts.sessionId
        ? findPiSessionFile(sessionDir, opts.sessionId)
        : null;
    // Resume-miss bridge: pi's SessionManager buffers a session's jsonl until
    // its first ASSISTANT message, so a turn that died before any assistant
    // output (bridge 429 pre-token, instant cancel) journaled a piSessionId
    // that has NO file. Same engine ⇒ run-session builds no handoff note, and
    // a silently-fresh session would drop the model's context while the store
    // still shows the turns. Bridge it from the store ourselves.
    let resumeMissNote: string | null = null;
    if (
      !walk.continuation &&
      opts.sessionId &&
      !resumePath &&
      unifiedSessionId
    ) {
      try {
        const tail = (
          transcriptForwarder()
            ? opts.seedTranscriptEntries || []
            : (await transcript.readTail(unifiedSessionId, 200)).entries
        )
          // This turn's own prompt was already early-persisted — the model
          // gets it as the actual prompt, not as history.
          .filter((e) => e.id !== String(userLine.uuid));
        if (tail.length) {
          resumeMissNote = buildEngineSwitchHandoffNote({
            fromModel: model,
            fromProvider: PROVIDER,
            toProvider: PROVIDER,
            sameEngineRestart: true,
            entries: tail,
            maxEntries: 200,
            maxChars: 60_000,
          });
        }
      } catch (e) {
        console.warn("[pi-runner] resume-miss handoff build failed:", e);
      }
    }
    const sessionManager =
      walk.continuation ??
      (resumePath
        ? sdk.SessionManager.open(resumePath, sessionDir)
        : sdk.SessionManager.create(cwd, sessionDir));
    // A previous turn on this Pi session that died with its process left
    // tool calls without results and lost the reply it was streaming
    // (pi-turn-checkpoint.ts). Close those calls before the model sees the
    // session, and keep the reply for the prompt below.
    const checkpointPath = join(sessionDir, PI_TURN_CHECKPOINT_FILE);
    let turnRepair: PiTurnRepair | null = null;
    if (!walk.continuation && opts.sessionId && unifiedSessionId) {
      try {
        turnRepair = repairInterruptedPiTurn(
          resumePath ? sessionManager : null,
          await takePiTurnCheckpoint(checkpointPath, opts.sessionId),
        );
      } catch (e) {
        console.warn("[pi-runner] interrupted-turn repair failed:", e);
      }
    }

    const thinkingLevel = piThinkingLevel(opts.effort);

    const created = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: piModel,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      tools: [
        ...piToolNames(customTools),
        ...(codemode ? [PI_CODEMODE_TOOL] : []),
      ],
      customTools,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    // Pi's provider supports `service_tier`, but its simple-stream adapter
    // drops that option before building the Codex request. Patch the final
    // payload instead. Restrict this to seeded ChatGPT OAuth credentials: API
    // key accounts use ordinary OpenAI billing and are not the subscription
    // fast mode exposed by the clients.
    // Ultrafast additionally needs GPT-6 Astra and a Pro $500 login; any
    // other account the picker had to fall back to still runs at Fast.
    const serviceTier = binding.usesOpenaiOAuth
      ? openaiServiceTier({
          speed,
          model: parsed.modelID,
          plan: binding.openaiPlan,
        })
      : undefined;
    if (serviceTier) {
      enableOpenaiFastMode(session.agent, serviceTier);
      if (speed === "ultrafast") {
        audit({
          msg: "openai_service_tier",
          run_kind: journal?.kind,
          session_id: journal?.osSessionId,
          model: parsed.modelID,
          service_tier: serviceTier,
          plan: binding.openaiPlan,
          engine: "pi",
        });
      }
    }
    // Native Anthropic subscription turns reword a few lines of pi's stock
    // prompt in every request (anthropic-prompt-compat.ts). Same hook. pi's
    // compaction and branch summaries bypass agent.onPayload; their prompts
    // carry none of those lines (see enableAnthropicPromptCompat).
    if (binding.usesNativeAnthropic) {
      enableAnthropicPromptCompat(session.agent);
      // Opt-in diagnostics: OPENSESSION_DEBUG_ANTHROPIC_PAYLOAD_DIR writes the
      // final request body of each native Anthropic call to that directory
      // (mode 0600). Request bodies carry no credentials; auth is a header.
      enableAnthropicPayloadCapture(
        session.agent,
        process.env.OPENSESSION_DEBUG_ANTHROPIC_PAYLOAD_DIR,
        unifiedSessionId || runKey,
      );
      // pi's error text for a failed request drops the response headers, and
      // its onResponse hook never sees a 429: read the limit status and reset
      // off each response here instead.
      enableAnthropicRateLimitCapture(session.agent, (snapshot) => {
        accounts.rateLimit = snapshot;
      });
    }
    // SuperGrok turns ride the cli-chat-proxy, which rejects several stock
    // Responses fields (xai-payload.ts). Same hook, no host extension.
    if (binding.usesXaiProxy) {
      enableXaiProxyPayload(session.agent, {
        modelId: parsed.modelID,
        sessionId: unifiedSessionId || runKey,
        reasoning: piModel.reasoning,
        effortCapable: xaiSubscriptionModelEfforts(parsed.modelID).length > 0,
      });
    }
    // The first complete provider input only exists after Pi has combined its
    // base prompt with Open Session instructions, AGENTS.md, skills and active
    // tool guidance. Record it once for the collapsed transcript-start audit
    // row. Later turns can change ambient memory, but this row deliberately
    // answers what preceded the session's initial message.
    // The agent's tools are the declarations as sent, after codemode adds
    // itself and appends each tool's script signature to its description.
    if (!opts.sessionId && !walk.continuation) {
      await logStandingContext({
        sessionId: unifiedSessionId,
        turnId: opts.promptEntryId || opts.startToken,
        source: "session-start",
        content: sessionStartContext(
          session.systemPrompt,
          session.state.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        ),
      });
    }
    // previous runner appends every pending noReply steer before its next LLM step.
    // Match that behavior instead of Pi's one-message-per-step default.
    session.setSteeringMode("all");
    ledger.piSessionId = session.sessionId;
    if (unifiedSessionId) {
      checkpointWriter = createPiTurnCheckpointWriter(
        checkpointPath,
        ledger.piSessionId,
      );
    }

    // Map pi→unified BEFORE any engine-keyed append (the W1 import-first gate
    // resolves through this map; unmapped appends are dropped + degraded).
    if (unifiedSessionId)
      recordEngineSessionOwner(ledger.piSessionId, unifiedSessionId);

    // Journal upgrade: the record now carries the engine id (still no
    // serverKey — boot must take the continuation re-prompt path).
    if (journal?.osSessionId) {
      await journalSet(
        buildRunJournalRecord(opts, {
          runKey,
          osSessionId: journal.osSessionId,
          claudeSessionId: ledger.piSessionId,
          prompt,
          promptEntryId: String(userLine.uuid),
          cwd,
          mode,
          mcpServers,
          user,
          confirmTools,
          model,
          effort: opts.effort,
          fastMode: opts.fastMode,
          speed: opts.speed,
          pstackMode: opts.pstackMode,
          accountId: opts.accountId,
          accountStrict: opts.accountStrict,
          usageCredits: opts.usageCredits,
          kind: journal.kind,
        }),
      );
    }

    // Register the engine-id alias + the steer surface on the shared handle.
    aliasPiRun(registeredKeys, ledger.piSessionId, handle);
    const liveSession = session;
    // Steer contract: accept = enqueue + receipt. The transcript user line is
    // written only when the queued message is actually DELIVERED (its user
    // message_end below) — session.steer() resolves at enqueue time, so a
    // .then() would confirm nothing, and an optimistically-persisted line
    // marks an undelivered steer as said (queue-state reconciles receipts
    // against transcript user texts, so it would never be requeued). An
    // undelivered steer keeps its run-session receipt as the recovery
    // affordance — previous runner's failed-POST semantics.
    const pendingSteers: Array<{
      text: string;
      images?: ImageInput[];
      steerId?: string;
    }> = [];
    // Every touch of pi's queue goes through this chain, in call order. The
    // bookkeeping above it (pending entry, boundary flag, the caller's
    // receipt) stays synchronous; only the engine enqueue waits, because
    // staging an attachment is async and an in-process run shares the
    // gateway's event loop. Ordering the retraction rebuild on the same
    // chain means a steer still being staged is never enqueued twice, and a
    // steer retracted mid-staging is never enqueued at all.
    let engineQueue: Promise<void> = Promise.resolve();
    // Steps still to run or running. The pump below reads it before trusting
    // pi's pendingMessageCount: a steer accepted just before the prompt
    // settled may not have reached pi's queue yet.
    let engineQueueDepth = 0;
    const onEngineQueue = (step: () => Promise<void>, what: string) => {
      engineQueueDepth++;
      engineQueue = engineQueue
        .then(step)
        .catch((e) => {
          console.warn(`[pi-runner] ${what} failed:`, e);
        })
        .finally(() => {
          engineQueueDepth--;
        });
    };
    // Set when a steer cut the current response short while it was only
    // thinking. Its message_end then persists nothing: the thinking was
    // superseded, and the next response starts from the steer.
    let steerCutResponse = false;
    const interruptForSteer = () => {
      if (abort.signal.aborted) return;
      if (!interruptPiThinkingForSteer(liveSession.agent)) return;
      steerCutResponse = true;
      audit({
        ...auditBase,
        direction: "in",
        kind: "steer_interrupted_response",
      });
    };
    handle.steer = (text, images, steerId) => {
      // Same skill expansion as the prompt path. The queue holds the expanded
      // text so the delivery match stays exact; the audit line below still
      // records what the person typed.
      const entry = {
        text: expandSkillCommand(text, loader.getSkills().skills),
        images,
        steerId,
      };
      boundary.pending = true;
      pendingSteers.push(entry);
      onEngineQueue(async () => {
        // Attached images are staged into this run's scratch dir, in this
        // process, so the note names paths the engine's tools can read (see
        // prompt-attachments.ts). The pending entry holds the noted text
        // before pi ever sees it: delivery matches pi's echo against it, and
        // a retraction replays it verbatim.
        entry.text = withImagesNote(
          entry.text,
          await stagePromptImages(
            opts.scratchDir,
            images,
            remote ? remoteAttachmentWriter(remote) : undefined,
          ),
        );
        if (!pendingSteers.includes(entry)) return; // retracted meanwhile
        await liveSession.steer(entry.text, piImages(images));
        interruptForSteer();
      }, "steer");
      audit({
        ...auditBase,
        direction: "in",
        kind: "steer_queued",
        ...summarizeText(text),
      });
    };
    handle.retractSteer = (steerId) =>
      retractPendingSteer(pendingSteers, steerId, (remaining) => {
        // Pi exposes exact delivery identity only in our wrapper. Rebuild its
        // whole queue from our richer copy so duplicate text and images keep
        // their original order while the selected id disappears. The entries
        // are read when the step runs, so one still being staged replays with
        // its final (noted) text.
        boundary.pending = remaining.length > 0;
        onEngineQueue(async () => {
          liveSession.clearQueue();
          for (const steer of remaining) {
            if (!pendingSteers.includes(steer)) continue; // delivered or retracted since
            await liveSession.steer(steer.text, piImages(steer.images));
          }
        }, "steer replay");
        audit({
          ...auditBase,
          direction: "in",
          kind: "steer_retracted",
          steer_id: steerId,
        });
      });

    // Cancellation: our registry AbortController drives session.abort().
    const onAbort = () => {
      void liveSession.abort().catch(() => {});
    };
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", onAbort, { once: true });

    // ── Event pump: callback subscription → this generator's queue ──────────
    const queue: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (ev: StreamEvent) => {
      if (piStreamEventRequiresAccountContinuation(ev))
        ledger.sawStreamedOutput = true;
      queue.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };

    push({
      type: "init",
      sessionId: ledger.piSessionId,
      provider: PROVIDER,
      model,
    });
    // Engine-keyed write of the turn's user line — same uuid as the early
    // store write, so the row upserts instead of duplicating the bubble.
    appendRunLines([userLine]);

    if (turnRepair && (turnRepair.reply || turnRepair.toolResults.length)) {
      const recovered: TranscriptEntry[] = [];
      if (turnRepair.reply) {
        recovered.push(
          ...piAssistantTranscriptEntries(
            [{ type: "text", text: turnRepair.reply.text }],
            turnRepair.reply.startedAt,
            parsed.modelID,
            turnRepair.reply.id,
          ),
        );
      }
      for (const result of turnRepair.toolResults) {
        recovered.push({
          id: `${result.toolCallId}-result`,
          type: "tool_result",
          content: result.text,
          timestamp: nowIso(),
          toolUseId: result.toolCallId,
          isError: true,
        });
      }
      const calls = turnRepair.toolResults.length;
      const notice = [
        "The previous turn stopped unexpectedly.",
        turnRepair.reply ? "Its unfinished reply is kept above." : "",
        calls
          ? `${calls === 1 ? "1 tool call" : `${calls} tool calls`} it was running ${calls === 1 ? "is" : "are"} marked as interrupted.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      recovered.push({
        id: crypto.randomUUID(),
        type: "system",
        content: notice,
        timestamp: nowIso(),
      });
      persistRunEntries(recovered);
      push({ type: "runner_notice", text: notice });
      audit({
        ...auditBase,
        direction: "in",
        kind: "interrupted_turn_repaired",
        reply_chars: turnRepair.reply?.text.length ?? 0,
        tool_calls: calls,
      });
    }
    if (resumeMissNote) {
      const notice =
        "Pi couldn't resume the previous engine session. " +
        "Continuing in a fresh one with the recent transcript.";
      push({ type: "runner_notice", text: notice });
      persistRunEntries([
        {
          id: crypto.randomUUID(),
          type: "system",
          content: notice,
          timestamp: nowIso(),
        },
      ]);
    }
    // What the ENGINE receives; journal/store keep the raw prompt. Fenced the
    // way every other injection is (prompt-context.ts): the fence is what
    // makes the payload readable to the context log, and it keeps the note
    // from reading as something the human typed.
    // "/bro" (or "/skill:bro") becomes the skill's body before the engine sees
    // it. Expanded here rather than by pi for two reasons: a bare "/name"
    // works, which is what the composer's "/" menu inserts, and this text
    // stays identical to the user message pi echoes back, which the
    // steer-delivery check below compares against.
    const promptWithSkill = expandSkillCommand(
      prompt,
      loader.getSkills().skills,
    );
    const promptForEngine = [
      wrapContext(sessionContext, "session"),
      ...(resumeMissNote ? [wrapContext(resumeMissNote, "handoff")] : []),
      ...(turnRepair?.reply
        ? [
            wrapContext(
              interruptedReplyNote(turnRepair.reply.text),
              "restart-recovery",
            ),
          ]
        : []),
      walk.continuation
        ? wrapContext(
            "The previous account reached its usage limit. Continue the unfinished task from the existing conversation and completed tool results. Do not restart the task or repeat completed actions. Finish with a reply to the user.",
            "auto-continue",
          )
        : promptWithSkill,
    ].join("\n\n");
    // Injected BELOW runOnModel's choke point, so that call never saw this
    // payload — log it here, exactly as the previous runner runner does for its own
    // same-engine-restart handoff. Re-logging is free: entry ids are
    // content-derived, so an overlap upserts one row instead of duplicating.
    if (promptForEngine !== prompt) {
      logInjectedContext({
        sessionId: unifiedSessionId,
        turnId: opts.promptEntryId || opts.startToken,
        prompt: promptForEngine,
        model,
      });
    }

    // Final assistant outcome (stopReason error/aborted → terminal error).
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    // Renderable content blocks (real text or tool calls) of the LATEST
    // assistant message; -1 = none seen yet. Providers occasionally return a
    // well-formed completion with ZERO content blocks and stopReason "stop"
    // (2026-08-21 os-01a02486: GLM-5.3's pre-release OpenRouter route ended a
    // 10-minute turn on content:[] with all-zero usage). pi settles that as a
    // clean turn, so the session goes idle with no summary and the user has
    // to ask "done?". The pump loop retries such finishes once.
    let lastAssistantRenderableBlocks = -1;

    // Content persistence rides message_end/compaction_end. entry_appended is
    // deliberately unhandled: it fires ONLY for extension custom entries
    // (dist agent-session.js emits it solely from the extension runtime's
    // appendEntry helper), never for messages or compactions. The one
    // extension here is codemode, whose `codemode-store` entries are script
    // state for pi's own session file, not transcript content.
    const unsubscribe = session.subscribe((ev: AgentSessionEvent) => {
      try {
        checkpointWriter?.observe(ev);
        switch (ev.type) {
          case "message_start":
            // A steer queued while the request was in flight, before its
            // first token, cuts the response as soon as it starts.
            if ((ev as any).message?.role === "assistant") interruptForSteer();
            break;
          case "message_update": {
            const ame = (ev as any).assistantMessageEvent;
            if (
              (ame?.type === "text_delta" || ame?.type === "thinking_delta") &&
              typeof ame.delta === "string"
            ) {
              // The live transcript has one prose stream. Thinking and ordinary
              // model output both ride it rather than leaving reasoning blank
              // until message_end persists the provider's separate blocks.
              push({ type: "text_chunk", text: ame.delta });
            }
            break;
          }
          case "tool_execution_start": {
            const t = ev as any;
            // A codemode script's own calls never reach pi's transcript, so
            // a live card for one would vanish on reload. The codemode
            // call's card stands for them.
            if (t.parentToolCallId) break;
            push({
              type: "tool_use",
              toolName: String(t.toolName || "tool"),
              toolInput: t.args ?? {},
              toolUseId: String(t.toolCallId),
            });
            break;
          }
          case "tool_execution_end": {
            const t = ev as any;
            if (t.parentToolCallId) break;
            const { text, images } = contentToTextAndImages(t.result?.content);
            // `content`, not `result`: stream consumers read event.content
            // (run-session's stream_tool_result). 500-char preview like
            // previous runner — the full text reaches the store via the toolResult
            // message_end below and upserts over the streamed copy.
            push({
              type: "tool_result",
              toolUseId: String(t.toolCallId),
              content: text.length > 500 ? `${text.slice(0, 500)}...` : text,
              ...(images.length ? { images } : {}),
            });
            break;
          }
          case "message_end": {
            const msg = (ev as any).message;
            if (!msg) break;
            const ts = new Date(
              typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
            ).toISOString();
            if (msg.role === "assistant") {
              lastStopReason = msg.stopReason;
              lastErrorMessage = msg.errorMessage;
              lastAssistantRenderableBlocks = assistantRenderableBlockCount(
                msg.content,
              );
              const u = msg.usage;
              if (ledger.foldAssistantUsage(u)) {
                push({ type: "usage_snapshot", usage: ledger.snapshot() });
              }
              // Persist thinking, text, and tool calls now (messages have no
              // SDK id, while block ids are the model's and stay stable).
              // Error-stopped attempts are skipped: auto-retry replays them
              // and the terminal error carries the failure text — persisting
              // each attempt would stack duplicate partial bubbles. Aborted
              // partials DO persist (parity with pi's own jsonl).
              const cutBySteer = steerCutResponse;
              steerCutResponse = false;
              if (
                cutBySteer &&
                msg.stopReason === "aborted" &&
                !piResponseHasOutput(msg.content)
              ) {
                // Superseded thinking: keep it out of the transcript.
              } else if (msg.stopReason !== "error") {
                persistRunEntries(
                  piAssistantTranscriptEntries(msg.content, ts, parsed.modelID),
                );
              }
            } else if (msg.role === "toolResult" && msg.toolCallId) {
              const { text, images } = contentToTextAndImages(msg.content);
              persistRunEntries([
                {
                  id: `${msg.toolCallId}-result`,
                  type: "tool_result",
                  content: text,
                  timestamp: ts,
                  toolUseId: String(msg.toolCallId),
                  ...(msg.isError ? { isError: true } : {}),
                  ...(images.length ? { images } : {}),
                },
              ]);
            } else if (msg.role === "user") {
              // A user message_end is the DELIVERY signal for a steer (the
              // agent loop emits message_start/end when it injects a queued
              // steering message; the turn's own prompt also lands here and
              // is skipped — it was persisted with its stable uuid up front).
              const { text, images } = contentToTextAndImages(msg.content);
              if (text && text !== promptForEngine && text !== prompt) {
                let idx = pendingSteers.findIndex((s) => s.text === text);
                // Skill/template expansion can rewrite a queued steer's text;
                // any user message that isn't the prompt is a delivery, so
                // fall back to the oldest pending steer but persist what was
                // actually delivered.
                if (idx === -1 && pendingSteers.length > 0) idx = 0;
                if (idx !== -1) {
                  const steer = pendingSteers.splice(idx, 1)[0];
                  boundary.pending = pendingSteers.length > 0;
                  // Transcript parsing deliberately strips fenced system
                  // context. A background-wait steer can therefore be fully
                  // delivered yet leave no visible user entry for receipt
                  // reconciliation. Acknowledge the exact queue id at the
                  // engine boundary instead of making UI state infer delivery
                  // from display-sanitized transcript text.
                  if (steer.steerId) {
                    push({ type: "steer_delivered", steerId: steer.steerId });
                  }
                  audit({
                    ...auditBase,
                    direction: "in",
                    kind: "steer_injected",
                    ...summarizeText(text),
                  });
                  const srcs = images.length
                    ? images
                    : (steer.images || []).map(
                        (im) => `data:${im.mediaType};base64,${im.data}`,
                      );
                  persistRunEntries([
                    {
                      // Steering admission already wrote the visible user row.
                      // Reuse its id so engine delivery upserts that bubble
                      // instead of appending a duplicate.
                      id: steer.steerId || crypto.randomUUID(),
                      type: "user",
                      content: text,
                      timestamp: ts,
                      ...(srcs.length ? { images: srcs } : {}),
                    },
                  ]);
                }
              }
            }
            break;
          }
          case "compaction_end": {
            const ce = ev as any;
            if (!ce.aborted && ce.result?.summary) {
              try {
                appendRunLines([
                  transcriptLineCompactionSummary(
                    String(ce.result.summary),
                    crypto.randomUUID(),
                    nowIso(),
                  ),
                ]);
              } catch {}
              // The summarization LLM call is billed like any other — fold it
              // so usage_snapshot/done don't under-report on exactly the most
              // expensive turns. contextTokens is left alone: it tracks live
              // conversation context and the next assistant message_end
              // re-derives it post-compaction.
              const cu = ce.result.usage;
              if (ledger.foldCompactionUsage(cu)) {
                push({ type: "usage_snapshot", usage: ledger.snapshot() });
              }
            }
            break;
          }
          case "auto_retry_start": {
            const r = ev as any;
            const errText = String(r.errorMessage || "");
            if (accounts.isUsageLimit(errText)) {
              // Usage-limit shapes mean the pool can't serve right now —
              // retrying only delays the fallback walk. abortRetry() cancels
              // the backoff sleep; the microtask matters: the SDK arms the
              // retry AbortController right AFTER emitting this event, so a
              // synchronous call would find nothing to abort.
              queueMicrotask(() => {
                try {
                  liveSession.abortRetry();
                } catch {}
              });
            } else {
              // Make the silent wait visible — pi retries transient provider
              // errors (3x, exponential from 2s) with no output in between.
              const notice = `pi auto-retry ${r.attempt}/${r.maxAttempts} in ${Math.round(
                (r.delayMs || 0) / 1000,
              )}s — ${errText.slice(0, 300)}`;
              push({ type: "runner_notice", text: notice });
              persistRunEntries([
                {
                  id: crypto.randomUUID(),
                  type: "system",
                  content: notice,
                  timestamp: nowIso(),
                },
              ]);
            }
            break;
          }
          case "agent_settled":
            ledger.sawSettled = true;
            break;
        }
      } catch (err) {
        console.warn("[pi-runner] event mapping failed:", err);
      }
    });

    // prompt() resolves after the full accepted run (steers + retries
    // included) — the authoritative end; pre-flight failures reject. A cancel
    // that landed before this point must not start the run at all —
    // session.abort() only stops a run already in flight.
    let promptOutcome: { ok: boolean; error?: unknown } | null = null;
    const settlePrompt = (outcome: { ok: boolean; error?: unknown }) => {
      promptOutcome = outcome;
      // Same tick as the outcome, BEFORE the pump wakes: steers accepted from
      // here on could only queue into a settling/soon-disposed session, so
      // steerPiRun must return false and let run-session queue them for the
      // next turn instead.
      handle.steer = undefined;
      const w = wake;
      wake = null;
      w?.();
    };
    if (abort.signal.aborted) {
      promptOutcome = { ok: true };
      handle.steer = undefined;
    } else {
      void session
        .prompt(promptForEngine, {
          images: walk.continuation ? undefined : piImages(opts.images),
          expandPromptTemplates: false,
        })
        .then(
          () => settlePrompt({ ok: true }),
          (e: unknown) => settlePrompt({ ok: false, error: e }),
        );
    }

    // Tail-race drain budget: a steer accepted between the agent loop's final
    // steering poll and settlePrompt sits in the in-memory queue that
    // dispose() would discard — while steerPiRun already returned true and
    // run-session dropped the message from its own queue. Drive it through a
    // real continuation run (the same agent.continue() the SDK uses for
    // agent_end-queued messages; the constructor-lifetime event subscription
    // keeps streaming/persisting) instead of losing it.
    let steerDrains = 0;
    // One bounded continuation for an empty final completion (see
    // lastAssistantRenderableBlocks). The nudge is fenced like every other
    // injection, so the transcript never shows it as a user bubble.
    let emptyFinishRetries = 0;
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (promptOutcome) {
        if (engineQueueDepth > 0) {
          // An accepted steer is still being staged, so pi's queue count is
          // not final yet. steerPiRun already told the caller "accepted";
          // finishing now would drop it silently. Wait for the chain, then
          // re-read everything (more steers may have joined meanwhile).
          await engineQueue;
          continue;
        }
        if (
          promptOutcome.ok &&
          !abort.signal.aborted &&
          liveSession.pendingMessageCount > 0 &&
          steerDrains < 2
        ) {
          steerDrains++;
          promptOutcome = null;
          void Promise.resolve()
            .then(() => liveSession.agent.continue())
            .then(
              () => settlePrompt({ ok: true }),
              (e: unknown) => settlePrompt({ ok: false, error: e }),
            );
          continue;
        }
        if (
          promptOutcome.ok &&
          !abort.signal.aborted &&
          emptyFinishRetries < 1 &&
          lastStopReason === "stop" &&
          lastAssistantRenderableBlocks === 0
        ) {
          emptyFinishRetries++;
          const notice =
            "Model returned an empty response — asking it once more to finish its reply";
          push({ type: "runner_notice", text: notice });
          promptOutcome = null;
          void session
            .prompt(wrapContext(EMPTY_REPLY_RETRY_PROMPT, "auto-continue"), {
              expandPromptTemplates: false,
            })
            .then(
              () => settlePrompt({ ok: true }),
              (e: unknown) => settlePrompt({ ok: false, error: e }),
            );
          continue;
        }
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (queue.length) yield queue.shift()!;
    unsubscribe();
    if (pendingSteers.length > 0) {
      // Accepted but never delivered (drain budget exhausted or the run
      // failed): no transcript line was written, so on the failure paths the
      // receipt survives as the recovery affordance; on a done terminal the
      // loss is at least audited instead of silent.
      audit({
        ...auditBase,
        direction: "out",
        kind: "steer_undelivered",
        count: pendingSteers.length,
      });
    }

    // ── Terminal (at most one; user cancels end with none) ──────────────────
    const failed: { ok: boolean; error?: unknown } = promptOutcome!;
    if (
      failed.ok &&
      lastStopReason === "stop" &&
      lastAssistantRenderableBlocks === 0
    ) {
      // The retry (if it ran) also came back empty — never end silently on a
      // provider glitch; leave a visible chip explaining the missing reply.
      persistRunEntries([
        {
          id: crypto.randomUUID(),
          type: "system",
          content:
            "The model ended this turn with an empty response (no text or tool calls)" +
            (emptyFinishRetries > 0
              ? " and an automatic retry produced nothing too. Send another message to continue."
              : "."),
          timestamp: nowIso(),
        },
      ]);
    }
    if (abort.signal.aborted) {
      // User cancel ends QUIETLY — no terminal event, the generator just
      // returns (previous runner-runner's MessageAbortedError exemption). A terminal
      // error here would take run-session's full failure path: a persisted
      // "Run failed" chip, lastRunError/Needs-input state, and a parent
      // notified its worker FAILED because a human pressed Stop. The finally
      // records the cancelled audit closer and clears the journal; the
      // already-fired session.abort() stopped the engine.
      ledger.reachedTerminal = true;
      return;
    }
    // Usage-limit terminal on a pi/openai run: sideline the picked codex
    // account BEFORE yielding, so the fallback walk's next hop (and every
    // other engine's pick) skips it — shared sideline state with previous runner,
    // same per-(account, model) key.
    const sidelineOnUsageLimit = (usageLimit: boolean, message: string) => {
      if (usageLimit) {
        accounts.sideline(message);
      }
    };
    let terminal: StreamEvent;
    let terminalUsageLimit = false;
    let terminalMessage = "";
    if (!failed.ok) {
      const message = String((failed.error as Error)?.message || failed.error);
      terminalMessage = message;
      const usageLimit = accounts.isUsageLimit(message);
      terminalUsageLimit = usageLimit;
      sidelineOnUsageLimit(usageLimit, message);
      terminal = {
        type: "error",
        content: piErrorContent(message, parsed.providerID),
        provider: PROVIDER,
        model,
        ...ledger.usageField(),
        ...(usageLimit ? { usageLimitExhausted: true } : {}),
      };
    } else if (lastStopReason === "error" || lastStopReason === "aborted") {
      const message =
        lastErrorMessage || `run ended with stopReason ${lastStopReason}`;
      terminalMessage = message;
      const usageLimit = accounts.isUsageLimit(message);
      terminalUsageLimit = usageLimit;
      sidelineOnUsageLimit(usageLimit, message);
      terminal = {
        type: "error",
        content: piErrorContent(message, parsed.providerID),
        provider: PROVIDER,
        model,
        ...ledger.usageField(),
        ...(usageLimit ? { usageLimitExhausted: true } : {}),
      };
    } else {
      terminal = {
        type: "done",
        sessionId: ledger.piSessionId,
        result: session.getLastAssistantText() || undefined,
        provider: PROVIDER,
        model,
        ...ledger.usageField(),
      };
    }
    // Rotate rather than end the turn. This is the COMMON half of the walk:
    // a provider usage limit normally arrives as an in-band terminal (pi's
    // own error result), not as a throw, so without this the openai walk
    // would only ever engage on pre-init failures. A mid-turn limit retains
    // the native session so the next account continues completed work.
    if (terminalUsageLimit && takeAccountRotation(String(terminal.content))) {
      return;
    }
    // A native 429 that was not the subscription's limit (its unified status
    // was not "rejected") went to pi's retry. When pi gave up on it, try the
    // turn once on another account. The account is not benched: its limit
    // is not spent, so other runs may still use it. Once per turn, so a
    // throttle across the whole pool ends the turn instead of walking every
    // account; a strict pin never rotates (PiAttemptAccounts.next).
    if (
      terminal.type === "error" &&
      !terminalUsageLimit &&
      !walk.throttleRotated &&
      accounts.pickedAccount?.pool === "claude" &&
      accounts.limit429() !== undefined &&
      /\b429\b/.test(terminalMessage) &&
      takeAccountRotation(String(terminal.content), "rate limit")
    ) {
      walk.throttleRotated = true;
      return;
    }
    // The walk asked the Claude pool for another account and it had none:
    // say the whole pool is limited. The
    // account's own message stays inside the sentence, so the usage-limit
    // classifiers downstream still match it. A strict pin never asks the
    // pool, so its refusal keeps naming the account the person chose.
    if (
      terminalUsageLimit &&
      accounts.claudePoolRefusal &&
      accounts.pickedAccount?.pool === "claude"
    ) {
      console.warn(
        `[pi-runner] usage limit on Claude account "${accounts.pickedAccount.name}" ` +
          `(${parsed.modelID}) and no other account can serve it: ${accounts.claudePoolRefusal}`,
      );
      const resetAt = accounts.limit429()?.resetAt;
      const reset =
        describeUsageLimitReset(terminalMessage) ??
        (resetAt !== undefined ? formatAnthropicReset(resetAt) : undefined);
      terminal = {
        ...terminal,
        content: piErrorContent(
          `every Claude account is usage-limited for ${parsed.modelID}` +
            (reset ? `, the soonest resets ${reset}` : "") +
            `. Last account tried ("${accounts.pickedAccount.name}") said: ${terminalMessage}`,
          parsed.providerID,
        ),
      };
    }
    ledger.reachedTerminal = true;
    ledger.end({
      ok: terminal.type === "done",
      pi_session_id: ledger.piSessionId,
      saw_settled: ledger.sawSettled,
      ...ledger.usageAuditFields(),
      ...(terminal.type === "done" ? {} : { error: terminal.content }),
    });
    yield terminal;
  } catch (e: any) {
    if (abort.signal.aborted) {
      // A cancel that surfaced as a throw (abort mid-setup) is still a user
      // cancel — same quiet end as the terminal branch above.
      ledger.reachedTerminal = true;
      return;
    }
    const message: string = e?.message || String(e);
    // Honor the flag on pre-init throws (dry pool, expired seed): their
    // distinctive text never matches the classifier — previous runner-runner's
    // catch parity.
    const usageLimit =
      e?.usageLimitExhausted === true || accounts.isUsageLimit(message);
    // Sideline ONLY on provider-attributed exhaustion (the explicit flag).
    // A classifier match alone is not enough here: this catch also sees
    // non-provider throws from the run body (fs, journal, SDK init), and a
    // stray shape in one of those must not sideline a healthy account for
    // 60 min across both engines. The in-band terminal branches (provider
    // messages only) keep classifier-driven sidelines.
    if (e?.usageLimitExhausted === true) {
      accounts.sideline(message);
    }
    // Rotate rather than end the turn. Gated on the explicit flag for the
    // same reason the sideline above is: this catch also sees non-provider
    // throws from the run body (fs, journal, SDK init), and a stray
    // usage-limit shape in one of those must not burn a healthy account.
    if (e?.usageLimitExhausted === true && takeAccountRotation(message)) return;
    ledger.reachedTerminal = true;
    ledger.end({
      ok: false,
      pi_session_id: ledger.piSessionId,
      ...ledger.usageAuditFields(),
      error: message,
    });
    yield {
      type: "error",
      content: piErrorContent(message, parsed.providerID),
      provider: PROVIDER,
      model,
      ...ledger.usageField(),
      ...(usageLimit ? { usageLimitExhausted: true } : {}),
    };
  } finally {
    ledger.end({
      ok: false,
      pi_session_id: ledger.piSessionId,
      ...ledger.usageAuditFields(),
      status: abort.signal.aborted ? "cancelled" : "abandoned",
    });
    // Consumer teardown without a terminal (hot-reload chaos, shutdown):
    // nothing survives a restart, so stop the orphaned in-process turn
    // instead of letting it burn tokens with no consumer.
    if (!ledger.reachedTerminal && session) {
      try {
        void session.abort();
      } catch {}
    }
    // Mirrors the run journal below: only a turn torn down mid-run (or a
    // process that never reaches here) leaves a checkpoint to recover from.
    if (checkpointWriter) {
      await (ledger.reachedTerminal || abort.signal.aborted
        ? checkpointWriter.discard()
        : checkpointWriter.flush());
    }
    if (mcpRuntime) {
      try {
        await mcpRuntime.close();
      } catch {}
    }
    if (session) {
      try {
        session.dispose();
      } catch {}
    }
    walk.cancelled ||= abort.signal.aborted;
    releasePiRun(registeredKeys, handle);
    // Journal survives ONLY a mid-turn teardown (boot's continuation
    // re-prompt); a reached terminal or a user cancel clears it.
    if (
      journal?.osSessionId &&
      (ledger.reachedTerminal || abort.signal.aborted)
    ) {
      journalClear(runKey);
    }
  }
}
