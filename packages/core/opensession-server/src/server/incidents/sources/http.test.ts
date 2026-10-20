import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import type { HttpSource } from "../../../shared/incidents";
import { type SourceRunOptions, runHttpSource } from "./http";

const allow = { assertUrl: async (raw: string) => new URL(raw) };
let a: Server<undefined>;
let b: Server<undefined>;
let seenAuthOnB: string | null = "unset";

beforeAll(() => {
  b = Bun.serve({
    port: 0,
    fetch(req) {
      seenAuthOnB = req.headers.get("authorization");
      return Response.json({ status: "ok" });
    },
  });
  a = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/ok") return Response.json({ status: "ok", depth: 7 });
      if (p === "/down") return new Response("nope", { status: 503 });
      if (p === "/html")
        return new Response("<html>challenge</html>", {
          headers: { "content-type": "text/html" },
        });
      if (p === "/slow") {
        await Bun.sleep(500);
        return new Response("late");
      }
      if (p === "/big") return new Response("x".repeat(1_500_000));
      if (p === "/hop") return Response.redirect(`${a.url}ok`, 302);
      if (p === "/away") return Response.redirect(`${b.url}`, 302);
      if (p === "/loop") return Response.redirect(`${a.url}loop`, 302);
      if (p === "/private") return Response.redirect("http://10.0.0.1/", 302);
      if (p === "/statuspage")
        return Response.json({
          status: { indicator: "major", description: "Major outage" },
          components: [{ name: "API", status: "major_outage" }],
        });
      return new Response("results: 3");
    },
  });
});
afterAll(() => {
  a.stop(true);
  b.stop(true);
});

const run = (
  path: string,
  extra: Partial<HttpSource> = {},
  opts: SourceRunOptions = allow,
) =>
  runHttpSource(
    { kind: "http", url: `${a.url}${path.replace(/^\//, "")}`, ...extra },
    opts,
  );

test("ok with latency", async () => {
  const [o] = (await run("/ok")).observations;
  expect(o).toMatchObject({ result: "ok", sourceUrl: `${a.url}ok` });
  expect(o.detail).toMatch(/^HTTP 200 in \d+ ms$/);
  expect(typeof o.value).toBe("number");
});

test("status, body and timeout failures", async () => {
  expect((await run("/down")).observations[0]).toMatchObject({
    result: "fail",
    detail: "HTTP 503 (expected 2xx)",
  });
  expect(
    (await run("/down", { expectStatus: [200, 204] })).observations[0].detail,
  ).toBe("HTTP 503 (expected 200, 204)");
  expect(
    (await run("/text", { expectBody: { contains: "results" } }))
      .observations[0].result,
  ).toBe("ok");
  expect(
    (await run("/text", { expectBody: { contains: "price" } })).observations[0]
      .detail,
  ).toBe('Response did not contain "price"');
  expect(
    (await run("/text", { expectBody: { regex: "results: [0-9]+" } }))
      .observations[0].result,
  ).toBe("ok");
  expect(
    (await run("/text", { expectBody: { regex: "price" } })).observations[0]
      .detail,
  ).toBe("Response did not match /price/");
  expect(
    (await run("/slow", { timeoutMs: 100 })).observations[0],
  ).toMatchObject({ result: "fail", detail: "No response within 100 ms" });
  expect((await run("/big")).observations[0]).toMatchObject({
    result: "fail",
    detail: "Response over 1 MB",
  });
});

test("redirects: followed, bounded, credentials stay with their origin", async () => {
  const hop = await run("/hop");
  expect(hop.observations[0].result).toBe("ok");
  expect(hop.preview?.finalUrl).toBe(`${a.url}ok`);
  expect((await run("/loop")).observations[0].detail).toBe(
    "Too many redirects",
  );
  await run("/away", {
    headers: { Authorization: "Bearer s3cret", Accept: "application/json" },
  });
  expect(seenAuthOnB).toBeNull();
});

test("SSRF guard: refused hops are unknown and never dialled", async () => {
  const guarded = {
    assertUrl: async (raw: string) => {
      if (raw.includes("10.0.0.1"))
        throw new Error(
          "Refusing to fetch 10.0.0.1: it resolves to the private address 10.0.0.1",
        );
      return new URL(raw);
    },
  };
  expect((await run("/private", {}, guarded)).observations[0]).toMatchObject({
    result: "unknown",
    detail: expect.stringMatching(/^Refused: /),
  });
  // The real guard refuses loopback.
  expect(
    (await runHttpSource({ kind: "http", url: `${a.url}ok` })).observations[0]
      .result,
  ).toBe("unknown");
  const dns = {
    assertUrl: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        code: "ENOTFOUND",
      });
    },
  };
  expect((await run("/ok", {}, dns)).observations[0].detail).toStartWith(
    "Could not reach ",
  );
});

test("JSON: mapping, value, lanes, HTML for own vs provider", async () => {
  const mapped = await run("/ok", {
    json: { preset: "plain", value: "$.depth" },
  });
  expect(mapped.observations[0]).toMatchObject({ result: "ok", value: 7 });
  expect(mapped.preview?.json).toEqual({ status: "ok", depth: 7 });
  const sp = await run("/statuspage", { json: { preset: "statuspage" } });
  expect(sp.observations.map((o) => [o.lane, o.result, o.detail])).toEqual([
    [undefined, "fail", "Major outage"],
    ["API", "fail", expect.any(String)],
  ]);
  expect(
    (await run("/html", { json: { preset: "plain" } })).observations[0],
  ).toMatchObject({
    result: "fail",
    detail: "Response was not JSON (text/html)",
  });
  expect(
    (
      await run(
        "/html",
        { json: { preset: "plain" } },
        { ...allow, provider: true },
      )
    ).observations[0].result,
  ).toBe("unknown");
});

test("sourceUrl never carries userinfo", async () => {
  const [o] = (
    await runHttpSource(
      {
        kind: "http",
        url: `${a.url.toString().replace("http://", "http://u:p@")}ok`,
      },
      allow,
    )
  ).observations;
  expect(o.sourceUrl).not.toContain("u:p@");
});
