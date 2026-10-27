import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPortalAgentSource } from "./sandbox-portal-agent-source";

describe("sandbox Portal relay sidecar source", () => {
  // A release is a compiled binary with no repository tree beside it, so the
  // sidecar's source travels inside the bundle rather than being read from
  // disk.
  test("is the sidecar script, inlined at build time", () => {
    expect(sandboxPortalAgentSource()).toBe(
      readFileSync(
        join(import.meta.dir, "../../runner-host/sandbox-portal-agent.ts"),
        "utf8",
      ),
    );
  });
});
