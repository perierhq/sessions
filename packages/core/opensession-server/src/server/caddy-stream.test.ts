import { expect, test } from "bun:test";
import {
  CADDY_STREAM_CLOSE_DELAY,
  CADDY_UPSTREAM_TRY_DURATION,
  CADDY_UPSTREAM_TRY_INTERVAL,
} from "./caddy-stream";
import { previewServerConfig } from "./preview";
import { privateAppCaddySnippet } from "./private-app-domain";
import { upsertCaddyIngress } from "./sandbox/caddy-ingress";

// Without a close delay, a Caddy config reload blocks on any proxied
// WebSocket whose peer stopped reading, holding the config lock for good.
test("every generated reverse proxy delays closing WebSockets on reload", () => {
  expect(CADDY_STREAM_CLOSE_DELAY).not.toBe("0");
  const portal = JSON.stringify(
    previewServerConfig(20000, "127.0.0.1:41000", "portals.example.test"),
  );
  expect(portal).toContain(
    `"upstreams":[{"dial":"127.0.0.1:41000"}],"stream_close_delay":"${CADDY_STREAM_CLOSE_DELAY}"`,
  );
  expect(privateAppCaddySnippet("app.example.test", "100.64.0.1")).toContain(
    `stream_close_delay ${CADDY_STREAM_CLOSE_DELAY}`,
  );
  expect(upsertCaddyIngress("", "https://ingress.example.test")).toContain(
    `stream_close_delay ${CADDY_STREAM_CLOSE_DELAY}`,
  );
});

// A gateway restart closes its ports for a few seconds. Caddy hides that only
// when the proxy keeps retrying the dial; without it a webhook delivery or a
// Portal page load that lands mid-restart gets a 502, and webhooks are not
// redelivered.
test("every generated reverse proxy to the gateway retries while it restarts", () => {
  const portal = previewServerConfig(
    20000,
    "127.0.0.1:41000",
    "portals.example.test",
  );
  const proxies: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.handler === "reverse_proxy") proxies.push(record);
    Object.values(record).forEach(walk);
  };
  walk(portal);
  const auth = proxies.find((proxy) => proxy.rewrite);
  expect(auth?.load_balancing).toEqual({
    try_duration: CADDY_UPSTREAM_TRY_DURATION,
    try_interval: CADDY_UPSTREAM_TRY_INTERVAL,
  });
  const retry = `lb_try_duration ${CADDY_UPSTREAM_TRY_DURATION}`;
  const interval = `lb_try_interval ${CADDY_UPSTREAM_TRY_INTERVAL}`;
  for (const snippet of [
    privateAppCaddySnippet("app.example.test", "100.64.0.1"),
    upsertCaddyIngress("", "https://ingress.example.test"),
  ]) {
    expect(snippet).toContain(retry);
    expect(snippet).toContain(interval);
  }
});
