/**
 * The in-memory pi settings a turn runs with: cache warming off, SSE for
 * ChatGPT OAuth, and a supervisor session's longer compaction tail, read
 * back through pi's own SettingsManager; and the resources a turn loads,
 * where the supervisor gets no skills and no repository instructions.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  piResourceSet,
  piSessionSettings,
  piThinkingLevel,
  SUPERVISOR_KEEP_RECENT_TOKENS,
} from "./pi-session-setup";
import { SHIPPED_SKILLS_DIR } from "./skill-paths";

function compaction(input: { usesOpenaiOAuth: boolean; supervisor: boolean }) {
  return SettingsManager.inMemory(
    piSessionSettings(input),
  ).getCompactionSettings();
}

describe("piSessionSettings", () => {
  test("a supervisor session keeps 40000 recent tokens and pi's other defaults", () => {
    const supervisor = compaction({ usesOpenaiOAuth: false, supervisor: true });
    const plain = compaction({ usesOpenaiOAuth: false, supervisor: false });
    expect(SUPERVISOR_KEEP_RECENT_TOKENS).toBe(40_000);
    expect(supervisor).toEqual({
      ...plain,
      keepRecentTokens: SUPERVISOR_KEEP_RECENT_TOKENS,
    });
    expect(plain.keepRecentTokens).toBe(20_000);
    expect(supervisor.reserveTokens).toBe(plain.reserveTokens);
    expect(supervisor.enabled).toBe(true);
  });

  test("any other session leaves compaction to pi", () => {
    expect(
      piSessionSettings({ usesOpenaiOAuth: false, supervisor: false }),
    ).toEqual({
      cacheWarming: "off",
    });
    expect(
      piSessionSettings({ usesOpenaiOAuth: true, supervisor: false }),
    ).toEqual({
      cacheWarming: "off",
      transport: "sse",
    });
  });

  test("the setup builds its settings here, from the run's supervisor flag", async () => {
    const source = await Bun.file(
      new URL("./pi-session-setup.ts", import.meta.url),
    ).text();
    expect(source).toMatch(
      /sdk\.SettingsManager\.inMemory\(\s*piSessionSettings\(\{\s*usesOpenaiOAuth: binding\.usesOpenaiOAuth,\s*supervisor,/,
    );
  });
});

describe("piThinkingLevel", () => {
  test("a session's effort sets the level; none set leaves pi's default (medium)", () => {
    // The supervisor's effort is its session's (composer pill or a prompt's
    // effort), carried across rotations (carriedSupervisorSettings).
    expect(piThinkingLevel(undefined)).toBeUndefined();
    expect(piThinkingLevel("low")).toBe("low");
    expect(piThinkingLevel("high")).toBe("high");
    expect(piThinkingLevel("none")).toBe("off");
    expect(piThinkingLevel("bogus")).toBeUndefined();
  });
});

describe("piResourceSet", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-resource-set-"));
  mkdirSync(join(dir, ".agents", "skills", "acme"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", "skills", "acme", "SKILL.md"),
    "---\nname: acme\ndescription: A coding skill.\n---\nBody.\n",
  );
  writeFileSync(join(dir, "AGENTS.local.md"), "Local operator rules.");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("an ordinary session loads the checkout's, the instance's and the shipped skills and instructions", () => {
    const set = piResourceSet({
      dir,
      supervisor: false,
      projectSkillsOnly: false,
    });
    expect(set.skillPaths).toContain(join(dir, ".agents", "skills"));
    expect(set.skillPaths).toContain(SHIPPED_SKILLS_DIR);
    expect(set.contextFiles).toBe(true);
    expect(set.localInstructions).toBe("Local operator rules.");
  });

  test("a support session keeps only its project's skills", () => {
    const set = piResourceSet({
      dir,
      supervisor: false,
      projectSkillsOnly: true,
    });
    expect(set.skillPaths).toEqual([join(dir, ".agents", "skills")]);
    expect(set.contextFiles).toBe(true);
  });

  test("the supervisor loads no skills, AGENTS.md or local instructions", () => {
    expect(
      piResourceSet({ dir, supervisor: true, projectSkillsOnly: false }),
    ).toEqual({
      skillPaths: [],
      contextFiles: false,
      localInstructions: undefined,
    });
  });

  test("the setup loads what piResourceSet returns and trims the supervisor's briefings", async () => {
    const source = await Bun.file(
      new URL("./pi-session-setup.ts", import.meta.url),
    ).text();
    expect(source).toContain("additionalSkillPaths: resources.skillPaths,");
    expect(source).toContain("localInstructions: resources.localInstructions,");
    expect(source).toContain("if (!resources.contextFiles) return false;");
    expect(source).toContain(
      "...(supervisor ? [supervisorBriefingTrimExtension] : []),",
    );
    expect(source).not.toContain("readLocalInstructions(context.dir)");
  });
});
