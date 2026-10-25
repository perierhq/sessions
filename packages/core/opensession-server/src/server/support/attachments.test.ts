import { describe, expect, test } from "bun:test";
import { readdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentMeta } from "../../shared/support";
import {
  ATTACHMENTS_DIR,
  deleteAttachmentFile,
  deleteConversationAttachments,
  openAttachment,
  readAttachment,
  removeOrphanAttachmentDirs,
  saveAttachment,
} from "./attachments";
import { useSupportTestKernel } from "./testing/kernel-fixture";

const kernel = useSupportTestKernel();

const CONVERSATION = "sc_0192e8a0-0000-7000-8000-000000000001";
const NOW = Date.parse("2026-10-25T10:00:00.000Z");
const DAY = 86_400_000;
const RETENTION = { conversationDays: 180, attachmentDays: 30 };
const BYTES = new TextEncoder().encode("invoice for acme");

function meta(id: string): AttachmentMeta {
  return {
    id,
    fileName: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 0,
    stored: false,
    expiresAt: null,
  };
}

describe("attachments", () => {
  test("lives under the state dir", () => {
    expect(ATTACHMENTS_DIR().startsWith(kernel.root())).toBe(true);
  });

  test("save then read returns the same bytes", async () => {
    const saved = await saveAttachment(
      CONVERSATION,
      meta("att_1"),
      BYTES,
      RETENTION,
      NOW,
    );
    expect(saved).toEqual({
      ...meta("att_1"),
      sizeBytes: BYTES.byteLength,
      stored: true,
      expiresAt: new Date(NOW + 30 * DAY).toISOString(),
    });
    expect(await readAttachment(CONVERSATION, "att_1")).toEqual(BYTES);
    expect(await readAttachment(CONVERSATION, "att_2")).toBeNull();
  });

  test("reading streams from disk instead of buffering the file", async () => {
    await saveAttachment(CONVERSATION, meta("att_1"), BYTES, RETENTION, NOW);
    const file = await openAttachment(CONVERSATION, "att_1");
    expect(file!.size).toBe(BYTES.byteLength);
    expect(file!.stream()).toBeInstanceOf(ReadableStream);
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(BYTES);
    expect(await openAttachment(CONVERSATION, "att_2")).toBeNull();
  });

  test("the file is readable by the owner only", async () => {
    await saveAttachment(CONVERSATION, meta("att_1"), BYTES, RETENTION, NOW);
    const info = await stat(join(ATTACHMENTS_DIR(), CONVERSATION, "att_1"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("expiresAt follows the inbox's attachment days", async () => {
    const saved = await saveAttachment(
      CONVERSATION,
      meta("att_1"),
      BYTES,
      { conversationDays: 180, attachmentDays: 7 },
      NOW,
    );
    expect(saved.expiresAt).toBe(new Date(NOW + 7 * DAY).toISOString());
  });

  test("deleting one file leaves the others", async () => {
    await saveAttachment(CONVERSATION, meta("att_1"), BYTES, RETENTION, NOW);
    await saveAttachment(CONVERSATION, meta("att_2"), BYTES, RETENTION, NOW);
    await deleteAttachmentFile(CONVERSATION, "att_1");
    await deleteAttachmentFile(CONVERSATION, "att_1");
    expect(await readAttachment(CONVERSATION, "att_1")).toBeNull();
    expect(await readAttachment(CONVERSATION, "att_2")).toEqual(BYTES);
  });

  test("deleteConversationAttachments counts the files and removes the directory", async () => {
    await saveAttachment(CONVERSATION, meta("att_1"), BYTES, RETENTION, NOW);
    await saveAttachment(CONVERSATION, meta("att_2"), BYTES, RETENTION, NOW);
    expect(await deleteConversationAttachments(CONVERSATION)).toBe(2);
    expect(await readdir(ATTACHMENTS_DIR())).toEqual([]);
    expect(await deleteConversationAttachments(CONVERSATION)).toBe(0);
  });

  test("a path-traversal id throws before touching the disk", async () => {
    await expect(
      saveAttachment(CONVERSATION, meta("../x"), BYTES, RETENTION, NOW),
    ).rejects.toThrow();
    await expect(
      saveAttachment("../x", meta("att_1"), BYTES, RETENTION, NOW),
    ).rejects.toThrow();
    await expect(readAttachment(CONVERSATION, "../x")).rejects.toThrow();
    await expect(deleteAttachmentFile("..", "att_1")).rejects.toThrow();
    await expect(deleteConversationAttachments("../..")).rejects.toThrow();
    // Ids are lowercase: on a case-insensitive disk an uppercase twin would
    // name the same directory.
    await expect(
      saveAttachment(
        CONVERSATION.toUpperCase().replace("SC_", "sc_"),
        meta("att_1"),
        BYTES,
        RETENTION,
        NOW,
      ),
    ).rejects.toThrow();
    await expect(stat(ATTACHMENTS_DIR())).rejects.toThrow();
  });

  test("orphan directories older than an hour go; known and fresh ones stay", async () => {
    const known = CONVERSATION;
    const oldOrphan = "sc_0192e8a0-0000-7000-8000-000000000002";
    const freshOrphan = "sc_0192e8a0-0000-7000-8000-000000000003";
    for (const id of [known, oldOrphan, freshOrphan])
      await saveAttachment(id, meta("att_1"), BYTES, RETENTION, NOW);
    const age = async (id: string, ms: number) => {
      const at = new Date(NOW - ms);
      await utimes(join(ATTACHMENTS_DIR(), id), at, at);
    };
    await age(known, 2 * DAY);
    await age(oldOrphan, 2 * 3_600_000);
    await age(freshOrphan, 10 * 60_000);
    const asked: string[][] = [];

    const removed = await removeOrphanAttachmentDirs(NOW, async (ids) => {
      asked.push([...ids].sort());
      return new Set(ids.filter((id) => id === known));
    });

    expect(removed).toBe(1);
    expect(asked).toEqual([[known, oldOrphan, freshOrphan].sort()]);
    expect((await readdir(ATTACHMENTS_DIR())).sort()).toEqual(
      [known, freshOrphan].sort(),
    );
  });

  test("orphan cleanup with no attachments directory does nothing", async () => {
    expect(await removeOrphanAttachmentDirs(NOW, async () => new Set())).toBe(
      0,
    );
    await expect(stat(ATTACHMENTS_DIR())).rejects.toThrow();
  });
});
