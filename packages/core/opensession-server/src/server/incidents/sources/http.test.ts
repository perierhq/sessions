import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import type { HttpSource } from "../../../shared/incidents";
import { isBlockedAddress } from "../../shared/network-address";
import type { FetchTarget, PinnedResponse } from "../../shared/pinned-fetch";
import { type SourceRunOptions, runHttpSource } from "./http";

const LOCAL = "127.0.0.1";
/** The real address policy, with only the local test servers let through. */
const allowLocal = (address: string) =>
  address !== LOCAL && isBlockedAddress(address);
const allow: SourceRunOptions = {
  net: { resolve: async () => [LOCAL], isBlocked: allowLocal },
};
let a: Server<undefined>;
let b: Server<undefined>;
/** Server roots by address: `localhost` is a reserved name the guard refuses. */
let A = "";
let B = "";
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
      if (p === "/echo-all") {
        const auth = req.headers.get("authorization") ?? "";
        return Response.json({
          url: req.url,
          auth,
          basic: atob(auth.replace(/^Basic /, "")),
          key: encodeURIComponent(req.headers.get("x-api-key") ?? ""),
          body: await req.text(),
          n: 1,
        });
      }
      if (p === "/odd-encoding")
        return new Response('{"status":"ok"}', {
          headers: { "content-encoding": "compress" },
        });
      if (p === "/see-other") return Response.redirect(`${A}echo`, 303);
      if (p === "/temp") return Response.redirect(`${A}echo`, 307);
      if (p === "/temp-away") return Response.redirect(`${B}`, 307);
      if (p === "/bad-location")
        return new Response(null, {
          status: 302,
          headers: { location: "http://[bad" },
        });
      if (p === "/secret-hop")
        return Response.redirect(`${A}ok?token=t0p&page=2`, 302);
      if (p === "/hop") return Response.redirect(`${A}ok`, 302);
      if (p === "/away") return Response.redirect(`${B}`, 302);
      if (p === "/loop") return Response.redirect(`${A}loop`, 302);
      if (p === "/private") return Response.redirect("http://10.0.0.1/", 302);
      if (p === "/statuspage")
        return Response.json({
          status: { indicator: "major", description: "Major outage" },
          components: [{ name: "API", status: "major_outage" }],
        });
      return new Response("results: 3");
    },
  });
  A = `http://${LOCAL}:${a.port}/`;
  B = `http://${LOCAL}:${b.port}/`;
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
    { kind: "http", url: `${A}${path.replace(/^\//, "")}`, ...extra },
    opts,
  );

test("ok with latency", async () => {
  const [o] = (await run("/ok")).observations;
  expect(o).toMatchObject({ result: "ok", sourceUrl: `${A}ok` });
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

test("secrets the check sends never come back in the preview or a detail", async () => {
  const basic = btoa("ada:pa55word");
  const out = await run("/echo-all?api_key=k3y%2Fx&page=2", {
    method: "POST",
    body: '{"token":"b0dy-t0ken"}',
    headers: { Authorization: `Basic ${basic}`, "X-Api-Key": "s3cret+key/=" },
    json: { detail: "$.basic" },
  });
  expect(out.observations[0]).toMatchObject({
    result: "ok",
    detail: "[redacted]",
  });
  expect(out.preview?.json).toMatchObject({ n: 1, auth: "[redacted]" });
  expect(out.preview?.matches).toEqual({ "$.basic": ["[redacted]"] });
  expect(out.preview?.bodyHead).toContain('"n":1');
  const text = JSON.stringify(out);
  for (const secret of [
    "k3y",
    basic,
    "pa55word",
    "s3cret",
    "s3cret%2Bkey",
    "b0dy-t0ken",
  ])
    expect([secret, text.includes(secret)]).toEqual([secret, false]);
});

test("a body in an encoding that cannot be read says so", async () => {
  const judged = await run("/odd-encoding", { json: { preset: "plain" } });
  expect(judged.observations[0]).toMatchObject({
    result: "fail",
    detail: "Response body is in an encoding that cannot be read (compress)",
  });
  expect(judged.preview?.undecodable).toBe(true);
  const plain = await run("/odd-encoding");
  expect(plain.observations[0].result).toBe("ok");
  expect(plain.preview?.undecodable).toBe(true);
  expect((await run("/ok")).preview?.undecodable).toBeUndefined();
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
  expect(hop.preview?.finalUrl).toBe(`${A}hop`);
});

test("secret query values never leave in sourceUrl or finalUrl", async () => {
  const out = await runHttpSource(
    { kind: "http", url: `${A}secret-hop?api_key=k3y&q=1` },
    allow,
  );
  expect(out.observations[0].sourceUrl).toBe(
    `${A}secret-hop?api_key=[redacted]&q=1`,
  );
  expect(out.preview?.finalUrl).toBe(`${A}ok?token=[redacted]&page=2`);
  expect(JSON.stringify(out)).not.toMatch(/k3y|t0p/);
});

test("redirects: followed, bounded, credentials stay with their origin", async () => {
  const hop = await run("/hop");
  expect(hop.observations[0].result).toBe("ok");
  expect(hop.preview?.finalUrl).toBe(`${A}ok`);
  expect((await run("/loop")).observations[0].detail).toBe(
    "Too many redirects",
  );
  await run("/away", {
    headers: { Authorization: "Bearer s3cret", Accept: "application/json" },
  });
  expect(seenAuthOnB).toBeNull();
});

test("SSRF guard: refused hops are unknown and never dialled", async () => {
  expect((await run("/private")).observations[0]).toMatchObject({
    result: "unknown",
    detail: "Refused: 10.0.0.1 is a private address",
  });
  // The real guard refuses loopback.
  expect(
    (await runHttpSource({ kind: "http", url: `${A}ok` })).observations[0]
      .result,
  ).toBe("unknown");
  const dns: SourceRunOptions = {
    net: {
      resolve: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        });
      },
    },
  };
  expect(
    (
      await runHttpSource(
        { kind: "http", url: "https://acme.example.test/" },
        dns,
      )
    ).observations[0],
  ).toMatchObject({
    result: "fail",
    detail: "Could not reach acme.example.test: getaddrinfo ENOTFOUND",
  });
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
        url: `${A.replace("http://", "http://u:p@")}ok`,
      },
      allow,
    )
  ).observations;
  expect(o.sourceUrl).not.toContain("u:p@");
});

/** A transport that answers without a network and records what it dialled. */
function recordingSend(answer: (target: FetchTarget) => PinnedResponse) {
  const dialled: Array<{ url: string; addresses: string[] }> = [];
  return {
    dialled,
    send: async (target: FetchTarget) => {
      dialled.push({ url: target.url.href, addresses: [...target.addresses] });
      return answer(target);
    },
  };
}

test("a named host is dialled at its checked address, never resolved again", async () => {
  const lookups: string[] = [];
  const out = await runHttpSource(
    { kind: "http", url: `http://svc.example.test:${a.port}/ok` },
    {
      net: {
        resolve: async (host) => {
          lookups.push(host);
          return [LOCAL];
        },
        isBlocked: allowLocal,
      },
    },
  );
  // svc.example.test has no public DNS: reaching the server proves the
  // connection used the pinned address.
  expect(out.observations[0]).toMatchObject({ result: "ok" });
  expect(lookups).toEqual(["svc.example.test"]);
});

test("DNS rebinding: a public answer then a private one never reaches the private address", async () => {
  const answers = [["203.0.113.10"], ["10.0.0.1"]];
  let calls = 0;
  const resolve = async () => answers[Math.min(calls++, answers.length - 1)]!;
  const single = recordingSend(() => ({
    status: 200,
    headers: new Headers(),
    body: new TextEncoder().encode("fine"),
  }));
  const one = await runHttpSource(
    { kind: "http", url: "https://rebind.example.test/" },
    { net: { resolve, isBlocked: isBlockedAddress, send: single.send } },
  );
  expect(one.observations[0].result).toBe("ok");
  expect(calls).toBe(1);
  expect(single.dialled).toEqual([
    { url: "https://rebind.example.test/", addresses: ["203.0.113.10"] },
  ]);

  // Across a redirect every hop is resolved and checked on its own, so an
  // answer that flips to private between hops is refused, not dialled.
  calls = 0;
  const hops = recordingSend(() => ({
    status: 302,
    headers: new Headers({ location: "/next" }),
    body: new Uint8Array(),
  }));
  const two = await runHttpSource(
    { kind: "http", url: "https://rebind.example.test/" },
    { net: { resolve, isBlocked: isBlockedAddress, send: hops.send } },
  );
  expect(two.observations[0]).toMatchObject({
    result: "unknown",
    detail:
      "Refused: rebind.example.test resolves to the private address 10.0.0.1",
  });
  expect(hops.dialled).toEqual([
    { url: "https://rebind.example.test/", addresses: ["203.0.113.10"] },
  ]);
});

test("IPv4-mapped IPv6 literals for private addresses are refused", async () => {
  const never = recordingSend(() => {
    throw new Error("dialled");
  });
  for (const url of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]:8080/",
    "https://[::ffff:10.0.0.1]/",
    "https://[::ffff:a9fe:a9fe]/latest/meta-data",
  ]) {
    const [o] = (
      await runHttpSource({ kind: "http", url }, { net: { send: never.send } })
    ).observations;
    expect([url, o.result, o.detail]).toEqual([
      url,
      "unknown",
      expect.stringMatching(/^Refused: \S+ is a private address$/),
    ]);
  }
  expect(never.dialled).toEqual([]);
});

test("refusals of names and schemes are unknown too", async () => {
  for (const [url, detail] of [
    ["http://localhost:9/", "Refused: localhost is a private name"],
    ["http://db.internal/", "Refused: db.internal is a private name"],
  ] as const)
    expect(
      (await runHttpSource({ kind: "http", url })).observations[0],
    ).toMatchObject({ result: "unknown", detail });
});
