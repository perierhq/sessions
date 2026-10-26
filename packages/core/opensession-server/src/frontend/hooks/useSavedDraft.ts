import { useState } from "react";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";

/**
 * A reply box's text, kept in local draft storage (lib/drafts) under `key` so
 * it survives navigating away. `original` is the text the box starts from when
 * nothing is saved, an agent's draft for example: text equal to it needs no
 * copy, so typing back to it (or clearing an empty box) drops the saved one.
 *
 * Returns the text, the setter that saves as it goes, and `clear` for a
 * settled reply.
 */
export function useSavedDraft(
  key: string,
  original = "",
): [text: string, setText: (next: string) => void, clear: () => void] {
  const [text, setText] = useState(() => loadDraft(key).text || original);
  function update(next: string) {
    setText(next);
    if (next === original) clearDraft(key);
    else saveDraft(key, { text: next });
  }
  return [text, update, () => clearDraft(key)];
}
