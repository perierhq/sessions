// Links built from data an agent, a probe or a provider wrote. Only http and
// https render as links; anything else (javascript:, data:, file:) stays text.

/** `raw` when it parses as an http(s) URL, else null. */
export function httpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}
