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

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { audit, summarizeText } from "./audit";
import { journalSet, buildRunJournalRecord, journalClear } from "./run-journal";
import { askBashDenyReason, describeUsageLimitReset } from "./runner-shared";
import { pickClaudeAccount } from "./claude-account-pick";
import { formatAnthropicReset } from "./anthropic-rate-limit";
import { modelProviders, readModelProviderConfig } from "./model-providers";
import { bindXaiAccount } from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import { pickOpenaiAccount, buildSeededOpenaiAuth } from "./openai-auth";
import { sessionSpeed } from "@tellahq/opensession-protocol/session";
import { logInjectedContext } from "./context-log";
import {
  createPiTurnCheckpointWriter,
  type PiTurnCheckpointWriter,
} from "./pi-turn-checkpoint";
import {
  recordEngineSessionOwner,
  transcriptLineUser,
  storeAppendUserLineEarly,
} from "./transcript-persistence";
import { providerAccountUser } from "./session-actors";
import { piEngineEnabled, piConfigPath } from "./pi-config";
import {
  createPiRuntimeBinding,
  prewarmPiSdk as prewarmPiSdkBinding,
} from "./pi-runtime-binding";
import { createPiMcpBridge, type PiMcpBridge } from "./pi-mcp-bridge";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import { expandSkillCommand } from "./skill-paths";
import { remoteWorkspaceForRun } from "./remote-workspace";
import type { TranscriptEntry } from "./types";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent } from "./run-events";
import { PI_PROVIDER } from "./pi-common";
import { persistEntries, piAppend } from "./pi-transcript";
import {
  buildPiThirdPartyProviderPlan,
  piModelResolutionError,
  resolvePiRoutedModel,
} from "./pi-model-routing";
import {
  aliasPiRun,
  claimPiRun,
  releasePiRun,
  type PiRunHandle,
} from "./pi-run-registry";
import { PI_CODEMODE_TOOL, piToolNames } from "./pi-steering";
import { piGateReason } from "./pi-gate";
import { piErrorContent } from "./pi-usage-limit";
import {
  PiAttemptAccounts,
  evidencePoolRef,
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
  installPiPayloadHooks,
  logPiSessionStart,
  piThinkingLevel,
  planPiResume,
  preparePiResources,
} from "./pi-session-setup";
import { PiSteerController } from "./pi-steer-controller";
import {
  PiEventPump,
  buildPiPromptForEngine,
  createPiEventMapper,
  piSystemEntry,
  piTurnRepairEntries,
} from "./pi-events";
import { drivePiPrompt } from "./pi-prompt-loop";

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

    const { resumeMissNote, sessionManager, checkpointPath, turnRepair } =
      await planPiResume({
        sdk,
        opts,
        walk,
        model,
        sessionDir,
        unifiedSessionId,
        userLine,
      });

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
    installPiPayloadHooks(session, {
      binding,
      parsed,
      speed,
      journal,
      unifiedSessionId,
      runKey,
      onRateLimit: (snapshot) => {
        accounts.rateLimit = snapshot;
      },
    });
    await logPiSessionStart(session, { opts, walk, unifiedSessionId });
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
    const steering = new PiSteerController({
      session: liveSession,
      skills: () => loader.getSkills().skills,
      scratchDir: opts.scratchDir,
      remote,
      signal: abort.signal,
      boundary,
      auditBase,
    });
    handle.steer = (text, images, steerId) =>
      steering.steer(text, images, steerId);
    handle.retractSteer = (steerId) => steering.retractSteer(steerId);

    // Cancellation: our registry AbortController drives session.abort().
    steering.listenForAbort();

    // ── Event pump: callback subscription → this generator's queue ──────────
    const pump = new PiEventPump(ledger);
    const push = (ev: StreamEvent) => pump.push(ev);

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
      const {
        entries: recovered,
        notice,
        calls,
      } = piTurnRepairEntries(turnRepair, parsed.modelID);
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
      persistRunEntries([piSystemEntry(notice)]);
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
    const promptForEngine = buildPiPromptForEngine({
      sessionContext,
      resumeMissNote,
      turnRepair,
      continuation: Boolean(walk.continuation),
      promptWithSkill,
    });
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

    const events = createPiEventMapper({
      push,
      ledger,
      persist: persistRunEntries,
      appendLines: appendRunLines,
      steering,
      checkpointWriter: () => checkpointWriter,
      prompt,
      promptForEngine,
      modelID: parsed.modelID,
      isUsageLimit: (message) => accounts.isUsageLimit(message),
      abortRetry: () => liveSession.abortRetry(),
      auditBase,
    });
    const unsubscribe = session.subscribe(events.handle);

    const { result: failed, emptyFinishRetries } = yield* drivePiPrompt({
      session,
      pump,
      handle,
      signal: abort.signal,
      steering,
      outcome: events.outcome,
      promptForEngine,
      walk,
      images: opts.images,
      unsubscribe,
      auditBase,
    });

    // ── Terminal (at most one; user cancels end with none) ──────────────────
    if (
      failed.ok &&
      events.outcome.lastStopReason === "stop" &&
      events.outcome.lastAssistantRenderableBlocks === 0
    ) {
      // The retry (if it ran) also came back empty — never end silently on a
      // provider glitch; leave a visible chip explaining the missing reply.
      persistRunEntries([
        piSystemEntry(
          "The model ended this turn with an empty response (no text or tool calls)" +
            (emptyFinishRetries > 0
              ? " and an automatic retry produced nothing too. Send another message to continue."
              : "."),
        ),
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
    } else if (
      events.outcome.lastStopReason === "error" ||
      events.outcome.lastStopReason === "aborted"
    ) {
      const message =
        events.outcome.lastErrorMessage ||
        `run ended with stopReason ${events.outcome.lastStopReason}`;
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
