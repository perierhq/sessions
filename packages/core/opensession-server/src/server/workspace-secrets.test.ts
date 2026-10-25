import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as secrets from "./workspace-secrets";
import {
  deleteWorkspaceSecretAsync,
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
  test("only the async writers exist, so every write joins one chain", () => {
    expect("putWorkspaceSecret" in secrets).toBe(false);
    expect("deleteWorkspaceSecret" in secrets).toBe(false);
  });

  test("creates, rotates, resolves and deletes an opaque 0600 secret", async () => {
    const path = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!;
    const ref = await putWorkspaceSecretAsync("sandbox.daytona", "first");
    expect(ref).toMatch(/^wssec-/);
    expect(resolveWorkspaceSecret(ref)).toBe("first");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(
      await putWorkspaceSecretAsync("sandbox.daytona", "second", ref),
    ).toBe(ref);
    expect(resolveWorkspaceSecret(ref)).toBe("second");
    expect(workspaceSecretExists(ref)).toBe(true);
    expect(readFileSync(path, "utf-8")).not.toContain("first");

    expect(await deleteWorkspaceSecretAsync(ref)).toBe(true);
    expect(workspaceSecretExists(ref)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
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

  // Root reads a 0000 file anyway, so the unreadable case needs a normal user.
  const asRoot = process.getuid?.() === 0;
  test.skipIf(asRoot)(
    "an unreadable store fails every read and write, never empties the store",
    async () => {
      const path = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!;
      const ref = await putWorkspaceSecretAsync("p", "kept");
      chmodSync(path, 0o000);
      try {
        await expect(putWorkspaceSecretAsync("q", "new")).rejects.toThrow();
        await expect(deleteWorkspaceSecretAsync(ref)).rejects.toThrow();
        await expect(resolveWorkspaceSecretAsync(ref)).rejects.toThrow();
        expect(() => resolveWorkspaceSecret(ref)).toThrow();
        expect(() => workspaceSecretExists(ref)).toThrow();
      } finally {
        chmodSync(path, 0o600);
      }
      expect(await resolveWorkspaceSecretAsync(ref)).toBe("kept");
      expect(JSON.parse(readFileSync(path, "utf-8")).secrets).toHaveLength(1);
    },
  );

  test("a store that doesn't parse fails reads instead of reading as empty", async () => {
    const path = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!;
    writeFileSync(path, "{not json", { mode: 0o600 });
    await expect(putWorkspaceSecretAsync("p", "v")).rejects.toThrow();
    await expect(resolveWorkspaceSecretAsync("wssec-x")).rejects.toThrow();
    expect(() => resolveWorkspaceSecret("wssec-x")).toThrow();
    expect(readFileSync(path, "utf-8")).toBe("{not json");
  });

  test("a missing store reads as empty", async () => {
    expect(await resolveWorkspaceSecretAsync("wssec-x")).toBeUndefined();
    expect(resolveWorkspaceSecret("wssec-x")).toBeUndefined();
    expect(workspaceSecretExists("wssec-x")).toBe(false);
    expect(await deleteWorkspaceSecretAsync("wssec-x")).toBe(false);
  });
});
