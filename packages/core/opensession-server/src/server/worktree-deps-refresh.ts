/**
 * Dependencies after a command moves a session's worktree onto other code.
 * A new worktree runs its setup once, on the code it was created from. A
 * sub-task session told to `git reset --hard origin/<integration>` then works
 * on different code with the old `node_modules`, and fails on missing
 * packages. When a command that can move the checkout changes a lockfile,
 * the worktree's own setup (`installWorktreeDeps`: `.agents/setup`, the
 * repo's `worktreeSetup`/`depsInstall`, else `bun install`) runs again
 * before the command's result goes back to the agent.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** Files whose change means the installed dependencies may not match. */
const DEPENDENCY_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/** `git` with a subcommand that can replace the checked-out code. */
const MOVING_GIT =
  /(?:^|[\s;&|(])git(?:\s+(?:-C\s+\S+|-c\s+\S+|--\S+))*\s+(?:reset|checkout|switch|pull|merge|rebase)\b/;

export function movesCheckout(command: string): boolean {
  return MOVING_GIT.test(command);
}

/** One hash over the dependency files (a missing file counts too). */
export async function dependencySignature(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of DEPENDENCY_FILES) {
    hash.update(`${name}\0`);
    try {
      hash.update(await readFile(join(dir, name)));
    } catch {
      hash.update("\u0001missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export type DepsReinstall = () => Promise<
  { ok: true } | { ok: false; message: string }
>;

/** `tool` (the bash tool) with the dependencies set up again whenever one
 *  of its commands moves the checkout in `dir` and changes a lockfile. */
export function withDepsRefresh(
  tool: ToolDefinition<any, any, any>,
  opts: { dir: string; reinstall: DepsReinstall },
): ToolDefinition<any, any, any> {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = String((params as { command?: unknown })?.command ?? "");
      const before = movesCheckout(command)
        ? await dependencySignature(opts.dir).catch(() => null)
        : null;
      const result = await tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      if (before === null) return result;
      const after = await dependencySignature(opts.dir).catch(() => before);
      if (after === before) return result;
      const outcome = await opts.reinstall().catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }));
      const note = outcome.ok
        ? "[The lockfile changed, so the worktree's setup ran again to install the dependencies.]"
        : `[The lockfile changed, but setting up the dependencies again failed: ${outcome.message} Install them yourself before building or testing.]`;
      const [first, ...rest] = result.content ?? [];
      return {
        ...result,
        content:
          first?.type === "text"
            ? [{ ...first, text: `${first.text}\n\n${note}` }, ...rest]
            : [...(result.content ?? []), { type: "text", text: note }],
      };
    },
  };
}

/** Wait for a setup already running in `dir` (the one a new worktree starts
 *  in the background, perhaps in another process) so two installs never
 *  write the same `node_modules`. Gives up at the deadline. */
async function waitForRunningSetup(dir: string, deadline: number) {
  const { canonicalResourceDir, listSessionResources, sessionResourceAlive } =
    await import("./session-resources");
  const canonical = await canonicalResourceDir(dir);
  while (Date.now() < deadline) {
    let running = false;
    for (const record of listSessionResources()) {
      if (record.kind !== "setup" || record.worktreeDir !== canonical) continue;
      if (await sessionResourceAlive(record)) {
        running = true;
        break;
      }
    }
    if (!running) return;
    await Bun.sleep(1_000);
  }
}

/** The worktree's own setup, run again for `dir` (installWorktreeDeps). */
export function reinstallWorktreeDeps(
  dir: string,
  sessionId?: string,
): DepsReinstall {
  return async () => {
    const { installWorktreeDeps, repoForPathOrNull, worktreeSetupTimeoutMs } =
      await import("./worktree");
    const repo = repoForPathOrNull(dir);
    if (!repo) return { ok: true };
    await waitForRunningSetup(dir, Date.now() + worktreeSetupTimeoutMs(repo));
    const result = await installWorktreeDeps(
      repo,
      dir,
      basename(dir),
      sessionId ? { sessionId } : {},
    );
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  };
}
