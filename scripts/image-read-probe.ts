#!/usr/bin/env bun
/**
 * Reads a small PNG through pi's `read` tool and exits 0 only if the result
 * carries the image. Pi resizes every image it reads (processImage → Photon),
 * so this goes red whenever the resizer cannot load.
 *
 * It exists to be compiled: `bun build --compile` reproduces the release
 * binary's layout, where Photon's WASM has to sit beside the executable (see
 * scripts/lib/photon-wasm.ts). The release workflow runs it beside the staged
 * Linux artefact's copy, and image-read-probe.test.ts runs it with and without
 * the file.
 *
 * A compiled binary still carries the build machine's path to Photon's WASM,
 * and on the build machine that path exists, so a check there would pass even
 * when the artefact lacks the file. The probe therefore refuses every read of
 * the WASM from outside the executable's own directory, as on any other host.
 */

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { PHOTON_WASM } from "./lib/photon-wasm";

// Photon reads the WASM through the CommonJS `fs` object; pi wraps the same
// object's readFileSync with its beside-the-executable fallback.
const fs = createRequire(import.meta.url)("fs") as typeof import("fs");
const readFileSync = fs.readFileSync.bind(fs);
const execDir = dirname(process.execPath);
fs.readFileSync = ((file: Parameters<typeof readFileSync>[0], ...rest) => {
  const path =
    typeof file === "string"
      ? file
      : file instanceof URL
        ? fileURLToPath(file)
        : null;
  if (path?.endsWith(PHOTON_WASM) && dirname(resolve(path)) !== execDir) {
    throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
      code: "ENOENT",
    });
  }
  return readFileSync(file, ...(rest as [never]));
}) as typeof fs.readFileSync;

// A valid 1x1 PNG: small enough that pi passes it through untouched once
// Photon has decoded it.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const dir = mkdtempSync(join(tmpdir(), "image-read-probe-"));
try {
  writeFileSync(join(dir, "probe.png"), PNG_1X1);
  const read = createReadToolDefinition(dir);
  const result = await read.execute(
    "image-read-probe",
    { path: "probe.png" },
    undefined,
    undefined,
    undefined as never,
  );
  const image = result.content.find((block) => block.type === "image");
  if (!image) {
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    console.error(`image-read-probe: no image in the read result\n${text}`);
    process.exitCode = 1;
  } else {
    console.log(`image-read-probe: ok (${image.mimeType})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
