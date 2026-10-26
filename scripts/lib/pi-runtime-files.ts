#!/usr/bin/env bun
/**
 * Files pi loads at runtime that `bun build --compile` cannot embed, so the
 * release ships them next to the `opensession` binary. A compiled binary keeps
 * the build machine's paths to package files it reads from disk, and those
 * paths exist on no other host.
 *
 * - WebAssembly modules (RUNTIME_WASM). Every one a dependency loads goes in
 *   that list: build-compile.ts copies each beside the binary and fails when
 *   one is missing, and the release workflow checks every tarball lists them
 *   all (`bun scripts/lib/pi-runtime-files.ts` prints the names).
 * - The codemode worker (CODEMODE_WORKER). Codemode runs scripts in a worker
 *   thread, and a compiled binary does not embed pi's worker entry, so it ships
 *   as a bundled sidecar like the server's own workers.
 *
 * Pi reads Photon's WASM beside `process.execPath` itself (pi's
 * `utils/photon.js`). For QuickJS and the codemode worker,
 * patches/@earendil-works%2Fpi-coding-agent@<version>.patch makes pi's
 * `getQuickJSWasmPath()` and `getCodemodeWorkerSpecifier()` use the same
 * layout in a compiled binary.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

export interface RuntimeWasm {
  /** File name, in its package and beside the binary. */
  file: string;
  /** Package chain from pi to the package that owns the file, so the copy
   *  shipped matches the JS glue compiled into the binary. */
  packages: readonly string[];
  /** What breaks without it. */
  purpose: string;
}

export const PHOTON_WASM = "photon_rs_bg.wasm";
export const QUICKJS_WASM = "quickjs.wasm";

export const RUNTIME_WASM: readonly RuntimeWasm[] = [
  {
    file: PHOTON_WASM,
    packages: ["@earendil-works/pi-coding-agent", "@silvia-odwyer/photon-node"],
    purpose:
      "pi's image resizer; without it every image an agent reads is omitted",
  },
  {
    file: QUICKJS_WASM,
    packages: [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-codemode",
      "quickjs-wasi",
    ],
    purpose: "codemode's QuickJS sandbox; without it every script fails",
  },
];

export const CODEMODE_WORKER = "codemode-worker.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Every file pi needs beside the binary, by name. */
export function piRuntimeFileNames(): string[] {
  return [...RUNTIME_WASM.map((wasm) => wasm.file), CODEMODE_WORKER];
}

/** Directory of the last package in `packages`, each resolved from the one
 *  before it, starting at the repository. */
function packageDir(packages: readonly string[]): string {
  let dir = REPO_ROOT;
  for (const name of packages) {
    dir = dirname(Bun.resolveSync(`${name}/package.json`, dir));
  }
  return dir;
}

/** Path of `wasm` in the package copy pi resolves. */
export function runtimeWasmSource(wasm: RuntimeWasm): string {
  const source = join(packageDir(wasm.packages), wasm.file);
  if (!existsSync(source))
    throw new Error(`${wasm.packages.at(-1)} has no ${wasm.file} at ${source}`);
  return source;
}

/** Copy every RUNTIME_WASM file into `destDir` (beside the executable). */
export function copyRuntimeWasm(destDir: string): string[] {
  mkdirSync(destDir, { recursive: true });
  return RUNTIME_WASM.map((wasm) => {
    const destination = join(destDir, wasm.file);
    copyFileSync(runtimeWasmSource(wasm), destination);
    if (statSync(destination).size === 0)
      throw new Error(`copied an empty ${wasm.file} to ${destination}`);
    return destination;
  });
}

/** Bundle pi's codemode worker entry into `destDir/codemode-worker.js`. */
export async function buildCodemodeWorker(destDir: string): Promise<string> {
  const entry = join(
    packageDir(["@earendil-works/pi-coding-agent"]),
    "dist",
    "extensions",
    "codemode",
    "worker.js",
  );
  const destination = join(destDir, CODEMODE_WORKER);
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      "--target=bun",
      entry,
      "--outfile",
      destination,
    ],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0)
    throw new Error(`${CODEMODE_WORKER} sidecar build failed`);
  if (!existsSync(destination) || statSync(destination).size === 0)
    throw new Error(
      `expected a non-empty ${CODEMODE_WORKER} at ${destination}`,
    );
  return destination;
}

/** Put every file pi needs beside the executable into `destDir`. */
export async function shipPiRuntimeFiles(destDir: string): Promise<string[]> {
  return [...copyRuntimeWasm(destDir), await buildCodemodeWorker(destDir)];
}

if (import.meta.main) {
  for (const name of piRuntimeFileNames()) console.log(name);
}
