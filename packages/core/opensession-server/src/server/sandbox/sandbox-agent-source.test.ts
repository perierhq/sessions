import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxAgentSource } from "./sandbox-agent-source";

describe("sandbox agent source", () => {
  // A release is a compiled binary with no repository tree beside it, so the
  // agent's source travels inside the bundle rather than being read from disk.
  test("is the agent script, inlined at build time", async () => {
    expect(await sandboxAgentSource()).toBe(
      readFileSync(
        join(import.meta.dir, "../../runner-host/sandbox-agent.ts"),
        "utf8",
      ),
    );
  });
});
