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
 * - Neither the machine nor its disk exists any more: nothing to bank.
 *
 * Where the provider can read the disk without starting the machine
 * (`inspectDisk`; for This machine (container), a throwaway read-only
 * container on the home volume), the check runs there first: a clean
 * Sandbox goes without being woken, and a Sandbox is woken only to
 * checkpoint work. That also covers a pod that is gone or cannot start
 * while its volume holds the working copy: clean, it goes; with work, it
 * is kept with what the work is and why no checkpoint could be taken.
 * Otherwise, or when the disk cannot be read, a sleeping Sandbox is woken
 * for the check. A disk that cannot be read never counts as gone. A kept
 * Sandbox is not checked again on later passes until its session shows new
 * activity.
 */

import type { ExecResult, Sandbox } from "./sandbox";
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
  /** Run the check script on the Sandbox's disk without starting its
   *  machine: its output, null when the disk no longer exists, undefined
   *  when the provider cannot read a disk that way. Throws when the disk
   *  cannot be read; the check then wakes the Sandbox instead. */
  inspectDisk?: (
    session: UnifiedSession,
    script: string,
  ) => Promise<ExecResult | null | undefined>;
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
  const settle = (verdict: SandboxWorkVerdict): SandboxWorkVerdict => {
    if (verdict.retire) {
      d.memo.delete(session.id);
      return verdict;
    }
    d.memo.set(session.id, { key, reason: verdict.reason });
    console.warn(
      `[sandbox-sweep] ${session.id}: kept ${record.sandboxId}: ${verdict.reason}`,
    );
    return verdict;
  };

  // The disk first, where the provider can read it without starting the
  // machine: a clean Sandbox then goes without being woken at all.
  let diskError: string | null = null;
  if (d.inspectDisk) {
    try {
      const result = await d.inspectDisk(session, SANDBOX_WORK_CHECK_SCRIPT);
      if (result === null) return settle({ retire: true, why: "gone" });
      if (result !== undefined) {
        const work = readWork(result);
        if (work.state !== "work") return settle(work.verdict);
        return settle(await bankFoundWork(session, work.what, d));
      }
    } catch (error) {
      diskError = message(error);
    }
  }

  let live: { sandbox: Sandbox; woke: boolean } | null;
  try {
    live = await d.wake(session);
  } catch (error) {
    return settle({
      retire: false,
      reason:
        `could not wake the Sandbox to check its working copy: ${message(error)}` +
        (diskError ? `; its disk could not be read either: ${diskError}` : ""),
    });
  }
  if (!live)
    return settle(
      diskError
        ? {
            retire: false,
            reason: `the Sandbox's machine is gone and its disk could not be checked: ${diskError}`,
          }
        : { retire: true, why: "gone" },
    );
  const verdict = await judge(session, live.sandbox, d);
  if (!verdict.retire && live.woke) await putBack(session, d);
  return settle(verdict);
}

/** Work the disk check found: wake the Sandbox only to checkpoint it. */
async function bankFoundWork(
  session: UnifiedSession,
  what: string,
  d: SandboxWorkBankDeps,
): Promise<SandboxWorkVerdict> {
  let live: { sandbox: Sandbox; woke: boolean } | null;
  try {
    live = await d.wake(session);
  } catch (error) {
    return {
      retire: false,
      reason: `${what}; could not wake the Sandbox to checkpoint the work: ${message(error)}`,
    };
  }
  if (!live)
    return {
      retire: false,
      reason: `${what}; the Sandbox's machine is gone, so no checkpoint can be taken`,
    };
  const verdict = await checkpointWork(session, live.sandbox, what, d);
  if (!verdict.retire && live.woke) await putBack(session, d);
  return verdict;
}

async function putBack(
  session: UnifiedSession,
  d: SandboxWorkBankDeps,
): Promise<void> {
  await d
    .sleep(session)
    .catch((error) =>
      console.warn(
        `[sandbox-sweep] ${session.id}: could not put ${session.sandbox?.sandboxId} back to sleep: ${message(error)}`,
      ),
    );
}

type Work =
  | { state: "settled"; verdict: SandboxWorkVerdict }
  | { state: "work"; what: string };

/** The check script's verdict on its own: clean, kept, or work a
 *  checkpoint can hold. */
function readWork(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): Work {
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.exitCode !== 0)
    return {
      state: "settled",
      verdict: {
        retire: false,
        reason: `could not check the working copy: ${message(
          `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
        )}`,
      },
    };
  if (line === "none")
    return { state: "settled", verdict: { retire: true, why: "clean" } };
  const match = /^work (\d+) (\d+) (\d+)$/.exec(line);
  if (!match)
    return {
      state: "settled",
      verdict: {
        retire: false,
        reason: `could not check the working copy: ${line.slice(0, 120)}`,
      },
    };
  const [dirty, ahead, other] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  if (other > 0)
    return {
      state: "settled",
      verdict: {
        retire: false,
        reason: `${other} unpushed commit(s) on other branches`,
      },
    };
  if (dirty === 0 && ahead === 0)
    return { state: "settled", verdict: { retire: true, why: "clean" } };
  const what = [
    dirty ? `${dirty} uncommitted path(s)` : "",
    ahead ? `${ahead} unpushed commit(s)` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return { state: "work", what };
}

async function judge(
  session: UnifiedSession,
  sandbox: Sandbox,
  d: SandboxWorkBankDeps,
): Promise<SandboxWorkVerdict> {
  const cwd = sandbox.cwd || session.worktreeDir || "";
  let work: Work;
  try {
    work = readWork(
      await sandbox.exec(["bash", "-c", SANDBOX_WORK_CHECK_SCRIPT], {
        env: { OS_CWD: cwd },
        timeoutMs: CHECK_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    return {
      retire: false,
      reason: `could not check the working copy: ${message(error)}`,
    };
  }
  if (work.state !== "work") return work.verdict;
  return checkpointWork(session, sandbox, work.what, d);
}

async function checkpointWork(
  session: UnifiedSession,
  sandbox: Sandbox,
  what: string,
  d: SandboxWorkBankDeps,
): Promise<SandboxWorkVerdict> {
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
    inspectDisk: async (session, script) => {
      const { provider, sandboxId } = session.sandbox!;
      return getSandboxProvider(provider).inspectDisk?.(sandboxId!, script, {
        timeoutMs: CHECK_TIMEOUT_MS,
      });
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
