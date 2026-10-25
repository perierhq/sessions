/**
 * Pi resizes every image an agent reads (the `read` tool, attachments) with
 * Photon, a WASM module from `@silvia-odwyer/photon-node`. Photon's loader reads
 * `photon_rs_bg.wasm` from its own package directory with `fs.readFileSync`, a
 * read `bun build --compile` cannot embed: in the release binary that path
 * points at the build machine's checkout. Pi then looks for the file beside
 * `process.execPath` (see pi's `utils/photon.js`), and without it every image
 * is replaced by "[Image omitted: could not be resized below the inline image
 * size limit.]".
 *
 * So the release ships the file next to the `opensession` binary, the layout
 * pi documents for its own compiled builds ("Copy photon_rs_bg.wasm next to
 * the executable in build:binary").
 */

import { copyFileSync, existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

export const PHOTON_WASM = "photon_rs_bg.wasm";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * The `photon_rs_bg.wasm` of the photon-node copy pi itself resolves, so the
 * shipped module always matches the JS glue compiled into the binary.
 */
export function photonWasmSource(): string {
  const pi = Bun.resolveSync(
    "@earendil-works/pi-coding-agent/package.json",
    REPO_ROOT,
  );
  const photon = Bun.resolveSync(
    "@silvia-odwyer/photon-node/package.json",
    dirname(pi),
  );
  const wasm = join(dirname(photon), PHOTON_WASM);
  if (!existsSync(wasm))
    throw new Error(`photon-node has no ${PHOTON_WASM} at ${wasm}`);
  return wasm;
}

/** Copy pi's `photon_rs_bg.wasm` into `destDir` (beside the executable). */
export function copyPhotonWasm(destDir: string): string {
  const destination = join(destDir, PHOTON_WASM);
  copyFileSync(photonWasmSource(), destination);
  if (statSync(destination).size === 0)
    throw new Error(`copied an empty ${PHOTON_WASM} to ${destination}`);
  return destination;
}
