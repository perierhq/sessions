import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { memory } from "./memory";
import { fail } from "./ui";

describe("opensession memory --json", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    spies.push(
      spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        out.push(args.join(" "));
      }),
      spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        err.push(args.join(" "));
      }),
    );
    return { out, err };
  }

  for (const [label, positional, snapshot] of [
    ["report", [], false],
    ["memory snapshot", ["snapshot"], false],
    ["memory --snapshot", [], true],
  ] as const)
    test(`stdout is one JSON document (${label})`, async () => {
      const { out, err } = capture();
      const code = await memory(
        [...positional],
        { json: true, snapshot },
        async (path) =>
          path.endsWith("/heap-snapshot")
            ? {
                ok: true,
                path: "/state/heap.heapsnapshot",
                bytes: 10,
                durationMs: 1,
              }
            : { pid: 1, collections: [] },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join("\n"));
      expect(parsed).toHaveProperty(
        positional.length || snapshot ? "path" : "collections",
      );
      if (positional.length || snapshot)
        expect(err.join("\n")).toContain("writing a heap snapshot");
    });

  test("failures stay off stdout", async () => {
    const { out, err } = capture();
    const code = await memory(["snapshot"], { json: true }, async () => {
      fail("server returned 403");
      return undefined;
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("server returned 403");
  });
});
