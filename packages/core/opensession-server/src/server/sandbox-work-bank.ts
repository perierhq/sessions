/**
 * Bank a Sandbox's work before the archive sweep's retention destroys it.
 *
 * Every remote Sandbox is volume mode: the session's working copy is cloned
 * into the Sandbox's own disk and has no copy on this machine (`workspace`
 * in sandbox/provider.ts). For This machine (container) that is the pod's
 * home volume, `~/worktrees/<repo>-<branch>` (podmanWorkspaceCwd). Destroying
 * the Sandbox deletes the working copy with it, so before the sweep retires
 * one it checks the working copy:
 *
 * - Clean, with no commits missing from origin: nothing to bank; it goes.
 * - Uncommitted changes or unpushed commits on the checked-out branch: a
 *   workspace checkpoint (sandbox/checkpoint.ts) pushes them to the
 *   session's hidden ref on origin and records it on the session, which
 *   keeps its branch. The next prompt restores it into a fresh Sandbox, the
 *   same way a lost or replaced Sandbox comes back. Once that push
 *   succeeds, it goes. This is the volume-mode counterpart of the worktree
 *   reaper banking a host checkout under parked-work.
 * - Work the checkpoint cannot hold (the default branch, a detached HEAD, a
 *   repository not on GitHub, no credential, a failed push, unpushed
 *   commits on another local branch), or a Sandbox that cannot be woken or
 *   checked: it is kept, put back to sleep, and reported in housekeeping
 *   health with the reason. Work is never deleted unbanked.
 *
 * A sleeping Sandbox is woken for the check. A kept one is not woken again
 * on later passes until its session shows new activity.
 */

import type { Sandbox } from "./sandbox";
import { isRemoteSandboxProvider } from "./sandbox/config";
import type { CheckpointOutcome } from "./sandbox/checkpoint";
import type { SandboxCheckpointRecord, UnifiedSession } from "./types";

export type SandboxWorkVerdict =
  | {
      retire: true;
      why: "clean" | "banked" | "gone" | "no sandbox workspace";
      checkpoint?: SandboxCheckpointRecord;
    }
  | { retire: false; reason: string };

export type SandboxWorkBankDeps = {
  /** The session's Sandbox, awake, and whether this woke it; null when the
   *  provider no longer has it. Throws when it cannot be reached. */
  wake: (
    session: UnifiedSession,
  ) => Promise<{ sandbox: Sandbox; woke: boolean } | null>;
  /** Put back to sleep a Sandbox the check woke. */
  sleep: (session: UnifiedSession) => Promise<void>;
  checkpoint: (
    session: UnifiedSession,
    sandbox: Sandbox,
  ) => Promise<CheckpointOutcome>;
  /** Kept verdicts by session, with the state they were reached in. */
  memo: Map<string, { key: string; reason: string }>;
};

/**
 * Prints `none` when `$OS_CWD` holds no git working copy, else
 * `work <uncommitted paths> <commits on HEAD not on any remote> <commits on
 * other local branches not on any remote nor on HEAD>`. `.ports.conf`
 * describes this machine's processes and is never checkpointed, so it is
 * not work; the private seed files are gitignored.
 */
export const SANDBOX_WORK_CHECK_SCRIPT = [
  'cd "$OS_CWD" 2>/dev/null || { echo none; exit 0; }',
  "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo none; exit 0; }",
  "dirty=$(git status --porcelain --untracked-files=normal -- . ':(exclude).ports.conf' | wc -l | tr -d ' ')",
  "ahead=$(git rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)",
  "other=$(git rev-list --count --branches --not --remotes HEAD 2>/dev/null || echo 0)",
  'echo "work $dirty $ahead $other"',
].join("\n");

const CHECK_TIMEOUT_MS = 60_000;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

/** What retention may do with the session's Sandbox. Never throws. */
export async function bankSandboxWork(
  session: UnifiedSession,
  deps?: SandboxWorkBankDeps,
): Promise<SandboxWorkVerdict> {
  const record = session.sandbox;
  const d = deps ?? (await defaultDeps());
  if (!record?.sandboxId || !isRemoteSandboxProvider(record.provider))
    return { retire: true, why: "no sandbox workspace" };
  const key = `${record.sandboxId}\n${session.lastActivity}`;
  const known = d.memo.get(session.id);
  if (known?.key === key) return { retire: false, reason: known.reason };
  const keep = (reason: string): SandboxWorkVerdict => {
    d.memo.set(session.id, { key, reason });
    console.warn(
      `[sandbox-sweep] ${session.id}: kept ${record.sandboxId}: ${reason}`,
    );
    return { retire: false, reason };
  };

  let live: { sandbox: Sandbox; woke: boolean } | null;
  try {
    live = await d.wake(session);
  } catch (error) {
    return keep(
      `could not wake the Sandbox to check its working copy: ${message(error)}`,
    );
  }
  if (!live) {
    d.memo.delete(session.id);
    return { retire: true, why: "gone" };
  }
  const verdict = await judge(session, live.sandbox, d);
  if (verdict.retire) {
    d.memo.delete(session.id);
    return verdict;
  }
  if (live.woke)
    await d
      .sleep(session)
      .catch((error) =>
        console.warn(
          `[sandbox-sweep] ${session.id}: could not put ${record.sandboxId} back to sleep: ${message(error)}`,
        ),
      );
  return keep(verdict.reason);
}

async function judge(
  session: UnifiedSession,
  sandbox: Sandbox,
  d: SandboxWorkBankDeps,
): Promise<SandboxWorkVerdict> {
  const cwd = sandbox.cwd || session.worktreeDir || "";
  let line: string;
  try {
    const result = await sandbox.exec(
      ["bash", "-c", SANDBOX_WORK_CHECK_SCRIPT],
      { env: { OS_CWD: cwd }, timeoutMs: CHECK_TIMEOUT_MS },
    );
    line = result.stdout.trim().split("\n").at(-1) ?? "";
    if (result.exitCode !== 0)
      throw new Error(
        `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
      );
  } catch (error) {
    return {
      retire: false,
      reason: `could not check the working copy: ${message(error)}`,
    };
  }
  if (line === "none") return { retire: true, why: "clean" };
  const match = /^work (\d+) (\d+) (\d+)$/.exec(line);
  if (!match)
    return {
      retire: false,
      reason: `could not check the working copy: ${line.slice(0, 120)}`,
    };
  const [dirty, ahead, other] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  if (other > 0)
    return {
      retire: false,
      reason: `${other} unpushed commit(s) on other branches`,
    };
  if (dirty === 0 && ahead === 0) return { retire: true, why: "clean" };
  const what = [
    dirty ? `${dirty} uncommitted path(s)` : "",
    ahead ? `${ahead} unpushed commit(s)` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  try {
    const outcome = await d.checkpoint(session, sandbox);
    if (outcome.state === "skipped")
      return {
        retire: false,
        reason: `${what}; no checkpoint: ${outcome.reason}`,
      };
    return { retire: true, why: "banked", checkpoint: outcome.checkpoint };
  } catch (error) {
    return {
      retire: false,
      reason: `${what}; checkpoint failed: ${message(error)}`,
    };
  }
}

const keptVerdicts: SandboxWorkBankDeps["memo"] = new Map();

async function defaultDeps(): Promise<SandboxWorkBankDeps> {
  const [{ getSandboxProvider }, checkpoint] = await Promise.all([
    import("./sandbox"),
    import("./sandbox/checkpoint"),
  ]);
  return {
    wake: async (session) => {
      const { provider, sandboxId } = session.sandbox!;
      const p = getSandboxProvider(provider);
      const found = await p.get(sandboxId!);
      const status = found ? await found.status() : "gone";
      if (!found || status === "gone") return null;
      if (status === "running") return { sandbox: found, woke: false };
      if (!p.resume) throw new Error(`${provider} cannot wake a Sandbox`);
      const woken = await p.resume(sandboxId!);
      if (!woken || (await woken.status()) !== "running")
        throw new Error(`${sandboxId} did not wake`);
      return { sandbox: woken, woke: true };
    },
    sleep: async (session) => {
      const { provider, sandboxId } = session.sandbox!;
      await getSandboxProvider(provider).pause?.(sandboxId!);
    },
    checkpoint: (session, sandbox) =>
      checkpoint.checkpointSessionWorkspace(session, sandbox),
    memo: keptVerdicts,
  };
}
