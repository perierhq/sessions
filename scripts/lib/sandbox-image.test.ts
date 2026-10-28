import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  reportSandboxImageAfterRestart,
  sandboxImageLine,
} from "./sandbox-image";

const TAG = "localhost/opensession-sandbox:0123456789abcdef";

describe("sandbox image line", () => {
  test("says where the image for this release stands", () => {
    expect(sandboxImageLine({ tag: TAG, state: "current" })).toMatchObject({
      level: "ok",
      detail: TAG,
    });
    expect(sandboxImageLine({ tag: TAG, state: "building" })).toMatchObject({
      level: "info",
      message: expect.stringContaining(`building ${TAG}`),
      detail: expect.stringContaining("Workspace → Sandboxes"),
    });
    expect(
      sandboxImageLine({ tag: TAG, state: "failed", error: "exit 125" }),
    ).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("exit 125"),
    });
  });

  test("says nothing without a container connection's report", () => {
    expect(sandboxImageLine(undefined)).toBeUndefined();
    expect(sandboxImageLine(null)).toBeUndefined();
    expect(sandboxImageLine({ state: "current" })).toBeUndefined();
    expect(sandboxImageLine({ tag: TAG, state: "other" })).toBeUndefined();
  });
});

describe("after an update's restart", () => {
  let lines: string[] = [];
  let log: ReturnType<typeof spyOn>;
  beforeEach(() => {
    lines = [];
    log = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });
  afterEach(() => log.mockRestore());

  test("waits for the new server's first check and reports it", async () => {
    let asked = 0;
    await reportSandboxImageAfterRestart("http://127.0.0.1:3850", {
      qualified: async () => true,
      fetchHealth: async () =>
        ++asked < 3
          ? { ok: true }
          : { sandboxImage: { tag: TAG, state: "building" } },
      sleep: async () => {},
    });
    expect(asked).toBe(3);
    expect(lines.join("\n")).toContain(`building ${TAG}`);
  });

  test("asks nothing when no container connection is qualified", async () => {
    let asked = 0;
    await reportSandboxImageAfterRestart("http://127.0.0.1:3850", {
      qualified: async () => false,
      fetchHealth: async () => {
        asked++;
        return {};
      },
    });
    expect(asked).toBe(0);
    expect(lines).toEqual([]);
  });

  test("gives up quietly when the server never reports", async () => {
    await reportSandboxImageAfterRestart("http://127.0.0.1:3850", {
      qualified: async () => true,
      fetchHealth: async () => {
        throw new Error("connection refused");
      },
      sleep: async () => {},
      waitMs: 0,
    });
    expect(lines).toEqual([]);
  });
});
