/**
 * Which images rendered Markdown may load by itself.
 *
 * Transcript, PR, incident and support prose is written by agents and by
 * people outside the team. An `<img>` fetches its URL the moment it is parsed,
 * so an image on another host is a request from the viewer's browser to
 * wherever the text pointed, with whatever the text put in the URL. That
 * request leaves from the viewer's machine, outside any network policy the
 * run that wrote the text was under.
 *
 * So rendered Markdown loads images only from this app (and data:/blob:,
 * which fetch nothing). Any other image is drawn as a named placeholder that
 * links to it: the host is visible, and nothing is fetched until someone
 * chooses to open it in a new tab. The SPA's `img-src` policy
 * (server/spa-csp.ts) backs this up for anything rendered some other way.
 */

import { imageIconMarkup, playRectangleIconMarkup } from "../components/icons";
import { INTERNAL_ORIGINS } from "./session-url";
import { PUBLIC_BASE_URL } from "./brand";

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The document URL relative sources resolve against. */
function documentBase(): string {
  return typeof location === "undefined" ? PUBLIC_BASE_URL : location.href;
}

function parse(href: string): URL | null {
  try {
    return new URL(href, documentBase());
  } catch {
    return null;
  }
}

/** A source that names its own scheme or host rather than a path here. */
const ABSOLUTE = /^[\s\u0000-\u001f]*(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i;

/**
 * The source an image may load from inline, or null when it would fetch from
 * another host. A same-origin source comes back as written; an absolute URL
 * on one of this app's other origins (its configured public address, viewed
 * through another entry URL) comes back as a path, so it loads from the
 * origin the page is on. The URL parser is the browser's own, so a
 * scheme-relative or backslash spelling resolves here exactly as it would in
 * the `<img>`; an absolute spelling of this app is rewritten to its path, so
 * the browser never has to resolve a host for it at all.
 */
export function inlineImageSrc(href: string | null | undefined): string | null {
  if (!href) return null;
  const url = parse(href);
  if (!url) return null;
  if (url.protocol === "data:" || url.protocol === "blob:") return href;
  const own = parse(documentBase())?.origin;
  if (url.origin === "null") return null;
  if (url.origin !== own && !INTERNAL_ORIGINS.has(url.origin)) return null;
  return ABSOLUTE.test(href) ? `${url.pathname}${url.search}${url.hash}` : href;
}

/** Whether a URL is a picture Slack serves from its own CDN (workspace emoji). */
export function isSlackHostedImage(href: string): boolean {
  const url = parse(href);
  return (
    !!url &&
    url.protocol === "https:" &&
    (url.hostname === "slack-edge.com" ||
      url.hostname.endsWith(".slack-edge.com"))
  );
}

export interface RemoteMediaOptions {
  kind: "image" | "video";
  alt?: string;
  /** Inside a link already, where a second link would nest in the first:
   *  draw the name without an action and let the outer link own the click. */
  inLink?: boolean;
}

/**
 * The placeholder for media on another host: its glyph, "Image from <host>",
 * and, when it stands alone, an Open action that follows the link in a new
 * tab without a referrer. Only http(s) URLs are ever linked.
 */
export function remoteMediaMarkup(
  href: string,
  { kind, alt, inLink = false }: RemoteMediaOptions,
): string {
  const url = parse(href);
  const web = !!url && (url.protocol === "https:" || url.protocol === "http:");
  const host = web ? url.host : "";
  const noun = kind === "video" ? "Video" : "Image";
  const label = `${noun} from ${host || "another site"}`;
  const title = alt?.trim() || host;
  const glyph =
    kind === "video" ? playRectangleIconMarkup(16) : imageIconMarkup(16);
  const body =
    `<span class="md-remote-media-icon" aria-hidden="true">${glyph}</span>` +
    `<span class="md-remote-media-label">${escapeAttr(label)}</span>`;
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
  if (inLink)
    return `<span class="md-remote-media md-remote-media-inline"${titleAttr}>${body}</span>`;
  if (!web) return `<span class="md-remote-media"${titleAttr}>${body}</span>`;
  return (
    `<a href="${escapeAttr(href)}" class="md-remote-media" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"${titleAttr}>` +
    `${body}<span class="md-remote-media-action">Open</span></a>`
  );
}
