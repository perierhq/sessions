/**
 * The live bubble's text, and the bookkeeping that keeps one block of a reply
 * from showing twice.
 *
 * A turn's assistant text reaches a viewer along two routes: as stream frames
 * while the model writes it, and as a durable transcript entry once the block
 * finishes. Whichever arrives second has to cancel the first, or the same
 * paragraph renders twice — once above the tool steps as a landed entry, once
 * at the bottom in the still-live bubble. Every surface that shows a running
 * turn owns that problem (the server's reconnect feed, the web viewer, the
 * native app), so the rule lives here once instead of being re-derived per
 * client.
 *
 * Blocks carry the engine's own id when it names them (`blockId` on
 * stream_text; the durable entry for that block uses the SAME id). That makes
 * cancelling exact — no amount of normalizing, clamping or half-delivering
 * the text can turn a match into a miss. Engines that name nothing fall back
 * to string subtraction, which is what shipped before ids existed: take the
 * landed block out of the buffer, or — when only its head has streamed —
 * clear the buffer and swallow the remainder as it arrives.
 *
 * The fallback is why `land` is not simply "drop by id": a block can reach a
 * viewer with no id at all (a feed snapshot replays the whole active bubble
 * as one anonymous run of text), and that copy still has to be cancellable.
 */

import type { StreamTextKind } from "./events";

interface LiveTextBlock {
  id?: string;
  text: string;
  kind?: StreamTextKind;
}

/** One live block as a reconnect snapshot carries it. */
export interface LiveTextBlockSnapshot {
  id?: string;
  text: string;
  /** "reasoning" or "text"; absent when the engine did not say. */
  kind?: StreamTextKind;
}

/** How many outstanding landed remainders to remember (a turn's worth). */
const MAX_OUTSTANDING = 30;

export class LiveTextBuffer {
  private blocks: LiveTextBlock[] = [];
  /**
   * Text that landed durably but has not finished streaming: the tail of a
   * block whose entry beat its own last frames. `append` swallows these
   * instead of showing them under the entry that already says them.
   */
  private outstanding: string[] = [];
  /** Blocks already landed durably, by engine id. Frames for these are late
   *  copies of something the transcript already carries. */
  private landedIds = new Set<string>();

  /** Everything the bubble should show right now. */
  get text(): string {
    let out = "";
    for (const block of this.blocks) out += block.text;
    return out;
  }

  get isEmpty(): boolean {
    return !this.text;
  }

  /** The same text per block, with ids and kinds, in arrival order. */
  get blockSnapshots(): LiveTextBlockSnapshot[] {
    return this.blocks
      .filter((block) => block.text)
      .map((block) => ({
        ...(block.id ? { id: block.id } : {}),
        text: block.text,
        ...(block.kind ? { kind: block.kind } : {}),
      }));
  }

  /** A new turn: nothing is outstanding and nothing has landed yet. */
  reset(): void {
    this.blocks = [];
    this.outstanding = [];
    this.landedIds.clear();
  }

  /**
   * Take one stream frame. Returns false when the frame was swallowed as
   * something the transcript already carries, so a caller can skip the work
   * of repainting. `kind` is the frame's kind ("reasoning" or "text"), kept
   * per block for snapshots.
   */
  append(text: string, blockId?: string, kind?: StreamTextKind): boolean {
    if (!text) return false;
    if (blockId) {
      if (this.landedIds.has(blockId)) return false;
    } else {
      // No id to match on: the front of what is still outstanding is this
      // frame's text if the entry landed while the block was still arriving.
      for (let i = 0; i < this.outstanding.length; i++) {
        const rest = this.outstanding[i];
        if (!rest.startsWith(text)) continue;
        const remainder = rest.slice(text.length);
        if (remainder) this.outstanding[i] = remainder;
        else this.outstanding.splice(i, 1);
        return false;
      }
    }
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.id === blockId && last.kind === kind) last.text += text;
    else this.blocks.push({ id: blockId, text, ...(kind ? { kind } : {}) });
    return true;
  }

  /**
   * A block landed durably. `entryId` is the transcript entry's id, which for
   * an engine that names its blocks is the same id its frames carried.
   */
  land(content: string, entryId?: string): void {
    if (entryId) {
      this.landedIds.add(entryId);
      const at = this.blocks.findIndex((block) => block.id === entryId);
      if (at !== -1) {
        this.blocks.splice(at, 1);
        return;
      }
      // Fall through: this copy of the block arrived without an id (an
      // engine that names nothing, or a feed snapshot replayed as one run).
    }
    if (!content) return;
    const before = this.text;
    const after = before.replace(content, "");
    if (after !== before) {
      this.collapse(after);
      return;
    }
    if (before && content.startsWith(before)) {
      // The entry landed while the block's tail was still streaming: clear
      // what is on screen and swallow the rest as it arrives.
      this.pushOutstanding(content.slice(before.length));
      this.blocks = [];
      return;
    }
    this.pushOutstanding(content);
  }

  private pushOutstanding(text: string): void {
    if (!text) return;
    this.outstanding.push(text);
    if (this.outstanding.length > MAX_OUTSTANDING) {
      this.outstanding = this.outstanding.slice(-MAX_OUTSTANDING);
    }
  }

  /**
   * The string fallback rewrote the buffer, so the per-block boundaries no
   * longer describe it. Keep the text and give up the ids for what is left;
   * ids for blocks that have not arrived yet still work.
   */
  private collapse(text: string): void {
    this.blocks = text ? [{ text }] : [];
  }
}
