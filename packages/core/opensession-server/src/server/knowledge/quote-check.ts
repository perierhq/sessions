// Whether a support draft quotes an internal knowledge note: any run of
// INTERNAL_QUOTE_WORDS consecutive words of an internal article's body
// found in the draft, after both are normalised the same way (lower case,
// Unicode letters and digits only, single spaces). Pure; no I/O.

import { INTERNAL_QUOTE_WORDS } from "../../shared/knowledge";

export interface InternalNote {
  path: string;
  title: string;
  body: string;
}

export type QuotedNote = { path: string; title: string };

/** Each `words`-word window of the internal notes, mapped to the first
 *  note (in the order given) that holds it. */
export interface InternalWindows {
  words: number;
  notes: QuotedNote[];
  windows: Map<string, number>;
}

/** The text's words: NFKC, lower case, letters and digits of any script;
 *  everything else separates words. */
export function quoteWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function* windowsOf(words: string[], size: number): Generator<string> {
  for (let i = 0; i + size <= words.length; i++)
    yield words.slice(i, i + size).join(" ");
}

/** Shingles the internal notes once, for many drafts. */
export function internalWindows(
  internals: InternalNote[],
  words = INTERNAL_QUOTE_WORDS,
): InternalWindows {
  const size = Math.max(1, Math.floor(words));
  const windows = new Map<string, number>();
  const notes: QuotedNote[] = [];
  for (const note of internals) {
    const index = notes.push({ path: note.path, title: note.title }) - 1;
    for (const window of windowsOf(quoteWords(note.body), size))
      if (!windows.has(window)) windows.set(window, index);
  }
  return { words: size, notes, windows };
}

/** The first internal note (in the order shingled) the text quotes. */
export function findQuote(
  text: string,
  shingled: InternalWindows,
): QuotedNote | null {
  if (!shingled.windows.size) return null;
  let first = Infinity;
  for (const window of windowsOf(quoteWords(text), shingled.words)) {
    const index = shingled.windows.get(window);
    if (index !== undefined && index < first) first = index;
  }
  const note = shingled.notes[first];
  return note ? { ...note } : null;
}

/** The first internal note the text quotes `words` consecutive words of,
 *  or null. */
export function quotesInternal(
  text: string,
  internals: InternalNote[],
  words = INTERNAL_QUOTE_WORDS,
): QuotedNote | null {
  return findQuote(text, internalWindows(internals, words));
}
