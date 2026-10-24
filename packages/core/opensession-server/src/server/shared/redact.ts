/** Strip credentials from https URLs before they reach logs/errors — covers
 *  GitHub's `x-access-token:<token>@` and code.storage's `t:<jwt>@` userinfo
 *  anywhere in the string (git echoes full remote URLs into its stderr). */
export function redactUrl(s: string): string {
  return s.replace(/(https?:\/\/)[^@/\s]+@/g, "$1");
}

// Assignments whose name says the value is a credential: GH_TOKEN=…,
// OPENAI_API_KEY='…', DB_PASSWORD=…, ?token=…. The name must end in the
// credential word, so token_count or keyboard stay untouched.
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|_key|access[_-]?key))=("[^"]*"|'[^']*'|[^\s&;|]+)/gi;
// Well-known credential shapes, wherever they appear.
const SECRET_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
];

/**
 * Mask credentials in a one-line summary of a command or argument before it
 * is shown somewhere more prominent than the tool call itself: bearer
 * tokens, `NAME_TOKEN=` / `NAME_KEY=` style assignments, GitHub, OpenAI or
 * Anthropic and Slack token shapes, and URL userinfo (redactUrl).
 */
export function redactSecrets(s: string): string {
  let out = redactUrl(s)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(Authorization:\s*Basic)\s+[A-Za-z0-9+/=]+/gi, "$1 ***")
    .replace(SECRET_ASSIGNMENT, "$1=***");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "***");
  return out;
}
