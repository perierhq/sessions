import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { askBashDenyReason } from "./runner-shared";
import {
  bashAskPolicyReply,
  mergeGuardDenyReason,
  privateTermsDenyReason,
  publicationPolicyDenyReason,
  type MergeGuard,
  type PrivateTermsGuard,
  type PublicationPolicy,
} from "./command-policy";
import { hostBashArgv } from "./incidents/response/host-agents";
import {
  controlPlaneWorkloadCommand,
  killUserScope,
  processRunsInControlPlane,
  stopUserScope,
} from "./systemd-scopes";
import { sessionUnitDescription } from "./session-ownership";
import { runRemoteCommand, type RemoteWorkspace } from "./remote-workspace";

// ── Custom bash tool (the env-hygiene invariant) ─────────────────────────────

const BASH_OUTPUT_CAP = 40_000;
const BASH_DEFAULT_TIMEOUT_S = 120;
const BASH_MAX_TIMEOUT_S = 600;

/** A non-sensitive command shape for audit events. Command text never belongs
 * in the audit log: it commonly contains bearer tokens, customer data, and
 * shell-expanded credentials. The hash still joins a start to its finish and
 * lets an authorized investigator correlate a command with its source. */
export interface PiBashAuditEvent {
  phase: "start" | "finish";
  command_sha256: string;
  command_bytes: number;
  command_kind: string;
  sleep_calls?: number;
  sleep_seconds?: number;
  /** The sleep sits in a while/until loop: a capped poll, not a fixed wait.
   *  Separates the pattern the Waiting prompt asks for from the one it bans. */
  sleep_in_loop?: boolean;
  timeout_s: number;
  duration_ms?: number;
  exit_code?: number | null;
  timed_out?: boolean;
  cancelled?: boolean;
  outcome?: "ok" | "failed" | "timed_out" | "cancelled";
}

const AUDITED_COMMAND_KINDS = new Set([
  "bun",
  "cat",
  "cd",
  "curl",
  "echo",
  "find",
  "git",
  "gh",
  "ls",
  "printf",
  "rg",
  "sed",
  "sleep",
]);

const SLEEP_IN_LOOP = /\b(?:while|until)\b[\s\S]*?\bdo\b[\s\S]*?\bsleep\s/;

/** Keep command observability useful without recording arguments or text. */
function summarizeBashAuditCommand(
  command: string,
): Omit<
  PiBashAuditEvent,
  | "phase"
  | "timeout_s"
  | "duration_ms"
  | "exit_code"
  | "timed_out"
  | "cancelled"
  | "outcome"
> {
  const firstWord = command
    .trim()
    .match(/^(?:[A-Za-z_]\w*=[^\s]+\s+)*([A-Za-z][\w.-]*)/)?.[1];
  const commandKind =
    firstWord && AUDITED_COMMAND_KINDS.has(firstWord) ? firstWord : "shell";
  let sleepCalls = 0;
  let sleepSeconds = 0;
  for (const match of command.matchAll(
    /(?:^|[;&|(]\s*|\n\s*|\b(?:do|then|else)\s+)sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=\s|[;&|)]|$)/g,
  )) {
    sleepCalls++;
    const factor = { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] || "s"] ?? 1;
    sleepSeconds += Number(match[1]) * factor;
  }
  return {
    command_sha256: createHash("sha256").update(command).digest("hex"),
    command_bytes: new TextEncoder().encode(command).byteLength,
    command_kind: commandKind,
    ...(sleepCalls > 0
      ? {
          sleep_calls: sleepCalls,
          sleep_seconds: sleepSeconds,
          sleep_in_loop: SLEEP_IN_LOOP.test(command),
        }
      : {}),
  };
}

export function piBashHomeEnv(input: {
  runKey: string;
  scratchDir?: string;
  isolated: boolean;
  hostHome?: string;
  /** usesHostGithubLogin: keep the host's gh config, and with it its login. */
  hostGithubLogin?: boolean;
}): Record<string, string> {
  const key = input.runKey.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!input.isolated && input.hostGithubLogin)
    return input.hostHome ? { HOME: input.hostHome } : {};
  if (!input.isolated)
    return {
      ...(input.hostHome ? { HOME: input.hostHome } : {}),
      // Without GH_TOKEN in its env, gh resolves whatever identity the host's
      // ~/.config/gh/hosts.yml holds. A run must never inherit that ambient
      // login: a run-scoped config dir makes a credential-free run fail with
      // a clear "not logged in" instead of silently acting as the host
      // operator — the same fail-closed posture server-owned gh calls have.
      GH_CONFIG_DIR: `${input.scratchDir || "/tmp"}/gh-config-${key}`,
    };
  const home = `${input.scratchDir || "/tmp"}/automation-home-${key}`;
  return {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    AWS_CONFIG_FILE: `${home}/.aws/config`,
    AWS_SHARED_CREDENTIALS_FILE: `${home}/.aws/credentials`,
    GH_CONFIG_DIR: `${home}/.config/gh`,
  };
}

/** The home, TMPDIR and tool config of an incident agent whose bash runs
 *  as the incident agent user: under /tmp, one per session, because that
 *  user cannot reach the session scratch in the state directory. The user
 *  creates the directories itself (INCIDENT_HOME_PREP). */
export function incidentUserHomeEnv(key: string): Record<string, string> {
  const home = `/tmp/opensession-incident-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    AWS_CONFIG_FILE: `${home}/.aws/config`,
    AWS_SHARED_CREDENTIALS_FILE: `${home}/.aws/credentials`,
    GH_CONFIG_DIR: `${home}/.config/gh`,
    TMPDIR: `${home}/tmp`,
    OPENSESSION_SCRATCH: `${home}/tmp`,
  };
}

/** The variable that carries a local command into its shell. */
const BASH_COMMAND_VAR = "OPENSESSION_BASH_COMMAND";

/**
 * The shell for a local command. The command rides in the environment, never
 * in argv: `pkill -f <pattern>` matches every process whose command line
 * holds the pattern and Linux's pkill spares only itself, so a shell whose
 * argv was the command killed itself (exit 143) whenever the command ran
 * `pkill -f` or `pgrep -f | xargs kill` on a pattern it named. The shell
 * unsets the variable before running the command, so nothing it starts
 * inherits it. The same parser runs the text (eval), so line numbers,
 * heredocs and exit codes are those of `bash -c`.
 */
export function localBashCommand(command: string): {
  argv: string[];
  env: Record<string, string>;
} {
  return {
    argv: [
      "/bin/bash",
      "-c",
      `eval "unset -v ${BASH_COMMAND_VAR}; \$${BASH_COMMAND_VAR}"`,
    ],
    env: { [BASH_COMMAND_VAR]: command },
  };
}

/** Run as the incident agent user before its first command: create its
 *  home and TMPDIR private to it, and refuse a path someone else made
 *  (another user's directory or a symlink planted in /tmp). */
const INCIDENT_HOME_PREP =
  'umask 077 && mkdir -p -- "$HOME" "$TMPDIR" && for d in "$HOME" "$TMPDIR"; do test ! -L "$d" && test -O "$d" || exit 1; done';

type SpawnedProc = {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => void;
};

/** Test seams for the local path. */
export interface PiBashTestHooks {
  spawn?: (
    argv: string[],
    opts: { cwd: string; env: Record<string, string> },
  ) => SpawnedProc;
  /** Whether this process is the gateway (opensession-control.slice). */
  inControlPlane?: boolean;
  scope?: (
    argv: string[],
    env: Record<string, string>,
  ) => { command: string[]; env: Record<string, string>; unit?: string };
  killScope?: (unit: string) => Promise<void>;
}

/** The custom `bash` tool: same name/schema surface as pi's built-in (so the
 *  model needs no new habits) but execution is ours — Bun.spawn with the
 *  MINIMAL env only, never the server process env. `gated` additionally
 *  screens every command through the org command policy (unattended code
 *  mode), throwing the policy message on a block. Completion is EXIT-gated,
 *  not drain-gated: a backgrounded grandchild inheriting the stdout pipe
 *  (`bun run dev &`) must never hold the tool — and with it the whole agent
 *  loop, prompt(), and cancel — open forever, so after exit the drains get a
 *  short grace and are then cancelled. The command runs in its own process
 *  group (setsid) so timeout/abort can kill the whole tree, not just bash.
 *  Exported for the wedge-regression tests. */
export function makePiBashTool(input: {
  cwd: string;
  env: Record<string, string>;
  /** Run commands in this Sandbox workspace instead of on this machine. */
  remote?: RemoteWorkspace;
  gated: boolean;
  /** Ask mode: every command must pass the read-only allowlist
   *  (askBashDenyReason over ASK_BASH_PERMISSIONS, runner-shared.ts). */
  askReadOnly?: boolean;
  unattended: boolean;
  sessionId?: string;
  runKind?: string;
  publicationPolicy?: PublicationPolicy;
  /** Runs without a connected person's code authority cannot merge or approve. */
  mergeGuard?: MergeGuard;
  /** Public primary repo: publishing commands may not carry configured
   *  private organization terms (privateTermsDenyReason). */
  privateTermsGuard?: PrivateTermsGuard;
  /** Immutable Open Session run cancellation. Kept separate from Pi's tool
   * signal because AgentSession.abort() can leave an active tool signal live. */
  runSignal?: AbortSignal;
  onAudit?: (event: PiBashAuditEvent) => void;
  /** Run each local command as this low-privilege user through sudo (an
   *  incident agent in a host worktree, incidents/response/host-agents.ts).
   *  Ignored for a remote workspace. */
  runAs?: string;
  __testHooks?: PiBashTestHooks;
}): ToolDefinition<any, any, any> {
  const hooks = input.__testHooks ?? {};
  const runAs = input.remote ? undefined : input.runAs;
  // The user creates its own home once per tool; a failure is retried on
  // the next command.
  let homeReady: Promise<boolean> | null = null;
  const spawn = (
    argv: string[],
    opts: { cwd: string; env: Record<string, string> },
  ): SpawnedProc =>
    hooks.spawn
      ? hooks.spawn(argv, opts)
      : Bun.spawn(argv, {
          cwd: opts.cwd,
          env: opts.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
  const prepareHome = async (user: string): Promise<boolean> => {
    try {
      const proc = spawn(hostBashArgv(user, INCIDENT_HOME_PREP), {
        cwd: input.cwd,
        env: input.env,
      });
      const [code] = await Promise.all([
        proc.exited,
        proc.stdout ? new Response(proc.stdout).text() : "",
        proc.stderr ? new Response(proc.stderr).text() : "",
      ]);
      return code === 0;
    } catch {
      return false;
    }
  };
  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the session workspace. Output is merged stdout+stderr, " +
      `tail-truncated at ${BASH_OUTPUT_CAP} characters.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: {
          type: "number",
          description: `Timeout in seconds (default ${BASH_DEFAULT_TIMEOUT_S}, max ${BASH_MAX_TIMEOUT_S})`,
        },
      },
      required: ["command"],
    } as any,
    async execute(_toolCallId, params, signal, onUpdate) {
      const command = String((params as { command?: unknown })?.command ?? "");
      if (!command.trim()) throw new Error("Empty command");
      if (input.askReadOnly) {
        const reason = askBashDenyReason(command);
        if (reason) throw new Error(reason);
      }
      const mergeDenial = input.mergeGuard
        ? mergeGuardDenyReason(command, input.mergeGuard)
        : undefined;
      if (mergeDenial) throw new Error(mergeDenial);
      const publicationDenial = input.publicationPolicy
        ? publicationPolicyDenyReason(command, input.publicationPolicy)
        : undefined;
      if (publicationDenial) throw new Error(publicationDenial);
      const privateTermsDenial = input.privateTermsGuard
        ? privateTermsDenyReason(command, input.privateTermsGuard)
        : undefined;
      if (privateTermsDenial) throw new Error(privateTermsDenial);
      if (input.gated) {
        const reply = bashAskPolicyReply(
          { permission: "bash", metadata: { command } },
          {
            unattended: input.unattended,
            gated: true,
            sessionId: input.sessionId,
            runKind: input.runKind,
          },
        );
        if (reply !== "once") {
          throw new Error(
            "This command was blocked by the org command policy for unattended runs. " +
              "Propose the exact command in your note or summary and let a human run it.",
          );
        }
      }
      const rawTimeout = Number((params as { timeout?: unknown })?.timeout);
      const timeoutS =
        Number.isFinite(rawTimeout) && rawTimeout > 0
          ? Math.min(rawTimeout, BASH_MAX_TIMEOUT_S)
          : BASH_DEFAULT_TIMEOUT_S;

      const aborted = () =>
        Boolean(signal?.aborted || input.runSignal?.aborted);
      if (aborted()) throw new Error("Command aborted");
      const commandAudit = summarizeBashAuditCommand(command);
      const commandStartedAt = Date.now();
      input.onAudit?.({ phase: "start", ...commandAudit, timeout_s: timeoutS });
      if (input.remote) {
        let exitCode: number | null = null;
        let timedOut = false;
        try {
          const result = await runRemoteCommand(input.remote, {
            command,
            timeoutS,
            outputCap: BASH_OUTPUT_CAP,
            env: input.env,
            signals: [signal, input.runSignal].filter(
              (candidate): candidate is AbortSignal => !!candidate,
            ),
          });
          exitCode = result.exitCode;
          timedOut = result.timedOut;
          const text =
            (result.droppedChars > 0
              ? `[output truncated: first ${result.droppedChars} characters dropped]\n`
              : "") + result.output;
          if (aborted() || result.cancelled) throw new Error("Command aborted");
          if (timedOut)
            throw new Error(
              `${text}\nCommand timed out after ${timeoutS}s`.trim(),
            );
          if (exitCode !== 0)
            throw new Error(
              `${text}\nCommand exited with code ${exitCode}`.trim(),
            );
          return {
            content: [{ type: "text", text: text || "(no output)" }],
            details: {
              exitCode,
              truncatedChars: result.droppedChars || undefined,
            },
          };
        } finally {
          const cancelled = aborted();
          input.onAudit?.({
            phase: "finish",
            ...commandAudit,
            timeout_s: timeoutS,
            duration_ms: Date.now() - commandStartedAt,
            exit_code: exitCode,
            timed_out: timedOut,
            cancelled,
            outcome: cancelled
              ? "cancelled"
              : timedOut
                ? "timed_out"
                : exitCode === 0
                  ? "ok"
                  : "failed",
          });
        }
      }
      // setsid makes bash a process-group leader, so kill(-pid) reaches the
      // grandchildren a plain proc.kill() misses (bash may already be gone
      // when the timeout fires). Absent setsid (macOS), degrade to the
      // direct-child kill. As the incident agent user, sudo runs bash and
      // relays TERM and KILL to it.
      const setsidPath = Bun.which("setsid");
      // sudo drops variables it does not know, so the incident agent user's
      // shell still takes the command as an argument.
      const local = runAs ? null : localBashCommand(command);
      const shell = local ? local.argv : hostBashArgv(runAs!, command);
      const commandEnv = local ? { ...input.env, ...local.env } : input.env;
      const directCommand = setsidPath ? [setsidPath, ...shell] : shell;
      // A scope outlives the command while anything it backgrounded (a dev
      // server) still runs; its labelled description lets archive stop it.
      const description = sessionUnitDescription(
        input.sessionId,
        "agent command",
      );
      const scoped = hooks.scope
        ? hooks.scope(directCommand, commandEnv)
        : controlPlaneWorkloadCommand(
            directCommand,
            `opensession-agent-cmd-${crypto.randomUUID().slice(0, 13)}`,
            { env: commandEnv, ...(description ? { description } : {}) },
          );
      // This service's user cannot signal the incident agent user's
      // processes, so in the gateway each command needs a scope that is
      // killed whole when it ends. A detached run host is a system unit:
      // stopping it at the end of the turn kills everything it started,
      // whoever owns it.
      const killScope = hooks.killScope ?? killUserScope;
      const killRunAsScope = runAs && scoped.unit ? scoped.unit : undefined;
      if (
        runAs &&
        !scoped.unit &&
        (hooks.inControlPlane ?? processRunsInControlPlane())
      ) {
        input.onAudit?.({
          phase: "finish",
          ...commandAudit,
          timeout_s: timeoutS,
          duration_ms: 0,
          exit_code: null,
          outcome: "failed",
        });
        throw new Error(
          "Commands as the incident agent user need a systemd scope. Run Sessions as its systemd service.",
        );
      }
      if (runAs) {
        homeReady ??= prepareHome(runAs);
        if (!(await homeReady)) {
          homeReady = null;
          input.onAudit?.({
            phase: "finish",
            ...commandAudit,
            timeout_s: timeoutS,
            duration_ms: Date.now() - commandStartedAt,
            exit_code: null,
            outcome: "failed",
          });
          throw new Error(
            `The incident agent user could not prepare its home (${input.env.HOME ?? "unset"})`,
          );
        }
      }
      let timedOut = false;
      let exitCode: number | null = null;
      try {
        const proc = spawn(scoped.command, {
          cwd: input.cwd,
          env: scoped.env,
        });
        const killTree = () => {
          if (killRunAsScope) void killScope(killRunAsScope);
          else if (scoped.unit) stopUserScope(scoped.unit);
          const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
            try {
              if (!scoped.unit && setsidPath) process.kill(-proc.pid, sig);
              else proc.kill(sig);
            } catch {}
          };
          killGroup("SIGTERM");
          // Escalate for SIGTERM-ignorers; unref'd so a dead group never holds
          // the process (or this tool's return) open.
          const escalate = setTimeout(() => killGroup("SIGKILL"), 1_500);
          (escalate as unknown as { unref?: () => void }).unref?.();
        };

        let out = "";
        let droppedChars = 0;
        let lastUpdate = 0;
        const emitPartial = () => {
          const now = Date.now();
          if (now - lastUpdate < 250) return;
          lastUpdate = now;
          onUpdate?.({ content: [{ type: "text", text: out }], details: {} });
        };
        const append = (chunk: string) => {
          out += chunk;
          if (out.length > BASH_OUTPUT_CAP) {
            droppedChars += out.length - BASH_OUTPUT_CAP;
            out = out.slice(out.length - BASH_OUTPUT_CAP);
          }
          emitPartial();
        };
        const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
        const drain = async (stream: ReadableStream<Uint8Array> | null) => {
          if (!stream) return;
          const dec = new TextDecoder();
          const reader = stream.getReader();
          readers.push(reader);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) append(dec.decode(value, { stream: true }));
            }
          } catch {
            // reader.cancel() below lands here — captured output stands.
          } finally {
            try {
              reader.releaseLock();
            } catch {}
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, timeoutS * 1000);
        const onAbort = () => killTree();
        const abortSignals = [
          ...new Set(
            [signal, input.runSignal].filter(
              (candidate): candidate is AbortSignal => !!candidate,
            ),
          ),
        ];
        for (const abortSignal of abortSignals)
          abortSignal.addEventListener("abort", onAbort, { once: true });
        // addEventListener does not replay an abort that raced spawn/listener
        // installation, so close that window before awaiting process exit.
        if (aborted()) killTree();
        try {
          // Exit-gated completion: the drains alone can outlive bash forever
          // when a backgrounded child inherited the pipes, so wait for exit
          // first, then give the drains a short grace to flush and cut them.
          const drains = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
          exitCode = await proc.exited;
          await Promise.race([drains, Bun.sleep(250)]);
        } finally {
          clearTimeout(timer);
          for (const abortSignal of abortSignals)
            abortSignal.removeEventListener("abort", onAbort);
          for (const reader of readers) {
            // cancel() rejects (async) when the drain already released the
            // reader — swallow both the sync throw and the rejection.
            try {
              reader.cancel().catch(() => {});
            } catch {}
          }
        }

        const text =
          (droppedChars > 0
            ? `[output truncated: first ${droppedChars} characters dropped]\n`
            : "") + out;
        if (aborted()) throw new Error("Command aborted");
        if (timedOut)
          throw new Error(
            `${text}\nCommand timed out after ${timeoutS}s`.trim(),
          );
        if (exitCode !== 0)
          throw new Error(
            `${text}\nCommand exited with code ${exitCode}`.trim(),
          );
        return {
          content: [{ type: "text", text: text || "(no output)" }],
          details: { exitCode, truncatedChars: droppedChars || undefined },
        };
      } finally {
        // Nothing the incident agent user started outlives its command.
        if (killRunAsScope) await killScope(killRunAsScope);
        const cancelled = Boolean(signal?.aborted || input.runSignal?.aborted);
        input.onAudit?.({
          phase: "finish",
          ...commandAudit,
          timeout_s: timeoutS,
          duration_ms: Date.now() - commandStartedAt,
          exit_code: exitCode,
          timed_out: timedOut,
          cancelled,
          outcome: cancelled
            ? "cancelled"
            : timedOut
              ? "timed_out"
              : exitCode === 0
                ? "ok"
                : "failed",
        });
      }
    },
  };
}
