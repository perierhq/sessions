import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bankSandboxWork,
  SANDBOX_WORK_CHECK_SCRIPT,
  type SandboxWorkBankDeps,
} from "./sandbox-work-bank";
import type { Sandbox } from "./sandbox";
import type { SandboxCheckpointRecord, UnifiedSession } from "./types";

function session(over: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: "bks-retire",
    source: "opensession",
    archived: true,
    isRunning: false,
    lastActivity: "2026-02-01T00:00:00.000Z",
    branch: "acme-fix",
    repo: "acme",
    sandbox: { provider: "podman", sandboxId: "opensession-sbx-bks-retire" },
    ...over,
  } as UnifiedSession;
}

const CHECKPOINT: SandboxCheckpointRecord = {
  ref: "refs/opensession/checkpoints/bks-retire",
  commit: "c".repeat(40),
  head: "h".repeat(40),
  tree: "t".repeat(40),
  branch: "acme-fix",
  at: "2026-02-01T00:00:00.000Z",
};

/** A Sandbox whose working copy reports `work` to the check script. */
function fakeSandbox(work: string, exitCode = 0) {
  const scripts: string[] = [];
  const sandbox = {
    id: "opensession-sbx-bks-retire",
    cwd: "/home/ubuntu/worktrees/acme-fix",
    exec: async (cmd: string[]) => {
      scripts.push(cmd.at(-1)!);
      return { exitCode, stdout: `${work}\n`, stderr: "" };
    },
    status: async () => "running",
  } as unknown as Sandbox;
  return { sandbox, scripts };
}

function deps(
  sandbox: Sandbox | null,
  over: Partial<SandboxWorkBankDeps> = {},
) {
  const calls: string[] = [];
  const d: SandboxWorkBankDeps = {
    wake: async () => {
      calls.push("wake");
      return sandbox && { sandbox, woke: true };
    },
    sleep: async () => {
      calls.push("sleep");
    },
    checkpoint: async () => {
      calls.push("checkpoint");
      return { state: "pushed", checkpoint: CHECKPOINT };
    },
    memo: new Map(),
    ...over,
  };
  return { d, calls };
}

describe("banking a Sandbox's work before retention destroys it", () => {
  test("a clean working copy with nothing unpushed can go", async () => {
    const { sandbox, scripts } = fakeSandbox("work 0 0 0");
    const t = deps(sandbox);
    expect(await bankSandboxWork(session(), t.d)).toEqual({
      retire: true,
      why: "clean",
    });
    expect(scripts).toEqual([SANDBOX_WORK_CHECK_SCRIPT]);
    expect(t.calls).toEqual(["wake"]);
  });

  test("uncommitted changes are checkpointed to origin first, then it can go", async () => {
    const { sandbox } = fakeSandbox("work 2 0 0");
    const t = deps(sandbox);
    expect(await bankSandboxWork(session(), t.d)).toEqual({
      retire: true,
      why: "banked",
      checkpoint: CHECKPOINT,
    });
    expect(t.calls).toEqual(["wake", "checkpoint"]);
  });

  test("unpushed commits on the session branch are checkpointed too", async () => {
    const { sandbox } = fakeSandbox("work 0 3 0");
    const t = deps(sandbox, {
      checkpoint: async () => ({ state: "unchanged", checkpoint: CHECKPOINT }),
    });
    expect((await bankSandboxWork(session(), t.d)).retire).toBe(true);
  });

  test("work the checkpoint cannot take is kept and the Sandbox put back to sleep", async () => {
    const { sandbox } = fakeSandbox("work 1 0 0");
    const t = deps(sandbox, {
      checkpoint: async () => ({
        state: "skipped",
        reason: "session is on the default branch",
      }),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verdict = await bankSandboxWork(session(), t.d);
      expect(verdict.retire).toBe(false);
      if (!verdict.retire)
        expect(verdict.reason).toContain("session is on the default branch");
    } finally {
      warn.mockRestore();
    }
    expect(t.calls).toEqual(["wake", "sleep"]);
  });

  test("a failed checkpoint push keeps it", async () => {
    const { sandbox } = fakeSandbox("work 1 1 0");
    const t = deps(sandbox, {
      checkpoint: async () => {
        throw new Error("checkpoint push failed: remote rejected");
      },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verdict = await bankSandboxWork(session(), t.d);
      expect(verdict.retire).toBe(false);
      if (!verdict.retire) expect(verdict.reason).toContain("remote rejected");
    } finally {
      warn.mockRestore();
    }
  });

  test("unpushed commits on another local branch are kept: a checkpoint holds only the checked-out one", async () => {
    const { sandbox } = fakeSandbox("work 0 0 4");
    const t = deps(sandbox);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verdict = await bankSandboxWork(session(), t.d);
      expect(verdict.retire).toBe(false);
      if (!verdict.retire) expect(verdict.reason).toContain("other branches");
    } finally {
      warn.mockRestore();
    }
    expect(t.calls).not.toContain("checkpoint");
  });

  test("a Sandbox that cannot be woken or checked is kept", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unreachable = deps(null, {
        wake: async () => {
          throw new Error("podman start failed");
        },
      });
      const a = await bankSandboxWork(session(), unreachable.d);
      expect(a.retire).toBe(false);
      if (!a.retire) expect(a.reason).toContain("podman start failed");

      const { sandbox } = fakeSandbox("", 128);
      const b = await bankSandboxWork(session(), deps(sandbox).d);
      expect(b.retire).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a Sandbox the provider no longer has holds nothing to bank", async () => {
    const t = deps(null);
    expect(await bankSandboxWork(session(), t.d)).toEqual({
      retire: true,
      why: "gone",
    });
  });

  test("a session on this machine has no work in a Sandbox", async () => {
    const t = deps(null);
    expect(
      await bankSandboxWork(
        session({
          sandbox: { provider: "local", sandboxId: "x" },
        } as Partial<UnifiedSession>),
        t.d,
      ),
    ).toEqual({ retire: true, why: "no sandbox workspace" });
    expect(t.calls).toEqual([]);
  });

  test("a kept Sandbox is not woken again until its session changes", async () => {
    const { sandbox } = fakeSandbox("work 1 0 0");
    const t = deps(sandbox, {
      checkpoint: async () => ({
        state: "skipped",
        reason: "no GitHub credential",
      }),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bankSandboxWork(session(), t.d);
      const again = await bankSandboxWork(session(), t.d);
      expect(again.retire).toBe(false);
      expect(t.calls.filter((c) => c === "wake")).toHaveLength(1);
      await bankSandboxWork(
        session({ lastActivity: "2026-02-02T00:00:00.000Z" }),
        t.d,
      );
      expect(t.calls.filter((c) => c === "wake")).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("the check script counts uncommitted files, unpushed commits on HEAD, and on other branches", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-work-bank-"));
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "acme",
          GIT_AUTHOR_EMAIL: "dev@example.test",
          GIT_COMMITTER_NAME: "acme",
          GIT_COMMITTER_EMAIL: "dev@example.test",
        },
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    const check = (cwd: string) =>
      Bun.spawnSync(["bash", "-c", SANDBOX_WORK_CHECK_SCRIPT], {
        env: { ...process.env, OS_CWD: cwd },
      })
        .stdout.toString()
        .trim();
    try {
      const origin = join(root, "origin.git");
      const work = join(root, "work");
      git(root, "init", "-q", "--bare", origin);
      git(root, "init", "-q", "-b", "main", work);
      writeFileSync(join(work, "a.txt"), "a\n");
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "a");
      git(work, "remote", "add", "origin", origin);
      git(work, "push", "-q", "origin", "main");
      expect(check(work)).toBe("work 0 0 0");
      // Describes this machine's processes; never checkpointed, not work.
      writeFileSync(join(work, ".ports.conf"), "web 3000\n");
      expect(check(work)).toBe("work 0 0 0");

      writeFileSync(join(work, "b.txt"), "b\n");
      expect(check(work)).toBe("work 1 0 0");
      git(work, "add", "b.txt");
      git(work, "commit", "-q", "-m", "b");
      expect(check(work)).toBe("work 0 1 0");

      git(work, "checkout", "-q", "-b", "acme-side", "origin/main");
      writeFileSync(join(work, "c.txt"), "c\n");
      git(work, "add", "c.txt");
      git(work, "commit", "-q", "-m", "c");
      git(work, "checkout", "-q", "main");
      expect(check(work)).toBe("work 0 1 1");

      expect(check(join(root, "missing"))).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
