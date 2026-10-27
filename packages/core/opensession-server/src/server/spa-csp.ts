/**
 * The Content-Security-Policy the web app's document is served with, shared
 * by the gateway (frontend-build.ts) and the stable ingress that serves the
 * last shell while the gateway restarts (stable-frontend.ts).
 *
 * `img-src` limits where the page may load images from. Agent and customer
 * text reaches the page as rendered Markdown, and the renderer already draws
 * an image on another host as a link instead of fetching it
 * (frontend/lib/remote-image.ts); this is the same rule enforced by the
 * browser, for anything rendered another way. Beyond this app and data:/blob:
 * it names only the hosts the app's own UI draws from:
 *
 * - github.com and avatars.githubusercontent.com: avatars, requested as
 *   `github.com/<login>.png`, which redirects to the avatar host.
 * - private-user-images.githubusercontent.com: where the `/gh-asset` proxy
 *   redirects a PR's attachment, with a short-lived signed URL.
 * - *.slack-edge.com and secure.gravatar.com: Slack avatars and workspace
 *   emoji in the Slack channel pane.
 *
 * A redirect is checked against the policy too, so none of these can bounce
 * an image on to a host that is not listed.
 *
 * The instance's own origins come last, read from config by the caller
 * (config.ts configuredInstanceOrigins): its private app addresses, and its
 * public ingress and PR screenshot host, which serve `/pr-images/…` from an
 * origin other than the app's. This module reads no config itself, because
 * the stable ingress (stable-frontend.ts) imports it outside the gateway.
 */
const IMAGE_SOURCES = [
  "'self'",
  "data:",
  "blob:",
  "https://github.com",
  "https://avatars.githubusercontent.com",
  "https://private-user-images.githubusercontent.com",
  "https://*.slack-edge.com",
  "https://secure.gravatar.com",
];

/** Only a plain web origin may join the policy: anything else could add a
 *  source or a directive. */
const ORIGIN =
  /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$|^https?:\/\/\[[0-9a-f:.]+\](?::\d{1,5})?$/i;

export function spaContentSecurityPolicy(
  ownOrigins: readonly string[] = [],
): string {
  const sources = [...IMAGE_SOURCES];
  for (const origin of ownOrigins)
    if (ORIGIN.test(origin) && !sources.includes(origin)) sources.push(origin);
  return ["frame-ancestors 'none'", `img-src ${sources.join(" ")}`].join("; ");
}

/** The policy with no instance origins: what the stable ingress sends for a
 *  shell published before the gateway recorded its own. */
export const SPA_CONTENT_SECURITY_POLICY = spaContentSecurityPolicy();
