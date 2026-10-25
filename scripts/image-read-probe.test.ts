/**
 * A compiled binary reads images only when Photon's WASM sits beside it. The
 * release shipped without the file, so pi replaced every image an agent read
 * with "[Image omitted: could not be resized below the inline image size
 * limit.]". This compiles the probe the release workflow runs and checks both
 * layouts: without the file the image is omitted, with copyPhotonWasm it is
 * read.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { copyPhotonWasm } from "./lib/photon-wasm";

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
  dir = mkdtempSync(join(tmpdir(), "image-read-probe-test-"));
  probe = join(dir, "image-read-probe");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "image-read-probe.ts"),
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

describe("compiled image read", () => {
  test("omits the image when Photon's WASM is not beside the binary", () => {
    const { exitCode, output } = runProbe();
    expect(output).toContain(
      "[Image omitted: could not be resized below the inline image size limit.]",
    );
    expect(exitCode).toBe(1);
  });

  test("reads the image once copyPhotonWasm puts the WASM beside it", () => {
    copyPhotonWasm(dir);
    const { exitCode, output } = runProbe();
    expect(output).toContain("image-read-probe: ok (image/png)");
    expect(exitCode).toBe(0);
  });
});
