import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { statePath } from "./paths";
import {
  orphanedRunnerPortalRecords,
  runnerPortalCount,
  type RunnerPortalRecord,
} from "./runner-portals";
import { writeJsonAtomic } from "./shared/atomic-write";

const portal = (sessionId: string): RunnerPortalRecord => ({
  name: "webapp",
  key: "PORTAL_WEBAPP_PORT",
  command: "bun run dev",
  port: 4300,
  state: "awake",
  runnerId: "runner-1",
  sessionId,
  repo: "app",
  workspacePath: `/worktrees/${sessionId}`,
  user: "portal-owner",
});

describe("Runner Portal ownership", () => {
  test("only selects records whose session is gone", () => {
    expect(
      orphanedRunnerPortalRecords(
        [portal("live"), portal("deleted")],
        new Set(["live"]),
      ),
    ).toEqual([portal("deleted")]);
  });
});

test("counts a Runner's Portals that are not stopped", () => {
  const previous = process.env.OPENSESSION_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "os-runner-portals-test-"));
  process.env.OPENSESSION_STATE_DIR = dir;
  try {
    countPortals();
  } finally {
    if (previous === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

function countPortals() {
  writeJsonAtomic(statePath(".opensession-runner-portals.json"), {
    portals: [
      portal("a"),
      { ...portal("b"), state: "stopped" },
      { ...portal("c"), runnerId: "runner-2" },
    ],
  });
  expect(runnerPortalCount("runner-1")).toBe(1);
  expect(runnerPortalCount("runner-2")).toBe(1);
  expect(runnerPortalCount("runner-3")).toBe(0);
}
