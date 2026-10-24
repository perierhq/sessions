import { describe, expect, test } from "bun:test";
import {
  readySandboxProviders,
  sandboxProviderLabel,
  sandboxProviderNote,
} from "./ready-sandbox-providers";

describe("readySandboxProviders", () => {
  test("prefers Ready connections and ignores the rest", () => {
    expect(
      readySandboxProviders({
        connections: [
          { provider: "daytona", state: "ready" },
          { provider: "box", state: "needs_repair" },
        ],
        providers: [{ id: "box", configured: true, certified: true }],
      }),
    ).toEqual(["daytona"]);
  });

  test("falls back to configured, certified providers without connections", () => {
    expect(
      readySandboxProviders({
        connections: [],
        providers: [
          { id: "daytona", configured: true, certified: false },
          { id: "box", configured: true, certified: true },
        ],
      }),
    ).toEqual(["box"]);
  });

  test("a Ready connection the server has not certified is not offered", () => {
    const status = (certified: boolean) => ({
      connections: [
        { provider: "daytona", state: "ready" },
        { provider: "podman", state: "ready" },
      ],
      providers: [
        { id: "daytona", configured: true, certified: true },
        { id: "podman", configured: true, certified },
      ],
    });
    expect(readySandboxProviders(status(false))).toEqual(["daytona"]);
    expect(readySandboxProviders(status(true))).toEqual(["daytona", "podman"]);
    expect(
      readySandboxProviders({
        connections: [{ provider: "podman", state: "needs_attention" }],
        providers: [{ id: "podman", configured: true, certified: true }],
      }),
    ).toEqual([]);
  });

  test("no status means no providers", () => {
    expect(readySandboxProviders(null)).toEqual([]);
  });
});

describe("sandboxProviderLabel", () => {
  test("names the known providers and passes unknown ids through", () => {
    expect(sandboxProviderLabel("box")).toBe("Boat");
    expect(sandboxProviderLabel("daytona")).toBe("Daytona");
    expect(sandboxProviderLabel("podman")).toBe("This machine (container)");
    expect(sandboxProviderLabel("orb")).toBe("orb");
  });
});

describe("sandboxProviderNote", () => {
  test("says whether the machine is this server, a Mac, or Linux", () => {
    expect(sandboxProviderNote("")).toBe("A worktree on this server.");
    expect(sandboxProviderNote("usecomputer")).toStartWith("Attached Mac");
    expect(sandboxProviderNote("box")).toStartWith("Attached Linux");
    expect(sandboxProviderNote("podman")).toStartWith(
      "A Linux container on this server",
    );
  });
});
