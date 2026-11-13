/**
 * Characters that make text show something other than what it says: C0 and
 * C1 controls and DEL (`\p{Cc}`), the bidi marks, embeddings, overrides and
 * isolates (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), and the
 * line and paragraph separators (U+2028, U+2029). Push text strips them
 * (`pushSafeText`); the board's text fields refuse them.
 */
const UNSAFE_CLASS =
  "[\\p{Cc}\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\u2028\\u2029]";

/** True when `value` carries one of the unsafe characters. */
export function hasUnsafeTextChars(value: string): boolean {
  return new RegExp(UNSAFE_CLASS, "u").test(value);
}

const UNSAFE_ALL = new RegExp(UNSAFE_CLASS, "gu");

/**
 * Text as it may appear in a push or a model's context: one line, none of
 * the unsafe characters (a lock screen must show what the text says, not
 * what it hides).
 */
export function pushSafeText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(UNSAFE_ALL, "")
    .replace(/ {2,}/g, " ")
    .trim();
}
