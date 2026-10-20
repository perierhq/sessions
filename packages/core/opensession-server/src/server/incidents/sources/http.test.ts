import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import type { HttpSource } from "../../../shared/incidents";
import { type SourceRunOptions, runHttpSource } from "./http";

const allow = { assertUrl: async (raw: string) => new URL(raw) };
let a: Server<undefined>;
let b: Server<undefined>;
let seenAuthOnB: string | null = "unset";
let seenOnB: Record<string, string | null> = {};
let seenOnA: Record<string, string | null> = {};

beforeAll(() => {
  b = Bun.serve({
    port: 0,
    async fetch(req) {
      seenAuthOnB = req.headers.get("authorization");
      seenOnB = {
        method: req.method,
        authorization: req.headers.get("authorization"),
        trace: req.headers.get("x-trace"),
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
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
      if (p === "/big503")
        return new Response("x".repeat(1_500_000), { status: 503 });
      if (p === "/echo") {
        seenOnA = { method: req.method, body: await req.text() };
        return new Response("echo");
      }
      if (p === "/see-other") return Response.redirect(`${a.url}echo`, 303);
      if (p === "/temp") return Response.redirect(`${a.url}echo`, 307);
      if (p === "/temp-away") return Response.redirect(`${b.url}`, 307);
      if (p === "/bad-location")
        return new Response(null, {
          status: 302,
          headers: { location: "http://[bad" },
        });
      if (p === "/secret-hop")
        return Response.redirect(`${a.url}ok?token=t0p&page=2`, 302);
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
  expect(
    (await run("/big", { expectBody: { contains: "y" } })).observations[0],
  ).toMatchObject({ result: "fail", detail: "Response over 1 MB" });
  expect(
    (await run("/big", { json: { preset: "plain" } })).observations[0],
  ).toMatchObject({ result: "fail", detail: "Response over 1 MB" });
});

test("status is judged before size; size matters only when the body does", async () => {
  expect((await run("/big503")).observations[0]).toMatchObject({
    result: "fail",
    detail: "HTTP 503 (expected 2xx)",
  });
  expect(
    (await run("/big503", { expectBody: { contains: "x" } })).observations[0]
      .detail,
  ).toBe("HTTP 503 (expected 2xx)");
  const big = await run("/big");
  expect(big.observations[0]).toMatchObject({ result: "ok" });
  expect(big.preview?.bodyTruncated).toBe(true);
});

test("a provider's unreadable status page is unknown, never an outage", async () => {
  const provider = { ...allow, provider: true };
  for (const [path, extra] of [
    ["/down", {}],
    ["/slow", { timeoutMs: 100 }],
    ["/big", { json: { preset: "plain" } }],
    ["/loop", {}],
    ["/bad-location", {}],
  ] as const) {
    const [o] = (await run(path, extra as Partial<HttpSource>, provider))
      .observations;
    expect([path, o.result]).toEqual([path, "unknown"]);
  }
  const refused = await runHttpSource(
    { kind: "http", url: "http://127.0.0.1:9/" },
    provider,
  );
  expect(refused.observations[0].result).toBe("unknown");
  // A status page that answers but does not say what it should is a claim.
  expect(
    (await run("/text", { expectBody: { contains: "price" } }, provider))
      .observations[0].result,
  ).toBe("fail");
});

test("303 turns into a GET without a body; 307 keeps both on the same origin", async () => {
  const post = { method: "POST" as const, body: "ping" };
  await run("/see-other", post);
  expect(seenOnA).toEqual({ method: "GET", body: "" });
  await run("/temp", post);
  expect(seenOnA).toEqual({ method: "POST", body: "ping" });
});

test("a cross-origin hop drops the body and secret headers, keeps the rest", async () => {
  await run("/temp-away", {
    method: "POST",
    body: '{"q":1}',
    headers: {
      Authorization: "Bearer s3cret",
      "X-Api-Key": "k",
      "X-Trace": "abc",
      "Content-Type": "application/json",
    },
  });
  expect(seenOnB).toEqual({
    method: "GET",
    authorization: null,
    trace: "abc",
    contentType: null,
    body: "",
  });
});

test("a redirect to an invalid URL is a failure", async () => {
  expect((await run("/bad-location")).observations[0]).toMatchObject({
    result: "fail",
    detail: "Redirect to an invalid URL",
  });
});

test("an expected 3xx is the answer, not a hop", async () => {
  const hop = await run("/hop", { expectStatus: [302] });
  expect(hop.observations[0].result).toBe("ok");
  expect(hop.preview?.status).toBe(302);
  expect(hop.preview?.finalUrl).toBe(`${a.url}hop`);
});

test("secret query values never leave in sourceUrl or finalUrl", async () => {
  const out = await runHttpSource(
    { kind: "http", url: `${a.url}secret-hop?api_key=k3y&q=1` },
    allow,
  );
  expect(out.observations[0].sourceUrl).toBe(
    `${a.url}secret-hop?api_key=[redacted]&q=1`,
  );
  expect(out.preview?.finalUrl).toBe(`${a.url}ok?token=[redacted]&page=2`);
  expect(JSON.stringify(out)).not.toMatch(/k3y|t0p/);
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
