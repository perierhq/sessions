import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AUTO_CONTINUE_USER } from "./auto-continue";
import { getConfigAsync } from "./config";
import { deskStateContext } from "./desk-state";
import { parseContextBlocks } from "./prompt-context";
import { setPersonalOutputStyle } from "./personal-output-style";
import { setPersonalPrompt } from "./personal-prompts";
import { workerActor } from "./session-actors";
import { buildSessionNote } from "./session-repos";
import type { UnifiedSession } from "./types";

/**
 * The session note rides in the system prompt, so every byte of it that
 * changes between two turns of one session re-caches the whole conversation
 * behind it. A turn nobody typed (a background wait, an auto-continue, a
 * worker report) must therefore render the same note as the person's turns.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_MEMORY_MODE"] as const;
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "session-note-stability-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { worktreesDir: join(dir, "worktrees") },
      repos: {
        acme: { repo: process.cwd(), sharedCheckout: true, default: true },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = configPath;
  process.env.OPENSESSION_MEMORY_MODE = "legacy";
  await getConfigAsync();
  setPersonalOutputStyle("Ada Example", "concise");
  setPersonalPrompt("Ada Example", "Answer in British English.");
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await getConfigAsync();
  rmSync(dir, { recursive: true, force: true });
});

function session(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: "os-note-stability",
    source: "opensession",
    mode: "ask",
    repoLess: true,
    worktreeDir: "",
    branch: "",
    startedBy: "Ada Example",
    lastPromptedBy: "Ada Example",
    ...overrides,
  } as UnifiedSession;
}

describe("session note across the turns of one session", () => {
  test("a turn nobody typed keeps the person's output style and personal prompt", async () => {
    const own = await buildSessionNote(session(), "Ada Example");
    expect(own).toContain("## Personal output style: Concise");
    expect(own).toContain("Answer in British English.");
    for (const machine of [
      undefined,
      AUTO_CONTINUE_USER,
      workerActor("os-01a00000-0000-7000-8000-000000000001"),
      "Ada Example (scheduled)",
    ]) {
      expect(await buildSessionNote(session(), machine)).toBe(own);
    }
  });

  test("with no person on record the creator's style still applies", async () => {
    const note = await buildSessionNote(
      session({ lastPromptedBy: undefined }),
      undefined,
    );
    expect(note).toContain("## Personal output style: Concise");
  });

  test("the Desk's live state rides in the turn, not in the system prompt", async () => {
    const note = await buildSessionNote(session({ desk: true }), "Ada Example");
    expect(note).toContain("## Your role: the Desk");
    expect(note).not.toContain("live state");
    expect(note).not.toContain("Nothing is running");

    const context = deskStateContext("Ada Example");
    expect(context).toBeTruthy();
    const blocks = parseContextBlocks(context!);
    expect(blocks.map((block) => block.source)).toEqual(["desk-state"]);
    expect(blocks[0].body).toContain("## The user's live state");
  });
});
