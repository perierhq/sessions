import { describe, expect, mock, test } from "bun:test";

const calls: string[] = [];
const facts = {
  imageTag: "localhost/opensession-sandbox:0123456789abcdef",
  cpuLimited: true,
  selfTestAt: "2026-10-22T10:00:00.000Z",
};
let refusal: Error | undefined;

mock.module("./ingress-check", () => ({
  verifyPublicSandboxIngress: async () => {
    calls.push("ingress");
  },
}));
mock.module("./adapters/podman", () => ({
  qualifyPodmanConnection: async () => {
    calls.push("podman");
    if (refusal) throw refusal;
    return { ...facts, warnings: [] };
  },
}));

const { qualifySandboxConnection } = await import("./qualification");
const { connectSandboxProvider, getSandboxConnection, sandboxConnectionReady } =
  await import("./connections");

describe("podman qualification dispatch", () => {
  test("qualifies through the podman adapter and records its facts", async () => {
    await connectSandboxProvider("podman", { settings: {} });
    await qualifySandboxConnection("podman", undefined, "linux");
    expect(calls).toEqual(["ingress", "podman"]);
    expect(getSandboxConnection("podman")?.podman).toEqual(facts);
    expect(sandboxConnectionReady("podman")).toBe(true);
  });

  test("a refusal is shown as is and leaves the connection not ready", async () => {
    refusal = new Error(
      "callback base URL resolves to a private or host address (100.101.1.2)",
    );
    await expect(
      qualifySandboxConnection("podman", undefined, "linux"),
    ).rejects.toThrow(
      "Qualification failed: callback base URL resolves to a private or host address (100.101.1.2)",
    );
    expect(sandboxConnectionReady("podman")).toBe(false);
    // The facts from the earlier pass would read "Self-test passed" next to
    // the failure; they go with it.
    expect(getSandboxConnection("podman")?.podman).toBeUndefined();
  });

  test("a long refusal is kept whole, past the old 400-character cut", async () => {
    const probes = Array.from(
      { length: 40 },
      (_, i) => `tcp:203.0.113.${i}:443 (expected unreachable, got open)`,
    ).join("; ");
    refusal = new Error(`isolation self-test failed: ${probes}`);
    await expect(
      qualifySandboxConnection("podman", undefined, "linux"),
    ).rejects.toThrow(probes);
    expect(getSandboxConnection("podman")?.qualification?.failureSummary).toBe(
      `Qualification failed: isolation self-test failed: ${probes}`,
    );
  });

  test("a recheck clears the facts while it runs and records the new ones", async () => {
    refusal = undefined;
    await qualifySandboxConnection("podman", undefined, "linux");
    expect(getSandboxConnection("podman")?.podman).toEqual(facts);
    const seen: unknown[] = [];
    await qualifySandboxConnection(
      "podman",
      () => {
        seen.push(getSandboxConnection("podman")?.podman);
      },
      "linux",
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeUndefined();
    expect(getSandboxConnection("podman")?.podman).toEqual(facts);
  });

  test("a non-Linux host is refused before the ingress check", async () => {
    calls.length = 0;
    await expect(
      qualifySandboxConnection("podman", undefined, "darwin"),
    ).rejects.toThrow(
      "Qualification failed: This machine (container) needs Linux with rootless Podman",
    );
    expect(calls).toEqual([]);
    expect(sandboxConnectionReady("podman")).toBe(false);
  });
});
