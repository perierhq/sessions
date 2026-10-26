// Attachment bytes on disk, one directory per conversation under the state
// dir, owner-readable only. The conversation document holds the metadata;
// retention deletes the file and keeps the name and size. Async filesystem
// calls only (gateway invariant); ids are checked before any path is built.
import { randomUUIDv7 } from "bun";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentMeta, InboxRetention } from "../../shared/support";
import { stateDir } from "../paths";

const DAY_MS = 86_400_000;
/** An attachment directory with no conversation is left this long first:
 *  ingest saves the files before it records them on the conversation. */
const ORPHAN_MIN_AGE_MS = 3_600_000;
// Lowercase only: on a case-insensitive disk two ids differing in case
// would name one directory.
const CONVERSATION_ID = /^sc_[0-9a-f-]{1,253}$/;

export const ATTACHMENTS_DIR = (): string => stateDir("support/attachments");

function conversationDir(conversationId: string): string {
  if (!CONVERSATION_ID.test(conversationId))
    throw new Error("Invalid support conversation id");
  return join(ATTACHMENTS_DIR(), conversationId);
}

function attachmentPath(conversationId: string, attachmentId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId))
    throw new Error("Invalid support attachment id");
  return join(conversationDir(conversationId), attachmentId);
}

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Writes the bytes (mode 0600, through a temporary file) and returns the
 *  meta marked stored, with its size and the inbox's attachment expiry. */
export async function saveAttachment(
  conversationId: string,
  meta: AttachmentMeta,
  content: Uint8Array,
  retention: InboxRetention,
  now: number,
): Promise<AttachmentMeta> {
  const path = attachmentPath(conversationId, meta.id);
  await mkdir(conversationDir(conversationId), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${path}.${randomUUIDv7()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    ...meta,
    sizeBytes: content.byteLength,
    stored: true,
    expiresAt: new Date(now + retention.attachmentDays * DAY_MS).toISOString(),
  };
}

/** The file, read lazily: stream it or hand it to a Response (the
 *  download route), never buffered here. null when it is not there
 *  (expired, forgotten, never stored). */
export async function openAttachment(
  conversationId: string,
  attachmentId: string,
): Promise<Blob | null> {
  const path = attachmentPath(conversationId, attachmentId);
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return Bun.file(path);
}

/** The whole file in memory, for small reads; serve downloads through
 *  `openAttachment`. null when it is not there. */
export async function readAttachment(
  conversationId: string,
  attachmentId: string,
): Promise<Uint8Array | null> {
  const file = await openAttachment(conversationId, attachmentId);
  if (!file) return null;
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    // Deleted between the check and the read.
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Idempotent: a file already gone is fine. */
export async function deleteAttachmentFile(
  conversationId: string,
  attachmentId: string,
): Promise<void> {
  try {
    await unlink(attachmentPath(conversationId, attachmentId));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Removes the conversation's directory; resolves to the number of
 *  attachment files it held (temporary files not counted). */
export async function deleteConversationAttachments(
  conversationId: string,
): Promise<number> {
  const dir = conversationDir(conversationId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  await rm(dir, { recursive: true, force: true });
  return names.filter((name) => !name.endsWith(".tmp")).length;
}

/** Removes attachment directories whose conversation no longer exists and
 *  that are older than an hour (a crash between saving a file and recording
 *  it, or a save racing a delete). `existing` answers which of the ids
 *  still have a conversation. Resolves to the number of directories
 *  removed. */
export async function removeOrphanAttachmentDirs(
  now: number,
  existing: (ids: string[]) => Promise<Set<string>>,
): Promise<number> {
  const root = ATTACHMENTS_DIR();
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const ids = names.filter((name) => CONVERSATION_ID.test(name));
  if (!ids.length) return 0;
  const known = await existing(ids);
  let removed = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    const dir = join(root, id);
    try {
      if ((await stat(dir)).mtimeMs > now - ORPHAN_MIN_AGE_MS) continue;
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
