/** Shared Caddy reverse-proxy settings for generated configuration. */

/**
 * How long Caddy keeps a proxied WebSocket open after a config reload
 * retires the handler that carried it.
 *
 * Every Portal route change reloads Caddy's whole config. With the default
 * (0) the reload itself writes a close frame to every proxied WebSocket,
 * with no deadline, while holding Caddy's config lock. One peer that has
 * stopped reading (a sleeping laptop's tab, a stalled relay) then blocks
 * that write, the reload never finishes, and every later admin call hangs,
 * so no Portal route anywhere can change until Caddy is restarted. It also
 * dropped every live HMR connection on each Portal start. With a delay the
 * reload only arms a timer, and old connections end on their own or later.
 * Used by the Portal routes (preview.ts) and the Caddyfile generators
 * (private-app-domain.ts, sandbox/caddy-ingress.ts).
 */
export const CADDY_STREAM_CLOSE_DELAY = "1h";

/**
 * How long Caddy keeps retrying the dial to an upstream that refuses it, and
 * how often. A deploy restarts the gateway, which closes its ports (the app,
 * the public ingress, the Portal sign-in check) for a few seconds. With a
 * retry window Caddy holds the request and sends it once the new process
 * listens, so the restart costs latency rather than a 502. Only failed dials
 * are retried for every method; Caddy replays the buffered body, so a webhook
 * POST survives too (GitHub does not redeliver a failed webhook). The window
 * covers a health-gated restart with room to spare, while a server that is
 * really down still fails within a bounded time.
 */
export const CADDY_UPSTREAM_TRY_DURATION = "15s";
export const CADDY_UPSTREAM_TRY_INTERVAL = "250ms";
