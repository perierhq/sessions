import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deleteWorkspaceSecret,
  deleteWorkspaceSecretAsync,
  putWorkspaceSecret,
  putWorkspaceSecretAsync,
  resolveWorkspaceSecret,
  resolveWorkspaceSecretAsync,
  workspaceSecretExists,
} from "./workspace-secrets";

let scratch = "";
let previous: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-workspace-secrets-"));
  previous = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    scratch,
    "secrets.json",
  );
});

afterEach(() => {
  if (previous === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previous;
  rmSync(scratch, { recursive: true, force: true });
});

describe("workspace secrets", () => {
  test("creates, rotates, resolves and deletes an opaque 0600 secret", () => {
    const ref = putWorkspaceSecret("sandbox.daytona", "first");
    expect(ref).toMatch(/^wssec-/);
    expect(resolveWorkspaceSecret(ref)).toBe("first");
    expect(
      statSync(process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!).mode & 0o777,
    ).toBe(0o600);

    expect(putWorkspaceSecret("sandbox.daytona", "second", ref)).toBe(ref);
    expect(resolveWorkspaceSecret(ref)).toBe("second");
    expect(workspaceSecretExists(ref)).toBe(true);
    expect(
      readFileSync(process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!, "utf-8"),
    ).not.toContain("daytona-secret");

    expect(deleteWorkspaceSecret(ref)).toBe(true);
    expect(workspaceSecretExists(ref)).toBe(false);
  });

  test("async writers create, rotate and delete a 0600 secret", async () => {
    const path = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!;
    const ref = await putWorkspaceSecretAsync("p", "v");
    expect(ref).toMatch(/^wssec-/);
    expect(await resolveWorkspaceSecretAsync(ref)).toBe("v");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(await putWorkspaceSecretAsync("p", "w", ref)).toBe(ref);
    expect(await resolveWorkspaceSecretAsync(ref)).toBe("w");
    // The sync readers see what the async writers wrote.
    expect(resolveWorkspaceSecret(ref)).toBe("w");

    expect(await deleteWorkspaceSecretAsync(ref)).toBe(true);
    expect(await deleteWorkspaceSecretAsync(ref)).toBe(false);
    expect(await resolveWorkspaceSecretAsync(ref)).toBeUndefined();
  });

  test("concurrent async writes keep every secret", async () => {
    const refs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        putWorkspaceSecretAsync(`p${i}`, `v${i}`),
      ),
    );
    for (const [i, ref] of refs.entries())
      expect(await resolveWorkspaceSecretAsync(ref)).toBe(`v${i}`);
    await Promise.all(refs.slice(0, 4).map(deleteWorkspaceSecretAsync));
    for (const [i, ref] of refs.entries())
      expect(await resolveWorkspaceSecretAsync(ref)).toBe(
        i < 4 ? undefined : `v${i}`,
      );
  });

  test("async writers reject an empty purpose or value", async () => {
    await expect(putWorkspaceSecretAsync(" ", "v")).rejects.toThrow();
    await expect(putWorkspaceSecretAsync("p", "")).rejects.toThrow();
  });
});
