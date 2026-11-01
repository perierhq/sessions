/**
 * A small, bounded zip reader for skill uploads (`.zip` and Claude's `.skill`
 * archives, which are zips). Stored and deflated entries only; no zip64, no
 * encryption. Symlinks and directories are skipped. Every size is checked
 * against the caller's limits before anything is inflated, and inflation
 * itself is capped, so a zip bomb fails instead of filling memory.
 *
 * Inflation is async (node:zlib's thread pool), so this is safe to call from
 * the gateway.
 */

import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";

const inflateRawAsync = promisify(inflateRaw) as (
  buf: Uint8Array,
  opts: { maxOutputLength: number },
) => Promise<Buffer>;

export class ZipError extends Error {}

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** True when the bytes start like a zip archive (a local file header, or the
 *  end record of an empty archive). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sig = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  return sig === LOCAL_SIG || sig === EOCD_SIG;
}

export async function readZip(
  bytes: Uint8Array,
  limits: ZipLimits,
): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  // The end-of-central-directory record sits in the last 22 + 65535 bytes.
  let eocd = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 22 - 0xffff);
    at--
  ) {
    if (u32(at) === EOCD_SIG) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("This is not a zip archive.");
  const count = u16(eocd + 10);
  const cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new ZipError("Zip64 archives are not supported.");
  if (count > limits.maxEntries)
    throw new ZipError(`The archive has more than ${limits.maxEntries} files.`);

  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  let total = 0;
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(at) !== CENTRAL_SIG)
      throw new ZipError("The archive is damaged.");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const compressed = u32(at + 20);
    const size = u32(at + 24);
    const nameLen = u16(at + 28);
    const extraLen = u16(at + 30);
    const commentLen = u16(at + 32);
    const mode = u32(at + 38) >>> 16;
    const localOffset = u32(at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if ((mode & S_IFMT) === S_IFLNK) continue;
    if (flags & 1) throw new ZipError("Encrypted archives are not supported.");
    if (compressed === 0xffffffff || size === 0xffffffff)
      throw new ZipError("Zip64 archives are not supported.");
    if (size > limits.maxEntryBytes)
      throw new ZipError(`${name} is larger than the per-file limit.`);
    total += size;
    if (total > limits.maxTotalBytes)
      throw new ZipError("The archive unpacks to more than the upload limit.");

    if (localOffset + 30 > bytes.length || u32(localOffset) !== LOCAL_SIG)
      throw new ZipError("The archive is damaged.");
    const dataStart =
      localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + compressed);
    if (data.length !== compressed)
      throw new ZipError("The archive is damaged.");

    let content: Uint8Array;
    if (method === 0) content = data;
    else if (method === 8) {
      try {
        content = await inflateRawAsync(data, {
          maxOutputLength: Math.max(1, size),
        });
      } catch {
        throw new ZipError(`${name} could not be unpacked.`);
      }
    } else throw new ZipError(`${name} uses an unsupported compression.`);
    if (content.length !== size) throw new ZipError("The archive is damaged.");
    out.push({ path: name, bytes: content });
  }
  return out;
}
