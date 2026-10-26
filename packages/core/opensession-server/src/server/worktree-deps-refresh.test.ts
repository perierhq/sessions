// A command that moves a worktree onto other code (a sub-task session's
// `git reset --hard origin/<integration>`) can change its lockfile: the
// worktree's setup runs again before the agent goes on.
import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { movesCheckout, withDepsRefresh } from "./worktree-deps-refresh";

const dir = await mkdtemp(join(tmpdir(), "deps-refresh-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
await writeFile(join(dir, "bun.lock"), "main");

/** A bash tool whose commands are functions run against the worktree. */
function fakeBash(effects: Record<string, () => Promise<void>>) {
  return {
    name: "bash",
    label: "bash",
    description: "",
    parameters: {},
    execute: async (_id: string, params: { command: string }) => {
      await effects[params.command]?.();
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  } as unknown as ToolDefinition<any, any, any>;
}
const run = (tool: ToolDefinition<any, any, any>, command: string) =>
  tool.execute("call", { command }, undefined, undefined, undefined as never);

test("which commands can move the checkout", () => {
  expect(movesCheckout("git fetch origin x && git reset --hard origin/x")).toBe(
    true,
  );
  expect(movesCheckout("git -C /w checkout feature")).toBe(true);
  expect(movesCheckout("git switch -c next")).toBe(true);
  expect(movesCheckout("git pull --rebase")).toBe(true);
  expect(movesCheckout("git status && ls")).toBe(false);
  expect(movesCheckout("grep -r 'reset' src")).toBe(false);
});

test("a reset that changes the lockfile reruns setup and says so", async () => {
  const reinstall = mock(async () => ({ ok: true as const }));
  const tool = withDepsRefresh(
    fakeBash({
      "git reset --hard origin/integration": () =>
        writeFile(join(dir, "bun.lock"), "integration"),
    }),
    { dir, reinstall },
  );
  const result = await run(tool, "git reset --hard origin/integration");
  expect(reinstall).toHaveBeenCalledTimes(1);
  expect(result.content[0]).toEqual({
    type: "text",
    text: "ok\n\n[The lockfile changed, so the worktree's setup ran again to install the dependencies.]",
  });
});

test("a setup failure is reported, not thrown", async () => {
  const reinstall = mock(async () => ({
    ok: false as const,
    message: "Setup failed (bun install, exit 1).",
  }));
  const tool = withDepsRefresh(
    fakeBash({
      "git checkout other": () => writeFile(join(dir, "bun.lock"), "other"),
    }),
    { dir, reinstall },
  );
  const result = await run(tool, "git checkout other");
  expect(result.content[0]).toHaveProperty(
    "text",
    expect.stringContaining(
      "The lockfile changed, but setting up the dependencies again failed: Setup failed (bun install, exit 1).",
    ),
  );
});

test("no setup when the lockfile stays or the command moves nothing", async () => {
  const reinstall = mock(async () => ({ ok: true as const }));
  const tool = withDepsRefresh(
    fakeBash({
      "ls && touch bun.lock": () => writeFile(join(dir, "bun.lock"), "x"),
    }),
    { dir, reinstall },
  );
  await run(tool, "git reset --hard HEAD");
  await run(tool, "ls && touch bun.lock");
  expect(reinstall).not.toHaveBeenCalled();
});
