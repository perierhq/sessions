/**
 * A keychain credential's ceiling, the limits every grant inherits: its
 * methods, its path prefixes and whether calls return only the status.
 * Shared by the server, which enforces it and pauses grants when an edit
 * widens it, and the web UI, which warns before that edit is saved.
 */

export interface CredentialCeiling {
  /** Empty or absent: any method. */
  allowedMethods?: readonly string[];
  /** Empty or absent: any path. */
  allowedPathPrefixes?: readonly string[];
  statusOnly?: boolean;
}

/** Whether a normalized path is the prefix or sits under it, on a segment
 *  boundary: `/v1/items` covers `/v1/items/1`, never `/v1/items-admin`. */
export function pathWithinPrefix(path: string, prefix: string): boolean {
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path === prefix || path.startsWith(base);
}

/**
 * How `after` lets a grant do more than `before` did, one phrase per way,
 * empty when it doesn't. A grant approved under `before` was approved for
 * those limits only, so the server pauses it when this is not empty.
 */
export function ceilingWidening(
  before: CredentialCeiling,
  after: CredentialCeiling,
): string[] {
  const out: string[] = [];
  const oldMethods = before.allowedMethods ?? [];
  const newMethods = after.allowedMethods ?? [];
  if (oldMethods.length) {
    if (!newMethods.length) out.push("any method is allowed");
    else {
      const added = newMethods.filter((m) => !oldMethods.includes(m));
      if (added.length) out.push(`methods now include ${added.join(", ")}`);
    }
  }
  const oldPaths = before.allowedPathPrefixes ?? [];
  const newPaths = after.allowedPathPrefixes ?? [];
  if (oldPaths.length) {
    if (!newPaths.length) out.push("any path is allowed");
    else {
      const added = newPaths.filter(
        (p) => !oldPaths.some((old) => pathWithinPrefix(p, old)),
      );
      if (added.length) out.push(`paths now include ${added.join(", ")}`);
    }
  }
  if (before.statusOnly && !after.statusOnly)
    out.push("responses are no longer status only");
  return out;
}

/**
 * The ceiling as one line a person approves against: "GET · /v1/items ·
 * status only". `open` when neither methods nor paths are limited, so an
 * approval reaches any method on any path: the card says so in a warning
 * tone and makes a single call the default.
 */
export interface CeilingSummary {
  text: string;
  /** Neither methods nor paths are limited. */
  open: boolean;
}

export function ceilingSummary(c: CredentialCeiling): CeilingSummary {
  const methods = c.allowedMethods ?? [];
  const paths = c.allowedPathPrefixes ?? [];
  const open = !methods.length && !paths.length;
  const parts = open
    ? ["Any method, any path"]
    : [
        methods.length ? methods.join(", ") : "Any method",
        paths.length ? paths.join(", ") : "any path",
      ];
  if (c.statusOnly) parts.push("status only");
  return { text: parts.join(" · "), open };
}
