// Attachment bytes on disk, one directory per conversation under the state
// dir, owner-readable only. The conversation document holds the metadata;
// retention deletes the file and keeps the name and size. Async filesystem
// calls only (gateway invariant); ids are checked before any path is built.
import { randomUUIDv7 } from "bun";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentMeta, InboxRetention } from "../../shared/support";
import { stateDir } from "../paths";

const DAY_MS = 86_400_000;

export const ATTACHMENTS_DIR = (): string => stateDir("support/attachments");

function conversationDir(conversationId: string): string {
  if (!/^sc_[0-9a-f-]{1,253}$/i.test(conversationId))
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

/** null when the file is not there (expired, forgotten, never stored). */
export async function readAttachment(
  conversationId: string,
  attachmentId: string,
): Promise<Uint8Array | null> {
  const path = attachmentPath(conversationId, attachmentId);
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
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
