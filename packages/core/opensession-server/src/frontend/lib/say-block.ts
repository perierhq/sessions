/**
 * The spoken script: a ```say fence opens a reply written for the Blob app
 * (server/blob-surface.ts) and holds what Blob says aloud. Everything after
 * it is what Blob shows. Here, in a transcript, the script is a small muted
 * "Said aloud" line, so the reply reads as what was shown with a note of what
 * was said.
 *
 * The script may open with a delivery hint in square brackets (`[warm,
 * unhurried]`), a direction for the voice, and may carry cue markers
 * (`{#id}`) where the speech turns to the shown element with the same
 * id. Neither is read as words, so both are dropped from the line.
 *
 * Cue anchors in the shown part (`[PR #12](url){#pr-12}`, a line ending in
 * `{#id}`, ```metrics {#stats}) are for the app's speech sync only; the web
 * drops them before parsing (`stripCueAnchors`, called by lib/markdown.ts).
 */

import type { FenceUpgrader } from "./fence-upgraders";

export const SAY_BLOCK_CLASS = "md-say";

/** A cue id: letters, digits, `_` and `-`, starting with a letter or digit. */
const CUE = String.raw`\{#[A-Za-z0-9][A-Za-z0-9_-]{0,63}\}`;
const CUE_ANYWHERE = new RegExp(`\\s*${CUE}`, "g");
/** A leading delivery hint: one bracketed run with no link after it. */
const DELIVERY = /^\s*\[([^\]\n]{1,80})\](?!\()\s*/;

export interface SayScript {
  /** The words, as shown: no hint, no cues, whitespace collapsed. */
  text: string;
  /** The delivery hint without its brackets, when the script has one. */
  delivery?: string;
}

/** The script in a say fence, or null when it holds no words. */
export function parseSay(source: string): SayScript | null {
  let text = source.replace(CUE_ANYWHERE, " ").replace(/\s+/g, " ").trim();
  const hint = DELIVERY.exec(text);
  let delivery: string | undefined;
  if (hint) {
    delivery = hint[1]!.trim();
    text = text.slice(hint[0].length).trim();
  }
  if (!text) return null;
  return delivery ? { text, delivery } : { text };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** A cue right after a link's closing parenthesis. */
const LINK_CUE = new RegExp(`(\\]\\([^()\\s]*\\))${CUE}`, "g");
/** A cue ending a line, with the space before it. */
const LINE_END_CUE = new RegExp(`[ \\t]*${CUE}[ \\t]*$`);

/**
 * The markdown without its cue anchors: a `{#id}` right after a link, or at
 * the end of a line (a fence's opening line included). Text inside fenced
 * code is left alone. Cheap when there is nothing to strip.
 */
export function stripCueAnchors(src: string): string {
  if (!src.includes("{#")) return src;
  const lines = src.split("\n");
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const open = FENCE_OPEN.exec(line);
    if (fence) {
      if (
        open &&
        open[1]![0] === fence.char &&
        open[1]!.length >= fence.length &&
        !line.slice(open[0].length).trim()
      )
        fence = null;
      continue;
    }
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      lines[index] = line.replace(LINE_END_CUE, "");
      continue;
    }
    if (!line.includes("{#")) continue;
    lines[index] = line.replace(LINK_CUE, "$1").replace(LINE_END_CUE, "");
  }
  return lines.join("\n");
}

export const sayUpgrader: FenceUpgrader = {
  langs: ["say"],
  async upgrade({ pre, source, root, alive }) {
    const script = parseSay(source);
    if (!script || !alive() || !root.contains(pre)) return false;
    const line = document.createElement("p");
    line.className = SAY_BLOCK_CLASS;
    const label = document.createElement("span");
    label.className = "md-say-label";
    label.textContent = "Said aloud";
    const words = document.createElement("span");
    // Untrusted text: never markup.
    words.textContent = script.text;
    line.append(label, words);
    pre.replaceWith(line);
    return true;
  },
};
