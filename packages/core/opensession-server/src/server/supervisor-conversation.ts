/**
 * The owner/Blob exchanges in a supervisor session's transcript: what the
 * owner typed or said, and the reply Blob gave. The seed (supervisor-memory.ts)
 * turns the last few of a retired session into one line each, and the memory
 * writer (supervisor-memory-writer.ts) reads the new ones since its cursor.
 *
 * Only bare user turns count as the owner's words: a teammate's message
 * carries an attribution prefix (prompt-context.ts withPromptAttribution),
 * and wakes, worker reports, scheduled check-backs and injected context are
 * notices or context rows (protocol notices.ts classifyEntry), never the
 * owner speaking.
 */
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { stripContext } from "./prompt-context";
import type { TranscriptEntry } from "./types";

export type SeqTranscriptEntry = TranscriptEntry & { seq: number };

export interface SupervisorExchange {
  /** When the owner's message was sent, ISO 8601. */
  at: string;
  /** The owner's words. */
  owner: string;
  /** Blob's final reply to them; empty while the turn has none yet. */
  blob: string;
  /** seq of the owner's message. */
  startSeq: number;
  /** seq of the last row that belongs to this exchange. */
  endSeq: number;
}

function ownerWords(entry: SeqTranscriptEntry): string | null {
  if (entry.type !== "user" || entry.turnBoundary) return null;
  if (isContextRow(entry)) return null;
  const classified = classifyEntry(entry);
  if (classified.notice || classified.sender) return null;
  const text = stripContext(classified.content || "").trim();
  return text || null;
}

function isContextRow(entry: SeqTranscriptEntry): boolean {
  return !!entry.noticeKind || !!entry.contextInjection;
}

function blobWords(entry: SeqTranscriptEntry): string | null {
  if (entry.type !== "assistant" || entry.isReasoning) return null;
  const text = (entry.content || "").trim();
  return text || null;
}

/**
 * The exchanges in `entries` (ascending seq), in order. Rows before the
 * first owner message (a wake's work, the tail of an earlier exchange) are
 * left out. Several owner messages in a row (sent while a turn ran) join
 * into one exchange.
 */
export function supervisorExchanges(
  entries: readonly SeqTranscriptEntry[],
): SupervisorExchange[] {
  const out: SupervisorExchange[] = [];
  let current: SupervisorExchange | null = null;
  for (const entry of entries) {
    const owner = ownerWords(entry);
    if (owner) {
      if (current && !current.blob) {
        current.owner = `${current.owner}\n${owner}`;
        current.endSeq = entry.seq;
        continue;
      }
      current = {
        at: entry.timestamp,
        owner,
        blob: "",
        startSeq: entry.seq,
        endSeq: entry.seq,
      };
      out.push(current);
      continue;
    }
    if (!current) continue;
    // Someone else's turn (a worker report, a teammate, a wake) ends the
    // exchange: what Blob says next answers them, not the owner.
    if (
      (entry.type === "user" && !isContextRow(entry)) ||
      entry.contextInjection?.source === "background-wait"
    ) {
      current = null;
      continue;
    }
    current.endSeq = entry.seq;
    const blob = blobWords(entry);
    // The last text of the turn is the reply; earlier ones narrate the work.
    if (blob) current.blob = blob;
  }
  return out;
}

/** One line of at most `max` characters, cut at a word when it can be. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What Blob said aloud: the first paragraph of the reply (blob-surface.ts
 *  SAY_SHOW_LINES), or its first line when it has no paragraphs. */
export function spokenPart(reply: string): string {
  const paragraph = reply.trim().split(/\n\s*\n/, 1)[0] ?? "";
  return paragraph.trim();
}
