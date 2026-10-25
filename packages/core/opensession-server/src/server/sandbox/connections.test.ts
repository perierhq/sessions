import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { availableParallelism, tmpdir } from "os";
import { join } from "path";
import {
  connectSandboxProvider,
  disconnectSandboxProvider,
  getSandboxConnection,
  PODMAN_SELF_TEST_ROWS_MAX,
  type PodmanSelfTestRow,
  safeSandboxConnections,
  sandboxConnectionReady,
  sandboxHostSettings,
  sandboxProviderCredential,
  sandboxAdapterSignature,
  setPodmanConnectionFacts,
  setSandboxConnectionQualification,
  updateSandboxConnection,
} from "./connections";
import { sandboxProviderNeedsCredential } from "./adapter-signature";
import { GIB, recordPodmanDiskReport } from "./adapters/podman-disk";
import {
  putWorkspaceSecretAsync,
  resolveWorkspaceSecretAsync,
} from "../workspace-secrets";

let scratch = "";
let oldConfig: string | undefined;
let oldSecrets: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-sandbox-connections-"));
  oldConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
  oldSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_SANDBOX_CONFIG = join(scratch, "sandbox.json");
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    scratch,
    "secrets.json",
  );
});

afterEach(() => {
  if (oldConfig === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = oldConfig;
  if (oldSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = oldSecrets;
  rmSync(scratch, { recursive: true, force: true });
});

describe("Mac VM hosts", () => {
  test("a Mac VM connection needs at least one host and keeps them in order", async () => {
    await expect(
      connectSandboxProvider("tart", { settings: {} }),
    ).rejects.toThrow(/at least one paired macOS Runner/);
    const connection = await connectSandboxProvider("tart", {
      settings: {
        hosts: [
          { runner: "mini-1", maxVms: 2 },
          { runner: "mini-1" },
          { runner: " ec2-mac-1 ", maxVms: 1.4 },
          { runner: "" },
        ],
      },
    });
    expect(connection.settings.hosts).toEqual([
      { runner: "mini-1", maxVms: 2 },
      { runner: "ec2-mac-1", maxVms: 1 },
    ]);
    expect(sandboxHostSettings(connection.settings)).toEqual(
      connection.settings.hosts!,
    );
  });

  test("the single-host form still reads as one host and a host list replaces it", async () => {
    const single = await connectSandboxProvider("tart", {
      settings: { runner: "mini-1", maxVms: 2 },
    });
    expect(sandboxHostSettings(single.settings)).toEqual([
      { runner: "mini-1", maxVms: 2 },
    ]);
    const listed = updateSandboxConnection("tart", {
      settings: { hosts: [{ runner: "mini-2" }] },
    });
    expect(listed.settings.runner).toBeUndefined();
    expect(listed.settings.maxVms).toBeUndefined();
    expect(sandboxHostSettings(listed.settings)).toEqual([
      { runner: "mini-2" },
    ]);
  });
});

describe("use.computer", () => {
  test("needs an account key and keeps the reservation setting", async () => {
    await expect(
      connectSandboxProvider("usecomputer", { settings: {} }),
    ).rejects.toThrow(/use.computer API key is required/);
    const connection = await connectSandboxProvider("usecomputer", {
      secret: "uc_live_secret",
      settings: { reservation: " 00000000-0000-4000-8000-000000000001 " },
    });
    expect(connection.settings.reservation).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(sandboxProviderCredential("usecomputer")).toEqual({
      apiKey: "uc_live_secret",
    });
    expect(
      readFileSync(process.env.OPENSESSION_SANDBOX_CONFIG!, "utf-8"),
    ).not.toContain("uc_live_secret");
  });
});

describe("workspace sandbox connections", () => {
  test("stores Daytona credentials behind an opaque reference and never returns it", async () => {
    await connectSandboxProvider("daytona", {
      secret: "daytona-secret-value",
      settings: {
        apiUrl: "https://daytona.example.test",
        snapshot: "team-large",
      },
    });

    const configText = readFileSync(
      process.env.OPENSESSION_SANDBOX_CONFIG!,
      "utf-8",
    );
    expect(configText).not.toContain("daytona-secret-value");
    expect(configText).toContain("wssec-");
    expect(sandboxProviderCredential("daytona")).toEqual({
      apiKey: "daytona-secret-value",
    });

    const safe = safeSandboxConnections().find(
      (value) => value.provider === "daytona",
    )!;
    expect(safe.hasCredentials).toBe(true);
    expect(safe.state).toBe("checking");
    expect(safe).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(safe)).not.toContain("daytona-secret-value");
  });

  test("stores Box credentials behind an opaque reference and exposes only readiness", async () => {
    await connectSandboxProvider("box", {
      secret: "box-secret-value",
      settings: { apiUrl: "https://box.example.test/v1" },
    });
    const configText = readFileSync(
      process.env.OPENSESSION_SANDBOX_CONFIG!,
      "utf-8",
    );
    expect(configText).not.toContain("box-secret-value");
    expect(sandboxProviderCredential("box")).toEqual({
      apiKey: "box-secret-value",
    });
    expect(
      safeSandboxConnections().find((value) => value.provider === "box"),
    ).toMatchObject({
      hasCredentials: true,
      state: "checking",
      settings: { apiUrl: "https://box.example.test/v1" },
    });
  });

  test("rotates Box credentials in place and disconnect deletes the secret", async () => {
    const first = await connectSandboxProvider("box", { secret: "box_one" });
    const ref = first.credentialRef;
    const second = await connectSandboxProvider("box", { secret: "box_two" });
    expect(second.id).toBe(first.id);
    expect(second.credentialRef).toBe(ref);
    expect(sandboxProviderCredential("box")).toEqual({ apiKey: "box_two" });

    expect(await disconnectSandboxProvider("box")).toBe(true);
    expect(getSandboxConnection("box")).toBeUndefined();
    expect(sandboxProviderCredential("box")).toBeUndefined();
  });

  test("a key saved or deleted while another secret is written is never lost", async () => {
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    // Land the sandbox write at every point of an in-flight inbox password
    // write: before its read, between its read and rename, and after.
    for (let depth = 0; depth < 12; depth++) {
      const inboxWrite = putWorkspaceSecretAsync(`support-inbox:${depth}`, "a");
      for (let i = 0; i < depth; i++) await turn();
      const connection = await connectSandboxProvider("box", {
        secret: `box_${depth}`,
      });
      const inboxRef = await inboxWrite;
      expect(await resolveWorkspaceSecretAsync(inboxRef)).toBe("a");
      expect(await resolveWorkspaceSecretAsync(connection.credentialRef!)).toBe(
        `box_${depth}`,
      );

      const secondWrite = putWorkspaceSecretAsync(
        `support-inbox:${depth}`,
        "b",
      );
      for (let i = 0; i < depth; i++) await turn();
      expect(await disconnectSandboxProvider("box")).toBe(true);
      const secondRef = await secondWrite;
      expect(await resolveWorkspaceSecretAsync(secondRef)).toBe("b");
      expect(
        await resolveWorkspaceSecretAsync(connection.credentialRef!),
      ).toBeUndefined();
    }
  });

  test("only enabled, successfully qualified connections become Ready", async () => {
    await connectSandboxProvider("daytona", {
      secret: "daytona-secret",
      settings: { cpu: 4, memoryMb: 8192 },
    });
    expect(sandboxConnectionReady("daytona")).toBe(false);
    setSandboxConnectionQualification("daytona", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(sandboxConnectionReady("daytona")).toBe(true);
    expect(
      safeSandboxConnections().find((value) => value.provider === "daytona")
        ?.state,
    ).toBe("ready");
  });

  test("a runner pin change does not invalidate provider qualification", async () => {
    await connectSandboxProvider("daytona", { secret: "daytona-secret" });
    setSandboxConnectionQualification("daytona", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    const path = process.env.OPENSESSION_SANDBOX_CONFIG!;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.connections[0].qualification.adapterSignature =
      "daytona:connection-v2:old-runner-pin+node@24.18.1+workspace-runtime-v7";
    writeFileSync(path, JSON.stringify(raw));

    expect(sandboxConnectionReady("daytona")).toBe(true);
    expect(
      safeSandboxConnections().find((value) => value.provider === "daytona")
        ?.state,
    ).toBe("ready");
  });

  test("an adapter signature change makes a previous qualification stale", async () => {
    await connectSandboxProvider("box", { secret: "box_key" });
    setSandboxConnectionQualification("box", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    const path = process.env.OPENSESSION_SANDBOX_CONFIG!;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.connections[0].qualification.adapterSignature = "box:old-adapter";
    writeFileSync(path, JSON.stringify(raw));

    expect(sandboxConnectionReady("box")).toBe(false);
    expect(
      safeSandboxConnections().find((value) => value.provider === "box")?.state,
    ).toBe("needs_attention");
  });
});

describe("This machine (container)", () => {
  test("needs no credential and is not ready until qualified", async () => {
    expect(sandboxProviderNeedsCredential("podman")).toBe(false);
    expect(sandboxAdapterSignature("podman")).toBe("podman:connection-v1");
    expect(sandboxConnectionReady("podman")).toBe(false);
    const connection = await connectSandboxProvider("podman", {
      settings: { memoryMb: 2048, pidsLimit: 512, dns: ["8.8.8.8", "bad"] },
    });
    expect(connection.credentialRef).toBeUndefined();
    expect(connection.settings).toMatchObject({
      memoryMb: 2048,
      pidsLimit: 512,
      dns: ["8.8.8.8"],
    });
    expect(sandboxConnectionReady("podman")).toBe(false);
    setSandboxConnectionQualification("podman", { status: "ready" });
    expect(sandboxConnectionReady("podman")).toBe(true);
    const card = safeSandboxConnections("linux").find(
      (c) => c.provider === "podman",
    );
    expect(card).toMatchObject({
      hasCredentials: false,
      needsCredential: false,
      state: "ready",
    });
    updateSandboxConnection("podman", { enabled: false });
    expect(sandboxConnectionReady("podman")).toBe(false);
  });

  test("an API key sent anyway is never stored", async () => {
    const connection = await connectSandboxProvider("podman", {
      secret: "sk-should-not-be-kept",
      settings: {},
    });
    expect(connection.credentialRef).toBeUndefined();
    expect(sandboxProviderCredential("podman")).toBeUndefined();
    expect(
      readFileSync(process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!, {
        encoding: "utf8",
        flag: "a+",
      }),
    ).not.toContain("sk-should-not-be-kept");
  });

  test("qualification facts are kept on the connection", async () => {
    await connectSandboxProvider("podman", { settings: {} });
    setPodmanConnectionFacts({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: false,
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    expect(getSandboxConnection("podman")?.podman).toEqual({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: false,
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    await disconnectSandboxProvider("podman");
    expect(getSandboxConnection("podman")).toBeUndefined();
  });

  test("self-test rows are stored bounded, and only their count reaches the card", async () => {
    await connectSandboxProvider("podman", { settings: {} });
    const rows: PodmanSelfTestRow[] = Array.from({ length: 100 }, (_, i) => [
      `tcp:10.0.0.${i}:22`,
      "filtered",
      "x".repeat(500),
    ]);
    setPodmanConnectionFacts({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: false,
      selfTestAt: "2026-10-22T10:00:00.000Z",
      selfTestRows: rows,
      ensureSelfTestRows: [["dns:example.test", "reachable", "resolved"]],
    });
    const stored = getSandboxConnection("podman")?.podman;
    expect(stored?.selfTestRows).toHaveLength(PODMAN_SELF_TEST_ROWS_MAX);
    expect(stored?.selfTestRows?.[0]).toEqual([
      "tcp:10.0.0.0:22",
      "filtered",
      "x".repeat(80),
    ]);
    expect(stored?.ensureSelfTestRows).toEqual([
      ["dns:example.test", "reachable", "resolved"],
    ]);
    const card = safeSandboxConnections("linux").find(
      (c) => c.provider === "podman",
    )?.podman;
    expect(card?.selfTestProbes).toBe(PODMAN_SELF_TEST_ROWS_MAX);
    expect(card).not.toHaveProperty("selfTestRows");
    expect(card).not.toHaveProperty("ensureSelfTestRows");
  });
});

describe("This machine (container) in Settings", () => {
  test("is offered only on Linux until it is connected", async () => {
    const ids = (platform: string) =>
      safeSandboxConnections(platform).map((c) => c.provider);
    expect(ids("linux")).toContain("podman");
    expect(ids("darwin")).not.toContain("podman");
    await connectSandboxProvider("podman", { settings: {} });
    expect(ids("darwin")).toContain("podman");
  });

  test("the card summary carries the facts and the effective limits", async () => {
    // Another test file's disk checks may have recorded a report.
    recordPodmanDiskReport(undefined);
    await connectSandboxProvider("podman", { settings: { pidsLimit: 256 } });
    const before = safeSandboxConnections("linux").find(
      (c) => c.provider === "podman",
    );
    expect(before?.podman).toBeUndefined();
    // It takes no credential, so it has none, and that does not hold it back.
    expect(before?.hasCredentials).toBe(false);
    expect(before?.needsCredential).toBe(false);
    setPodmanConnectionFacts({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: false,
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    const after = safeSandboxConnections("linux").find(
      (c) => c.provider === "podman",
    );
    expect(after?.podman).toEqual({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: false,
      selfTestAt: "2026-10-22T10:00:00.000Z",
      memoryMb: 4096,
      pidsLimit: 256,
    });
  });

  test("the card summary carries the effective CPU limit when the host can apply it", async () => {
    await connectSandboxProvider("podman", { settings: {} });
    setPodmanConnectionFacts({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: true,
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    const card = () =>
      safeSandboxConnections("linux").find((c) => c.provider === "podman")
        ?.podman;
    expect(card()?.cpu).toBe(Math.min(2, availableParallelism()));
    updateSandboxConnection("podman", { settings: { cpu: 0.5 } });
    expect(card()?.cpu).toBe(0.5);
  });

  test("limits are clamped on save and the card shows what applies", async () => {
    const connection = await connectSandboxProvider("podman", {
      settings: { memoryMb: 10, pidsLimit: 1e9, cpu: 1e6 },
    });
    expect(connection.settings.memoryMb).toBe(512);
    expect(connection.settings.pidsLimit).toBe(65_536);
    expect(connection.settings.cpu).toBeLessThan(1e6);
    updateSandboxConnection("podman", { settings: { pidsLimit: 3 } });
    expect(getSandboxConnection("podman")?.settings.pidsLimit).toBe(64);
    // A value stored before the bounds existed is shown as it applies.
    const path = process.env.OPENSESSION_SANDBOX_CONFIG!;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.connections[0].settings.pidsLimit = 1e9;
    writeFileSync(path, JSON.stringify(raw));
    setPodmanConnectionFacts({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: true,
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    const card = safeSandboxConnections("linux").find(
      (c) => c.provider === "podman",
    )?.podman;
    expect(card?.pidsLimit).toBe(65_536);
    expect(card?.memoryMb).toBe(512);
  });

  test("the card summary carries the last disk check's warnings", async () => {
    await connectSandboxProvider("podman", { settings: {} });
    setPodmanConnectionFacts({
      imageTag: "localhost/opensession-sandbox:0123456789abcdef",
      cpuLimited: true,
      selfTestAt: "2026-10-22T10:00:00.000Z",
    });
    const podman = () =>
      safeSandboxConnections("linux").find((c) => c.provider === "podman")
        ?.podman;
    expect(podman()?.diskWarnings).toBeUndefined();
    try {
      recordPodmanDiskReport({
        checkedAt: "2026-10-22T10:00:00.000Z",
        freeBytes: 50 * GIB,
        volumes: [{ sandboxId: "os-a", sessionId: "a", bytes: 11 * GIB }],
      });
      expect(podman()?.diskWarnings).toEqual([
        "Session a uses 11.0 GiB (stops at 20.0 GiB)",
      ]);
    } finally {
      recordPodmanDiskReport(undefined);
    }
  });
});
