/**
 * A compiled binary runs codemode only when QuickJS's WASM and the codemode
 * worker sit beside it. The release shipped without them, so every codemode
 * script failed with "Cannot find module 'quickjs-wasi/quickjs.wasm'". This
 * compiles the probe the release workflow runs and checks both layouts:
 * without the files the script fails, with shipPiRuntimeFiles it returns 2.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { shipPiRuntimeFiles } from "./lib/pi-runtime-files";

const REPO_ROOT = resolve(import.meta.dir, "..");

let dir = "";
let probe = "";

function runProbe(): { exitCode: number; output: string } {
  // A cwd away from the binary, as for an agent working in its repository.
  const proc = Bun.spawnSync([probe], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "codemode-probe-test-"));
  probe = join(dir, "codemode-probe");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "codemode-probe.ts"),
      "--outfile",
      probe,
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0)
    throw new Error(`probe compile failed\n${build.stderr.toString()}`);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("compiled codemode", () => {
  test("fails when QuickJS's WASM is not beside the binary", () => {
    const { exitCode, output } = runProbe();
    expect(output).toContain("Failed to load QuickJS");
    expect(output).toContain("quickjs.wasm");
    expect(exitCode).toBe(1);
  });

  test("returns 2 once shipPiRuntimeFiles puts the files beside it", async () => {
    await shipPiRuntimeFiles(dir);
    const { exitCode, output } = runProbe();
    expect(output).toContain("codemode-probe: ok (2)");
    expect(exitCode).toBe(0);
  });
});
