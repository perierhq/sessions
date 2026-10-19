import { mkdirSync, readdirSync, openSync, readSync, closeSync } from "fs";
import { join, resolve, sep } from "path";
import type { RunAgentOpts } from "./agent-runner";
import { rewriteAnthropicPromptText } from "./anthropic-prompt-compat";
import { readLocalInstructions } from "./run-policy";
import {
  assembleRunSystemPrompt,
  buildRunInstructions,
  buildSessionContext,
} from "./run-instructions";
import { stripeApprovalsNote } from "./stripe-approvals";
import { logStandingContext, logStandingJson } from "./context-log";
import type { PiRuntimeBinding } from "./pi-runtime-binding";
import type { PiMcpBridge } from "./pi-mcp-bridge";
import { gatePstackSkills, skillSearchPaths } from "./skill-paths";
import { mirrorRemoteContext, type RemoteWorkspace } from "./remote-workspace";
import { PI_STATE_DIR, sanitizeId } from "./pi-common";
import { GIT_COAUTHOR_ENV } from "./pi-github-env";
import { piCodemodeExtension } from "./pi-steering";
import type { PiRunAuthority } from "./pi-run-authority";
import { piToolScopeRecord, type PiSteerBoundary } from "./pi-tools";

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
export function findPiSessionFile(
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

  return { agentDir, sessionDir, settingsManager, loader, sessionContext };
}
