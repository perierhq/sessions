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
    connectSandboxProvider("podman", { settings: {} });
    await qualifySandboxConnection("podman");
    expect(calls).toEqual(["ingress", "podman"]);
    expect(getSandboxConnection("podman")?.podman).toEqual(facts);
    expect(sandboxConnectionReady("podman")).toBe(true);
  });

  test("a refusal is shown as is and leaves the connection not ready", async () => {
    refusal = new Error(
      "callback base URL resolves to a private or host address (100.101.1.2)",
    );
    await expect(qualifySandboxConnection("podman")).rejects.toThrow(
      "Qualification failed: callback base URL resolves to a private or host address (100.101.1.2)",
    );
    expect(sandboxConnectionReady("podman")).toBe(false);
  });
});
