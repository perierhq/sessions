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

import { mkdirSync, readdirSync, openSync, readSync, closeSync } from "fs";
import { join, resolve, sep } from "path";
import type {
  AgentSession,
  AgentSessionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { audit, summarizeText } from "./audit";
import { journalSet, buildRunJournalRecord, journalClear } from "./run-journal";
import {
  askBashDenyReason,
  describeUsageLimitReset,
  usageLimitResetAt,
} from "./runner-shared";
import { pickClaudeAccount } from "./claude-account-pick";
import {
  enableAnthropicPayloadCapture,
  enableAnthropicPromptCompat,
  rewriteAnthropicPromptText,
} from "./anthropic-prompt-compat";
import {
  enableAnthropicRateLimitCapture,
  formatAnthropicReset,
  type AnthropicRateLimitSnapshot,
} from "./anthropic-rate-limit";
import { modelProviders, readModelProviderConfig } from "./model-providers";
import { markCodexExhausted } from "./codex-accounts";
import {
  markExhausted as markClaudeExhausted,
  pickAccount as pickClaudeCliAccount,
} from "./claude-accounts";
import {
  bindXaiAccount,
  markXaiExhausted,
  pickXaiAccount,
  xaiSubscriptionModelEfforts,
} from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import { enableXaiProxyPayload } from "./xai-payload";
import {
  enableOpenaiFastMode,
  pickOpenaiAccount,
  buildSeededOpenaiAuth,
} from "./openai-auth";
import { sessionSpeed } from "@tellahq/opensession-protocol/session";
import {
  openaiServiceTier,
  supportsOpenaiUltrafast,
  ULTRAFAST_CHATGPT_PLAN,
} from "./openai-service-tier";
import {
  INTERACTIVE_KINDS,
  isUnattendedKind,
  baseJournalKind,
  runToolPolicy,
  readLocalInstructions,
} from "./run-policy";
import {
  assembleRunSystemPrompt,
  buildRunInstructions,
  buildSessionContext,
  sessionLink,
} from "./run-instructions";
import { stampIncidentDeclaration } from "./incident-declarations";
import {
  guardStripeApprovalCall,
  stripeApprovalsEnforced,
  stripeApprovalsNote,
} from "./stripe-approvals";
import {
  logInjectedContext,
  logStandingContext,
  logStandingJson,
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
import {
  EMPTY_REPLY_RETRY_PROMPT,
  githubCredentialUser,
} from "./auto-continue";
import type { PrivateTermsGuard } from "./command-policy";
import { privateTerms } from "./config";
import { treatRepoAsPublic } from "./repo-visibility";
import {
  recordEngineSessionOwner,
  transcriptLineCompactionSummary,
  transcriptLineUser,
  storeAppendUserLineEarly,
} from "./transcript-persistence";
import { transcript } from "./actor-transcript";
import { transcriptForwarder } from "./transcript-forward";
import { humanPrompter, providerAccountUser } from "./session-actors";
import { githubRunOwnerLogin } from "./github-auth";
import { ensureAgentAwsCredsFile } from "./aws-creds";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { piEngineEnabled, piConfigPath } from "./pi-config";
import {
  createPiRuntimeBinding,
  prewarmPiSdk as prewarmPiSdkBinding,
  rememberNativeClaudeAccount,
} from "./pi-runtime-binding";
import { createPiMcpBridge, type PiMcpBridge } from "./pi-mcp-bridge";
import {
  createMcpRuntime,
  splitMcpMigrationBoundary,
  type McpRuntime,
} from "./mcp-runtime";
import {
  expandSkillCommand,
  gatePstackSkills,
  skillSearchPaths,
} from "./skill-paths";
import {
  makeRemoteGrepExecute,
  makeRemoteToolOps,
  remoteAttachmentWriter,
  mirrorRemoteContext,
  remoteCommandEnv,
  remoteWorkspaceForRun,
} from "./remote-workspace";
import type { TranscriptEntry } from "./types";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent, ImageInput } from "./run-events";
import { PI_PROVIDER, PI_STATE_DIR, nowIso, sanitizeId } from "./pi-common";
import {
  assistantRenderableBlockCount,
  contentToTextAndImages,
  persistEntries,
  piAppend,
  piAssistantTranscriptEntries,
  piImages,
} from "./pi-transcript";
import {
  GIT_COAUTHOR_ENV,
  agentGitIdentityEnv,
  runGithubEnv,
  runGithubMergeGuard,
  usesHostGithubLogin,
} from "./pi-github-env";
import {
  buildPiThirdPartyProviderPlan,
  piModelResolutionError,
  resolvePiRoutedModel,
} from "./pi-model-routing";
import {
  makeGuardedGrepExecute,
  makeGuardedToolOps,
  shippedSkillRoots,
} from "./pi-guarded-tools";
import { makePiBashTool, piBashHomeEnv } from "./pi-bash-tool";
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
  piCodemodeExtension,
  piResponseHasOutput,
  piSteeringBoundaryTools,
  piToolNames,
} from "./pi-steering";
import { piGateReason } from "./pi-gate";
import { isPiUsageLimitShape, piErrorContent } from "./pi-usage-limit";
import {
  claudePoolRef,
  codexPoolRef,
  evidencePoolRef,
  piStreamEventRequiresAccountContinuation,
  runPiAccountWalk,
  xaiPoolRef,
  type PiAccountWalk,
  type PoolAccountRef,
} from "./pi-account-walk";
import { PiTurnLedger } from "./pi-turn-ledger";

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

// ── Small helpers ────────────────────────────────────────────────────────────

/** First jsonl line of a pi session file (the v3 header), bounded read. */
function readSessionHeader(
  path: string,
): { type?: string; id?: string } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString("utf-8", 0, n).split("\n")[0];
    if (!firstLine) return null;
    return JSON.parse(firstLine);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Find the session jsonl whose header id matches — resume-by-piSessionId. */
function findPiSessionFile(
  sessionDir: string,
  piSessionId: string,
): string | null {
  try {
    const names = readdirSync(sessionDir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const name of names) {
      const path = join(sessionDir, name);
      const header = readSessionHeader(path);
      if (header?.type === "session" && header.id === piSessionId) return path;
    }
  } catch {}
  return null;
}

// ── The turn ─────────────────────────────────────────────────────────────────

const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

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

  // The latest Anthropic response's unified rate-limit headers
  // (anthropic-rate-limit.ts). Kept per attempt: each attempt binds
  // its own account.
  let nativeRateLimit: AnthropicRateLimitSnapshot | undefined;
  /** The rate-limit headers of the 429 that just failed, if that is what the
   *  latest response was. */
  const nativeLimit429 = () =>
    nativeRateLimit?.httpStatus === 429 ? nativeRateLimit : undefined;
  const usageLimitShape = (message: string) =>
    isPiUsageLimitShape(
      message,
      parsed.providerID,
      nativeLimit429()?.unifiedStatus,
    );

  const { prompt, cwd, mode, mcpServers, confirmTools, journal, user, author } =
    opts;
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
  // Pool-backed providers only (pi/openai: Codex pool, pi/xai-oauth: SuperGrok
  // pool, pi/anthropic on the native transport: Claude pool): the picked
  // account — visible to the catch/terminal paths so the account walk can
  // rotate off it. Set as soon as the pick succeeds, BEFORE the seed and
  // refresh-window checks, because those two failures are exactly the ones
  // worth trying another account for.
  let pickedAccount: PoolAccountRef | undefined;
  // The same account, but only once it is genuinely serving this turn. The
  // SIDELINE keys on this rather than on the pick: markCodexExhausted benches
  // an account for hours, cross-engine, shared with previous runner, and a local
  // auth.json we could not read (or a token inside pi's refresh window) is a
  // fault of this box, not a verdict on the account's usage. Rotating off it
  // is right; benching it globally is not.
  let sidelineableAccount: PoolAccountRef | undefined;
  const sidelineAccount = (account: PoolAccountRef, message: string) => {
    if (account.pool === "openai")
      markCodexExhausted(account.id, parsed.modelID);
    else if (account.pool === "claude")
      // Bench it until the reset the account named, when it named one:
      // Anthropic's unified reset header on the 429, else a reset in the
      // limit message.
      markClaudeExhausted(
        account.id,
        parsed.modelID,
        nativeLimit429()?.resetAt ?? usageLimitResetAt(message),
      );
    else markXaiExhausted(account.id, parsed.modelID);
  };

  /** Another account in the same pool that could serve this turn, or
   *  undefined when the pool is dry. Both ChatGPT OAuth and standard OpenAI
   *  API-key accounts are executable. A STRICT pin never rotates: excluding
   *  the pinned id would make the picker skip its pin branch and widen into
   *  the pool, which is the one thing a hard pin exists to prevent. */
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
  // Why the Claude pool had no other account, when the walk asked and it had
  // none. Lets the terminal say the pool is dry instead of echoing one
  // account's limit as if nothing else had been tried.
  let claudePoolRefusal: string | undefined;
  const nextPoolAccount = (): PoolAccountRef | undefined => {
    if (!pickedAccount) return undefined;
    if (opts.accountStrict && opts.accountId) return undefined;
    const excluded = new Set([...walk.excluded, pickedAccount.id]);
    if (pickedAccount.pool === "claude") {
      // A peek: this only asks whether another account can serve. Recording
      // the pick here would spend the pool's round-robin turn, and the next
      // attempt's own pick would then land on a different account than the
      // one announced. takeAccountRotation hands the probed account to the
      // next attempt instead.
      const next = pickClaudeAccount(parsed.modelID, {
        user: accountUser,
        accountId: opts.accountId,
        accountStrict: opts.accountStrict,
        usageCredits: opts.usageCredits,
        excludeIds: [...excluded],
        peek: true,
      });
      if ("error" in next) {
        claudePoolRefusal = next.error;
        return undefined;
      }
      return claudePoolRef(next);
    }
    if (pickedAccount.pool === "openai") {
      const next = pickOpenaiAccount(
        parsed.modelID,
        readModelProviderConfig()?.openaiAccounts,
        affinity,
        undefined,
        accountUser,
        opts.accountId,
        opts.accountStrict,
        excluded,
        speed === "ultrafast" && supportsOpenaiUltrafast(parsed.modelID)
          ? ULTRAFAST_CHATGPT_PLAN
          : undefined,
      );
      return "error" in next ? undefined : codexPoolRef(next);
    }
    const next = pickXaiAccount({
      model: parsed.modelID,
      sessionKey: affinity,
      user: accountUser,
      pinnedId: opts.accountId,
      strict: opts.accountStrict,
      restrictIds: readModelProviderConfig()?.xaiAccounts,
      exclude: excluded,
    });
    return "error" in next ? undefined : xaiPoolRef(next);
  };

  /** Take the rotation, or return false and let the caller surface the
   *  failure. Records the burn, audits the switch and closes this attempt's
   *  audit; runPi resumes or replays the attempt on the next account. It
   *  never sidelines: the caller decides that. */
  const takeAccountRotation = (
    errorText: string,
    why = "usage limit",
  ): boolean => {
    claudePoolRefusal = undefined;
    if (
      !pickedAccount ||
      (ledger.sawStreamedOutput && !session?.sessionManager)
    )
      return false;
    const next = nextPoolAccount();
    if (!next) return false;
    console.warn(
      `[pi-runner] ${why} on ${pickedAccount.label} account "${pickedAccount.name}" ` +
        `(${parsed.modelID}): retrying this turn on "${next.name}"`,
    );
    audit({
      ...auditBase,
      direction: "out",
      kind: "account_switch",
      account: pickedAccount.masked,
      account_switch_to: next.masked,
    });
    if (ledger.sawStreamedOutput && session)
      walk.continuation = session.sessionManager;
    // The native Claude binding prefers the session's remembered account:
    // make that the one just announced, so the next attempt binds to it and
    // the session stays there afterwards.
    if (next.pool === "claude")
      rememberNativeClaudeAccount(accountUser, claudeSessionKey, next.id);
    walk.excluded.add(pickedAccount.id);
    walk.rotate = true;
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

    // Stripe two-party approvals hold refunds and cancellations, so every
    // run keeps those tools; guardStripeApprovalCall narrows the raw writer.
    const stripeApprovals =
      stripeApprovalsEnforced() &&
      (!Array.isArray(mcpServers) || mcpServers.includes("stripe"));
    const policy = runToolPolicy({
      deniedTools: opts.deniedTools,
      confirmTools,
      journalKind: journal?.kind,
      stripeApprovals,
    });
    // Command-policy gate: kind-based like previous runner (NOT policy.unattended) —
    // the trusted-human loops carry deniedTools but shouldn't trip the gate.
    const bashGated =
      isUnattendedKind(baseJournalKind(journal?.kind)) && !isAsk;
    // The repo owning this run's cwd, or undefined for a repo-less one (a
    // scratch dir, a repo-less ask session). Dynamic import to avoid a static
    // module-init cycle through "./worktree".
    const cwdRepo = await (async () => {
      try {
        const { getRepo, repoForPathOrNull } = await import("./worktree");
        // A Sandbox checkout's path means nothing on this machine: the
        // launcher names its repository instead.
        if (remote)
          return opts.remoteWorkspace?.repo
            ? getRepo(opts.remoteWorkspace.repo)
            : undefined;
        return repoForPathOrNull(cwd);
      } catch {
        return undefined;
      }
    })();
    // A run that can publish must know when the whole internet reads what it
    // publishes. Fails closed: unconfirmed visibility counts as public.
    const publicRepo =
      !isAsk && !isScratch && (await treatRepoAsPublic(cwdRepo));
    const configuredPrivateTerms = privateTerms();
    const privateTermsGuard: PrivateTermsGuard | undefined =
      publicRepo && configuredPrivateTerms.length > 0
        ? { terms: configuredPrivateTerms }
        : undefined;
    // The person this turn acts for, if any: the sender, unless it is the
    // synthetic auto-continue driver, in which case the author fallback
    // names the session owner (#322). A machine sender (a review handoff, a
    // worker report, an automation) is nobody. In code mode an owner turn
    // puts their connected token in the shell (runGithubEnv) and describes
    // PR authorship as theirs; every other run holds an App token.
    const githubUser = githubCredentialUser(user, author?.name);
    const ownerTurn =
      !policy.unattended &&
      INTERACTIVE_KINDS.has(baseJournalKind(journal?.kind)) &&
      humanPrompter(githubUser) !== null;
    // On a remote host this reads the launcher's projected marker, not the
    // person store, so a sandboxed owner turn drops the guard exactly when
    // a host run would.
    const githubUserLogin = ownerTurn ? githubRunOwnerLogin(githubUser) : null;
    // GitHub permissions and repository rulesets bound the chosen credential.
    // Ask, unattended, and publication-policy command gates still apply.
    const githubKindRun = baseJournalKind(journal?.kind).startsWith("github-");
    const hostGithubLogin = await usesHostGithubLogin({
      remote: Boolean(remote),
      unattended: Boolean(policy.unattended),
      isolatedHome: Boolean(opts.publicationPolicy),
    });
    const githubEnv = await runGithubEnv({
      isCode: mode === "code",
      ownerTurn,
      user: githubUser,
      githubKindRun,
      launcherEnv: opts.githubEnv,
      // Credentials are looked up by checkout; a Sandbox run's repository is
      // found through its registered checkout on this machine.
      cwd: remote ? cwdRepo?.repo || "" : cwd,
      readRepos: opts.readRepos,
      attachedRepos: opts.attachedRepos,
      hostLogin: hostGithubLogin,
    });
    const agentGitEnv = await agentGitIdentityEnv(author);
    const mergeGuard = runGithubMergeGuard({
      isCode: mode === "code",
      ownerTurn,
      ownerLogin: githubUserLogin,
      baseBranch: cwdRepo?.defaultBranch || "main",
    });
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
      onAccountEvidence: (evidence) => {
        pickedAccount = evidencePoolRef(evidence, "picked");
        sidelineableAccount = evidencePoolRef(evidence, "sidelineable");
      },
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

    // Optional pool credentials for tools the run itself spawns (currently
    // deepsec's Claude Agent SDK and Codex CLI workers). These are explicit
    // additions to the minimal environment, never inherited server secrets.
    const cliEnv: Record<string, string> = {};
    // Pool credentials never go into a Sandbox command.
    if (opts.claudeCliEnv && !remote) {
      const cliAccount = pickClaudeCliAccount(
        undefined,
        accountUser,
        undefined,
        opts.usageCredits,
      );
      if (cliAccount) {
        const cliCfgDir = `${PI_STATE_DIR}/cli/claude/${cliAccount.id}`;
        mkdirSync(cliCfgDir, { recursive: true, mode: 0o700 });
        cliEnv.CLAUDE_CODE_OAUTH_TOKEN = cliAccount.token;
        cliEnv.CLAUDE_CONFIG_DIR = cliCfgDir;
        audit({
          msg: "claude_cli_env_account",
          run_kind: journal?.kind,
          session_id: journal?.osSessionId,
          account: cliAccount.name,
          account_id: cliAccount.id.slice(0, 8),
          engine: "pi",
        });
      } else {
        console.warn(
          "[pi-runner] claudeCliEnv requested but no usable Claude account in the pool; run proceeds without it",
        );
      }
    }
    if (opts.codexCliEnv && !remote) {
      const cfg = readModelProviderConfig();
      const picked = pickOpenaiAccount(
        "",
        cfg?.openaiAccounts,
        journal?.osSessionId || runKey,
        undefined,
        accountUser,
      );
      if ("error" in picked) {
        console.warn(
          `[pi-runner] codexCliEnv requested but no usable Codex account (${picked.error}); run proceeds without it`,
        );
      } else {
        Object.assign(
          cliEnv,
          picked.kind === "home"
            ? { CODEX_HOME: picked.value }
            : { OPENAI_API_KEY: picked.value },
        );
        audit({
          msg: "codex_cli_env_account",
          run_kind: journal?.kind,
          session_id: journal?.osSessionId,
          account: picked.name,
          account_id: picked.id.slice(0, 8),
          engine: "pi",
        });
      }
    }

    // Minimal bash env, the security invariant this engine hangs on. The
    // server env is NEVER inherited; every entry is explicit.
    // The AWS session file lives on this machine; a Sandbox never gets one.
    const awsEnv = opts.aws && !remote ? await ensureAgentAwsCredsFile() : {};
    const homeEnv = piBashHomeEnv({
      runKey,
      scratchDir: opts.scratchDir,
      isolated: Boolean(opts.publicationPolicy),
      hostHome: process.env.HOME,
      hostGithubLogin,
    });
    if (!remote && opts.publicationPolicy && homeEnv.HOME)
      mkdirSync(homeEnv.HOME, { recursive: true, mode: 0o700 });
    if (!remote && homeEnv.GH_CONFIG_DIR)
      mkdirSync(homeEnv.GH_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const bashEnv: Record<string, string> = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...homeEnv,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      // Session-scoped scratch (session-scratch.ts): temp files follow the
      // session's lifecycle instead of accumulating in shared /tmp.
      ...(opts.scratchDir
        ? { TMPDIR: opts.scratchDir, OPENSESSION_SCRATCH: opts.scratchDir }
        : {}),
      ...agentGitEnv,
      ...githubEnv,
      ...awsEnv,
      ...cliEnv,
    };

    // One engine-neutral MCP runtime owns all connections for this logical
    // turn. Pi only adapts its exact catalog into tool_search/tool_call. The
    // detached runner-host proxy shape remains solely at this named migration
    // boundary until Agent operation routing replaces it.
    const mcpMounts = splitMcpMigrationBoundary(opts.inProcessMcp);
    mcpRuntime = await createMcpRuntime({
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
    });
    mcpBridge = await createPiMcpBridge(mcpRuntime);
    const localTools = piLocalToolNames({
      isAsk,
      disableLocalWorkspaceTools: opts.disableLocalWorkspaceTools,
    });
    // Every enabled name is derived from a custom definition below. Pi falls
    // back to its in-process built-ins for a name without an override, so a
    // separately maintained enabled-name list would be a containment escape.
    const guardedOps = remote
      ? makeRemoteToolOps(remote, shippedSkillRoots())
      : makeGuardedToolOps(cwd);
    const commandEnv = remote
      ? remoteCommandEnv(
          bashEnv,
          remote,
          runKey,
          Boolean(opts.publicationPolicy),
        )
      : bashEnv;
    let steeringBoundaryPending = false;
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
    const customTools = piSteeringBoundaryTools(
      baseCustomTools,
      () => steeringBoundaryPending,
    );
    // Codemode only orchestrates the tools above, so a run without any has
    // nothing for a script to call.
    const codemode = customTools.length > 0;

    // What the loop reads from the checkout itself (AGENTS.md, local
    // instructions, the checkout's skills). A Sandbox checkout is mirrored
    // here first, and every path the model sees maps back to the Sandbox.
    const context = remote
      ? await mirrorRemoteContext(
          remote,
          `${PI_STATE_DIR}/remote-context/${sanitizeId(unifiedSessionId || runKey)}`,
        )
      : { dir: cwd, toRemote: (path: string) => path };
    const instructions = buildRunInstructions({
      isAsk,
      isScratch,
      isRepoLess: !cwdRepo,
      reposNote: opts.reposNote,
      prReviewer: opts.prReviewer,
      // Only tell the run about a read token it actually holds; a refused
      // mint already warned in the server log.
      readRepos: githubEnv.GH_READ_TOKEN ? opts.readRepos : undefined,
      // Same host-awareness as the previous runner runner: code.storage repos get
      // push-the-branch instructions instead of `gh pr create`.
      repoHost: isScratch ? undefined : cwdRepo?.host,
      publicRepo,
      localInstructions: readLocalInstructions(context.dir),
      stripeApprovalsNote: stripeApprovals
        ? stripeApprovalsNote(policy.unattended)
        : undefined,
      inProcessMcp: opts.inProcessMcp,
      sandboxed: !!remote || process.env.OPENSESSION_SANDBOX === "1",
      hasSession: !!journal?.osSessionId,
    });

    // The resolution of the `tools` scope runOnModel already logged: what
    // this engine actually put in front of the model. Pi assembles its tool
    // list in-process rather than declaring it in an engine config, so this
    // record is the only account of it (previous runner's equivalent can be read
    // back from its config file). Recorded once per session, then again only
    // when the content hash moves.
    await logStandingJson({
      sessionId: unifiedSessionId,
      turnId: opts.promptEntryId || opts.startToken,
      source: "mcp-servers",
      value: {
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
      },
    });
    await logStandingContext({
      sessionId: unifiedSessionId,
      turnId: opts.promptEntryId || opts.startToken,
      source: "instructions",
      content: instructions,
    });

    const agentDir = `${PI_STATE_DIR}/agent`;
    const sessionDir = `${PI_STATE_DIR}/sessions/${sanitizeId(unifiedSessionId || runKey)}`;
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    // Pi's `auto` transport tries the experimental ChatGPT WebSocket first.
    // A mid-response 1006 cannot safely fall back in-place after output has
    // streamed, so Pi has to replay the whole LLM step through its visible
    // auto-retry path. Start subscription-backed Codex turns on SSE instead:
    // it keeps the same session prompt-cache key without the fragile persistent
    // socket. Raw OpenAI API keys use Pi's ordinary provider and retain its
    // default transport selection.
    //
    // Pi's prompt-cache warming (on by default since 0.86) replays the last
    // request with a one-token cap during long tool runs. Keep it off:
    // subscription accounts would spend quota on every replay.
    const settingsManager = sdk.SettingsManager.inMemory({
      cacheWarming: "off",
      ...(binding.usesOpenaiOAuth ? { transport: "sse" as const } : {}),
    });
    const workspaceRoot = resolve(context.dir);
    const loader = new sdk.DefaultResourceLoader({
      cwd: context.dir,
      agentDir,
      settingsManager,
      // No discovered or built-in extensions. The one inline factory is pi's
      // codemode tool (piCodemodeExtension).
      noExtensions: true,
      extensionFactories: codemode
        ? [piCodemodeExtension(sdk, () => steeringBoundaryPending)]
        : [],
      // Pi's own skill resolution stays off, like extensions and themes. A
      // turn loads the allowlist in skill-paths.ts: what this server ships,
      // plus the session checkout's own skills, never whatever the host
      // account has enabled. The paths are what make it non-empty. noSkills
      // with no additionalSkillPaths loaded nothing at all, which left every
      // shipped skill dead in the product.
      noSkills: true,
      additionalSkillPaths: skillSearchPaths(context.dir),
      // The pstack family stays loaded but invisible to the model until the
      // session turns pstack mode on (composer toggle or /pstack). A mirrored
      // Sandbox skill is presented at its Sandbox path; its local copy only
      // serves a "/name" expansion (mirrorPath).
      skillsOverride: (base) => ({
        ...base,
        skills: gatePstackSkills(
          remote
            ? base.skills.map((skill) => {
                const filePath = context.toRemote(skill.filePath);
                return filePath === skill.filePath
                  ? skill
                  : {
                      ...skill,
                      filePath,
                      baseDir: context.toRemote(skill.baseDir),
                      mirrorPath: skill.filePath,
                    };
              })
            : base.skills,
          opts.pstackMode,
        ),
      }),
      noPromptTemplates: true,
      noThemes: true,
      // Pi's context-file discovery walks every ancestor of cwd up to /
      // (plus the agentDir global) — an AGENTS.md dropped in /home/ubuntu
      // would silently join every pi system prompt on the box. Bound it to
      // the workspace: keep only cwd-level files (previous runner parity).
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: agentsFiles
          .filter((f) => {
            const p = resolve(f.path);
            return p === workspaceRoot || p.startsWith(workspaceRoot + sep);
          })
          .map((f) => ({ ...f, path: context.toRemote(f.path) })),
      }),
      systemPromptOverride: (base) => {
        const systemPrompt = assembleRunSystemPrompt({
          base,
          cwd,
          instructions,
        });
        // Native Anthropic subscription turns: the same rewrite the request
        // payload gets below, so the session's own prompt matches what is sent.
        return binding.usesNativeAnthropic
          ? rewriteAnthropicPromptText(systemPrompt)
          : systemPrompt;
      },
    });
    // What the system prompt leaves out so it stays byte-identical across
    // sessions (prompt-cache sharing): session link, requester, checkout path.
    const sessionContext = buildSessionContext({
      osSessionId: journal?.osSessionId,
      cwd,
      isAsk,
      isScratch,
      repoHost: isScratch ? undefined : cwdRepo?.host,
      user,
      author,
      githubUserLogin,
      coAuthor: agentGitEnv[GIT_COAUTHOR_ENV],
    });
    await loader.reload();

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

    const selectedEffort = opts.effort;
    // "none" means no reasoning at all. Left unset, Pi falls back to its
    // default thinking level, which costs a small one-shot tens of seconds.
    const thinkingLevel =
      selectedEffort === "none"
        ? ("off" as const)
        : selectedEffort && THINKING_LEVELS.has(selectedEffort)
          ? (selectedEffort as "low" | "medium" | "high" | "xhigh" | "max")
          : undefined;

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
        nativeRateLimit = snapshot;
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
      steeringBoundaryPending = true;
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
        steeringBoundaryPending = remaining.length > 0;
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
                  steeringBoundaryPending = pendingSteers.length > 0;
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
            if (usageLimitShape(errText)) {
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
      if (usageLimit && sidelineableAccount) {
        sidelineAccount(sidelineableAccount, message);
      }
    };
    let terminal: StreamEvent;
    let terminalUsageLimit = false;
    let terminalMessage = "";
    if (!failed.ok) {
      const message = String((failed.error as Error)?.message || failed.error);
      terminalMessage = message;
      const usageLimit = usageLimitShape(message);
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
      const usageLimit = usageLimitShape(message);
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
    // account; a strict pin never rotates (nextPoolAccount).
    if (
      terminal.type === "error" &&
      !terminalUsageLimit &&
      !walk.throttleRotated &&
      pickedAccount?.pool === "claude" &&
      nativeLimit429() !== undefined &&
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
      claudePoolRefusal &&
      pickedAccount?.pool === "claude"
    ) {
      console.warn(
        `[pi-runner] usage limit on Claude account "${pickedAccount.name}" ` +
          `(${parsed.modelID}) and no other account can serve it: ${claudePoolRefusal}`,
      );
      const resetAt = nativeLimit429()?.resetAt;
      const reset =
        describeUsageLimitReset(terminalMessage) ??
        (resetAt !== undefined ? formatAnthropicReset(resetAt) : undefined);
      terminal = {
        ...terminal,
        content: piErrorContent(
          `every Claude account is usage-limited for ${parsed.modelID}` +
            (reset ? `, the soonest resets ${reset}` : "") +
            `. Last account tried ("${pickedAccount.name}") said: ${terminalMessage}`,
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
      e?.usageLimitExhausted === true || usageLimitShape(message);
    // Sideline ONLY on provider-attributed exhaustion (the explicit flag).
    // A classifier match alone is not enough here: this catch also sees
    // non-provider throws from the run body (fs, journal, SDK init), and a
    // stray shape in one of those must not sideline a healthy account for
    // 60 min across both engines. The in-band terminal branches (provider
    // messages only) keep classifier-driven sidelines.
    if (e?.usageLimitExhausted === true && sidelineableAccount) {
      sidelineAccount(sidelineableAccount, message);
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
