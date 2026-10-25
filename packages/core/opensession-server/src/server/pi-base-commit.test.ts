import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { readBaseCommit } from "./pi-session-setup";

/** The commit a new session starts from, read from its checkout for the
 * opening session context. */

const root = mkdtempSync(join(tmpdir(), "bks-base-commit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readBaseCommit", () => {
  test("reads the short id and committer date of HEAD", async () => {
    const repo = join(root, "repo");
    await $`git init -q -b main ${repo}`.quiet();
    writeFileSync(join(repo, "a.txt"), "a\n");
    await $`git -C ${repo} add a.txt`.quiet();
    await $`git -C ${repo} -c user.name=Test -c user.email=test@example.com commit -q -m init`
      .env({
        ...process.env,
        GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
        GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
      })
      .quiet();
    const head = (
      await $`git -C ${repo} rev-parse --short HEAD`.quiet().text()
    ).trim();
    const base = await readBaseCommit(repo);
    expect(base?.sha).toBe(head);
    expect(new Date(base!.committedAt).toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  test("is null outside a git checkout", async () => {
    const plain = join(root, "plain");
    await $`mkdir -p ${plain}`.quiet();
    expect(await readBaseCommit(plain)).toBeNull();
  });
});
