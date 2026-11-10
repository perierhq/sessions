/**
 * The supervisor's ledger: one markdown file per person that outlives the
 * supervisor's conversations. A supervisor session is rotated after about a
 * week (supervisor.ts), and pi's compaction summarises summaries in between,
 * so what the owner decided, what they prefer and which threads are still
 * open goes here instead, the way a goal keeps its fact ledger (goals.ts
 * appendLedger/readLedger).
 *
 * The file sits next to the `supervisors` catalog mirror, at
 * `<state dir>/.opensession-supervisors/<key>.ledger.md`, keyed like the
 * supervisor map (canonicalName of the person). It is created on the first
 * append. Every read and write is async and bounded: the supervisor reads
 * its tail with opensession-supervisor read_ledger, and a new supervisor
 * session's first turn carries the tail as seed context.
 */
import { appendFile, mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { legacyCatalogDirectory } from "./catalog-documents";
import { canonicalName } from "./shared/user-store-key";

/** Longest single entry append_ledger takes, in characters. */
export const LEDGER_ENTRY_MAX = 1_000;
/** Most of the ledger read_ledger returns, from the end, in bytes. */
export const LEDGER_READ_BYTES = 16_000;
/** Most of the ledger a new session's seed carries, in bytes. */
export const LEDGER_SEED_BYTES = 6_000;

const SUPERVISORS_DIRECTORY = "supervisors";
const ENTRY_HEADING = "\n## ";

/** Where a person's ledger lives. */
export async function supervisorLedgerPath(user: string): Promise<string> {
  return join(
    await legacyCatalogDirectory(SUPERVISORS_DIRECTORY),
    `${canonicalName(user)}.ledger.md`,
  );
}

function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export type AppendLedgerResult =
  | { ok: true; entry: string }
  | { ok: false; error: "empty" | "too-long" };

/**
 * Append one dated entry to the person's ledger, creating it on first use.
 * Refuses an empty entry and one over LEDGER_ENTRY_MAX characters rather
 * than cutting it, so nothing half-written lands.
 */
export async function appendSupervisorLedger(
  user: string,
  text: string,
  now: number = Date.now(),
): Promise<AppendLedgerResult> {
  const body = text.trim();
  if (!body) return { ok: false, error: "empty" };
  if (body.length > LEDGER_ENTRY_MAX) return { ok: false, error: "too-long" };
  const path = await supervisorLedgerPath(user);
  await mkdir(dirname(path), { recursive: true });
  try {
    // Exclusive create: two first appends at once write one heading.
    await writeFile(
      path,
      `# Supervisor ledger: ${user.trim().replace(/\s+/g, " ")}\n\nDecisions the owner made, standing preferences and open threads, newest last. Superseded facts are marked, not deleted.\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  const entry = `${ENTRY_HEADING}${stamp(now)}\n\n${body}\n`;
  await appendFile(path, entry);
  return { ok: true, entry: entry.trim() };
}

export interface LedgerTail {
  text: string;
  /** Older entries were left out to stay within the bound. */
  truncated: boolean;
}

/**
 * The last `maxBytes` of the person's ledger, starting at an entry heading
 * so no entry is cut in half. Empty when there is no ledger yet. Reads only
 * the tail, however long the file grows.
 */
export async function readSupervisorLedgerTail(
  user: string,
  maxBytes: number = LEDGER_READ_BYTES,
): Promise<LedgerTail> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(await supervisorLedgerPath(user), "r");
  } catch (error) {
    if (isCode(error, "ENOENT")) return { text: "", truncated: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const raw = buffer.toString("utf8");
    if (length === size) return { text: raw.trim(), truncated: false };
    // Cut to the first whole entry: the bytes before it may be the end of
    // an older entry, or half a character.
    const at = raw.indexOf(ENTRY_HEADING);
    return {
      text: at === -1 ? "" : raw.slice(at).trim(),
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}
