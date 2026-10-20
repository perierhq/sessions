import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";
import {
  RepoBeingRemovedError,
  assertRepoNotBeingRemoved,
  isRepoBeingRemoved,
  markRepoRemoving,
  sessionRepoBlocker,
  sessionRepoOrThrow,
  unmarkRepoRemoving,
} from "./repo-removal-guard";

const savedConfig = process.env.OPENSESSION_CONFIG;
const dirs: string[] = [];

afterEach(async () => {
  unmarkRepoRemoving("widget");
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  await getConfigAsync();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function registerWidget(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "os-removal-guard-"));
  dirs.push(dir);
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      repos: { widget: { repo: join(dir, "widget"), defaultBranch: "main" } },
    }),
  );
  process.env.OPENSESSION_CONFIG = configPath;
  await getConfigAsync();
}

describe("repository removal guard", () => {
  test("marks one removal at a time and refuses new work meanwhile", () => {
    expect(isRepoBeingRemoved("widget")).toBe(false);
    expect(markRepoRemoving("widget")).toBe(true);
    expect(markRepoRemoving("widget")).toBe(false);
    expect(isRepoBeingRemoved("widget")).toBe(true);
    expect(() => assertRepoNotBeingRemoved("widget")).toThrow(
      RepoBeingRemovedError,
    );
    expect(() => assertRepoNotBeingRemoved("other")).not.toThrow();
    unmarkRepoRemoving("widget");
    expect(isRepoBeingRemoved("widget")).toBe(false);
  });

  test("a session in a repository being removed can't run", async () => {
    await registerWidget();
    expect(sessionRepoBlocker({ repo: "widget" })).toBeNull();
    markRepoRemoving("widget");
    expect(sessionRepoBlocker({ repo: "widget" })).toContain(
      "is being removed",
    );
    // Attaching it counts too.
    expect(
      sessionRepoBlocker({
        repo: "other",
        attachedRepos: [{ repo: "widget" }],
      }),
    ).toContain("is being removed");
  });

  test("a session whose repository is gone gets a clear message", async () => {
    await registerWidget();
    const message = sessionRepoBlocker({ repo: "acme-removed" });
    expect(message).toContain('"acme-removed" is no longer on this server');
    expect(() => sessionRepoOrThrow("acme-removed")).toThrow(
      "no longer on this server",
    );
    expect(sessionRepoOrThrow("widget").id).toBe("widget");
    // Repo-less sessions and ones that never recorded a repo are left alone.
    expect(sessionRepoBlocker({ repo: "acme-removed", repoLess: true })).toBe(
      null,
    );
    expect(sessionRepoBlocker({})).toBeNull();
  });
});
