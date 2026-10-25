import { mkdirSync, readdirSync, openSync, readSync, closeSync } from "fs";
import { join, resolve, sep } from "path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionSpeed } from "@tellahq/opensession-protocol/session";
import type { RunAgentOpts } from "./agent-runner";
import { audit } from "./audit";
import {
  enableAnthropicPayloadCapture,
  enableAnthropicPromptCompat,
  rewriteAnthropicPromptText,
} from "./anthropic-prompt-compat";
import {
  enableAnthropicRateLimitCapture,
  type AnthropicRateLimitSnapshot,
} from "./anthropic-rate-limit";
import { xaiSubscriptionModelEfforts } from "./xai-accounts";
import { enableXaiProxyPayload } from "./xai-payload";
import { enableOpenaiFastMode } from "./openai-auth";
import { openaiServiceTier } from "./openai-service-tier";
import { readLocalInstructions } from "./run-policy";
import { $ } from "bun";
import {
  assembleRunSystemPrompt,
  buildRunInstructions,
  buildSessionContext,
  type BaseCommit,
} from "./run-instructions";
import { stripeApprovalsNote } from "./stripe-approvals";
import {
  logStandingContext,
  logStandingJson,
  sessionStartContext,
} from "./context-log";
import {
  PI_TURN_CHECKPOINT_FILE,
  repairInterruptedPiTurn,
  takePiTurnCheckpoint,
  type PiTurnRepair,
} from "./pi-turn-checkpoint";
import { transcript } from "./actor-transcript";
import { transcriptForwarder } from "./transcript-forward";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import type { PiRuntimeBinding, PiSdk } from "./pi-runtime-binding";
import type { PiMcpBridge } from "./pi-mcp-bridge";
import { gatePstackSkills, skillSearchPaths } from "./skill-paths";
import { mirrorRemoteContext, type RemoteWorkspace } from "./remote-workspace";
import { PI_PROVIDER, PI_STATE_DIR, sanitizeId } from "./pi-common";
import { GIT_COAUTHOR_ENV } from "./pi-github-env";
import type { PiResolvedModel } from "./pi-model-routing";
import type { PiAccountWalk } from "./pi-account-walk";
import { piCodemodeExtension } from "./pi-steering";
import type { PiRunAuthority } from "./pi-run-authority";
import { piToolScopeRecord, type PiSteerBoundary } from "./pi-tools";

const PROVIDER = PI_PROVIDER;

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

const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The thinking level a turn's selected effort asks pi for. */
export function piThinkingLevel(
  selectedEffort: string | undefined,
): "off" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  // "none" means no reasoning at all. Left unset, Pi falls back to its
  // default thinking level, which costs a small one-shot tens of seconds.
  return selectedEffort === "none"
    ? ("off" as const)
    : selectedEffort && THINKING_LEVELS.has(selectedEffort)
      ? (selectedEffort as "low" | "medium" | "high" | "xhigh" | "max")
      : undefined;
}

/** What a run's resources are prepared from. */
export interface PiResourcesInput {
  opts: RunAgentOpts;
  remote: RemoteWorkspace | undefined;
  runKey: string;
  unifiedSessionId: string | undefined;
  isAsk: boolean;
  isScratch: boolean;
  authority: Pick<
    PiRunAuthority,
    | "stripeApprovals"
    | "policy"
    | "cwdRepo"
    | "publicRepo"
    | "githubUserLogin"
    | "githubEnv"
    | "agentGitEnv"
  >;
  binding: PiRuntimeBinding;
  mcpBridge: PiMcpBridge;
  localTools: string[];
  codemode: boolean;
  boundary: PiSteerBoundary;
}

/** The commit a checkout is on, or null when it is not a git checkout. */
export async function readBaseCommit(dir: string): Promise<BaseCommit | null> {
  const format = "%h%x00%cI";
  const result =
    await $`git -C ${dir} log -1 --no-show-signature --format=${format} HEAD`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) return null;
  const [sha, committedAt] = result.stdout.toString().trim().split("\0");
  return sha && committedAt ? { sha, committedAt } : null;
}

/**
 * The run's instructions, its pi agent and session dirs, the in-memory
 * settings and the loaded resource loader (skills, AGENTS.md, system prompt),
 * plus the per-session context the prompt carries.
 */
export async function preparePiResources(input: PiResourcesInput) {
  const {
    opts,
    remote,
    runKey,
    unifiedSessionId,
    isAsk,
    isScratch,
    authority,
    binding,
    mcpBridge,
    localTools,
    codemode,
    boundary,
  } = input;
  const { cwd, journal, user, author } = opts;
  const {
    stripeApprovals,
    policy,
    cwdRepo,
    publicRepo,
    githubUserLogin,
    githubEnv,
    agentGitEnv,
  } = authority;
  const { sdk } = binding;

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
    value: piToolScopeRecord({ opts, mcpBridge, localTools, policy }),
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
      ? [piCodemodeExtension(sdk, () => boundary.pending)]
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
  // The commit a new session starts from goes next to its checkout path, so
  // the agent and the person can see how current the checkout is. Only the
  // first turn carries it: later turns' HEAD is the session's own work.
  const baseCommit =
    !opts.sessionId && !remote && !isScratch && cwdRepo
      ? await readBaseCommit(cwd)
      : null;
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
    baseCommit,
  });
  await loader.reload();

  return { agentDir, sessionDir, settingsManager, loader, sessionContext };
}

/** How the turn opens its pi session: the session file it resumes (if any),
 *  the handoff note for a resume miss, and the interrupted-turn repair. */
export async function planPiResume(input: {
  sdk: PiSdk;
  opts: RunAgentOpts;
  walk: PiAccountWalk;
  model: string;
  sessionDir: string;
  unifiedSessionId: string | undefined;
  userLine: Record<string, unknown>;
}) {
  const { sdk, opts, walk, model, sessionDir, unifiedSessionId, userLine } =
    input;
  const { cwd } = opts;
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
  if (!walk.continuation && opts.sessionId && !resumePath && unifiedSessionId) {
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

  return {
    resumePath,
    resumeMissNote,
    sessionManager,
    checkpointPath,
    turnRepair,
  };
}

/** The request-payload hooks a created session gets for its provider. */
export function installPiPayloadHooks(
  session: AgentSession,
  input: {
    binding: PiRuntimeBinding;
    parsed: Pick<PiResolvedModel, "modelID">;
    speed: SessionSpeed;
    journal: RunAgentOpts["journal"];
    unifiedSessionId: string | undefined;
    runKey: string;
    onRateLimit: (snapshot: AnthropicRateLimitSnapshot) => void;
  },
): void {
  const {
    binding,
    parsed,
    speed,
    journal,
    unifiedSessionId,
    runKey,
    onRateLimit,
  } = input;
  const { model: piModel } = binding;
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
    enableAnthropicRateLimitCapture(session.agent, onRateLimit);
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
}

/** Record the session-start context row on a fresh session. */
export async function logPiSessionStart(
  session: AgentSession,
  input: {
    opts: RunAgentOpts;
    walk: PiAccountWalk;
    unifiedSessionId: string | undefined;
    /** The per-session context the opening prompt carries. */
    sessionContext?: string;
  },
): Promise<void> {
  const { opts, walk, unifiedSessionId, sessionContext } = input;
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
        sessionContext,
      ),
    });
  }
}
