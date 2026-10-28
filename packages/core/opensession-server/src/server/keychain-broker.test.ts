/**
 * The call_credential broker: a grant works only in the session it was
 * issued to, the call stays on the credential's host and within its ceiling
 * after path normalization, and the secret never comes back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = join(mkdtempSync(join(tmpdir(), "kc-broker-")), "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

const kc = await import("./keychain");
const { brokerCall } = await import("./keychain-broker");
const { fetchBackedNet } = await import("./testing/pinned-fetch-double");

const SECRET = "sk-broker-secret-1234";

function reset(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}

type Seen = { url: string; init: RequestInit };
let seen: Seen[] = [];
let reply: () => Response = () =>
  Response.json(
    { ok: true },
    { headers: { "content-type": "application/json" } },
  );
const fetchImpl = async (url: URL, init: RequestInit) => {
  seen.push({ url: String(url), init });
  return reply();
};
/** What the broker's host resolves to; public unless a test says otherwise. */
let addresses = ["203.0.113.10"];
const net = {
  ...fetchBackedNet(fetchImpl),
  resolve: async () => [...addresses],
};

beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  reset();
  seen = [];
  addresses = ["203.0.113.10"];
  reply = () =>
    Response.json(
      { ok: true },
      { headers: { "content-type": "application/json" } },
    );
});
afterEach(reset);

function setup(
  over: Partial<Parameters<typeof kc.addCredential>[0]> = {},
  mode: "once" | "standing" = "standing",
) {
  const meta = kc.addCredential({
    owner: "Alex",
    service: "acme",
    host: "api.example.test",
    secret: SECRET,
    ...over,
  });
  const grant = kc.__mintGrantForTest({
    credentialId: meta.id,
    sessionId: "s-1",
    requestedBy: "Sam",
    mode,
  });
  return { meta, grant };
}

const call = (
  over: Partial<Parameters<typeof brokerCall>[0]> = {},
): ReturnType<typeof brokerCall> =>
  brokerCall({
    sessionId: "s-1",
    credential: "acme",
    method: "GET",
    path: "/v1/items?limit=2",
    net,
    ...over,
  });

describe("call_credential broker", () => {
  test("injects the credential and returns the response", async () => {
    setup();
    const r = await call({
      headers: {
        accept: "application/json",
        cookie: "x",
        authorization: "Bearer mine",
      },
    });
    expect(r).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.example.test/v1/items?limit=2");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("cookie")).toBeNull();
  });

  test("a grant works only in the session it was issued to", async () => {
    setup();
    const r = await call({ sessionId: "s-other" });
    expect(r).toHaveProperty("error");
    expect(seen).toHaveLength(0);
    // Knowing the grant id does not help another session either.
    const grant = kc.listGrants({ sessionId: "s-1" })[0]!;
    expect(
      kc.consumeGrantForBroker(grant.id, "s-other", "GET", "/v1/x"),
    ).toMatchObject({ status: 404 });
  });

  test("the path stays on the host and inside the ceiling after normalization", async () => {
    setup({ allowedPathPrefixes: ["/v1/items"], allowedMethods: ["GET"] });
    for (const path of [
      "/v1/items/../admin",
      "/v1/items/%2e%2e/admin",
      "//evil.example.test/v1/items",
      "@evil.example.test/v1/items",
      "/v1/admin",
    ]) {
      expect(await call({ path })).toHaveProperty("error");
    }
    expect(
      await call({ method: "DELETE", path: "/v1/items/1" }),
    ).toHaveProperty("error");
    expect(seen).toHaveLength(0);
    expect(await call({ path: "/v1/items/1" })).toMatchObject({ status: 200 });
  });

  test("a once grant is spent by its first call", async () => {
    setup({}, "once");
    expect(await call()).toMatchObject({ status: 200 });
    expect(await call()).toHaveProperty("error");
    expect(seen).toHaveLength(1);
  });

  test("the secret is scrubbed from headers and body, in common encodings", async () => {
    setup();
    const b64 = Buffer.from(SECRET).toString("base64");
    reply = () =>
      new Response(
        `{"raw":"${SECRET}","b64":"${b64}","url":"${encodeURIComponent(SECRET)}"}`,
        {
          status: 302,
          headers: {
            "content-type": "application/json",
            location: `https://elsewhere.example.test/?k=${SECRET}`,
            "set-cookie": "session=abc",
          },
        },
      );
    const r = await call();
    const out = JSON.stringify(r);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(b64);
    expect(out).not.toContain("set-cookie");
    expect(r).toMatchObject({ status: 302 });
  });

  test("a status-only credential returns nothing but the status", async () => {
    setup({ statusOnly: true });
    reply = () => new Response(`echo ${SECRET}`, { status: 201 });
    expect(await call()).toEqual({ status: 201, statusOnly: true });
    expect(kc.findCredential("acme")?.statusOnly).toBe(true);
  });

  test("binary bodies are omitted and long text is truncated", async () => {
    setup();
    reply = () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    expect(((await call()) as { body: string }).body).toContain("omitted");
    reply = () =>
      new Response("x".repeat(100_000), {
        headers: { "content-type": "text/plain" },
      });
    const long = (await call()) as { body: string; truncated?: true };
    expect(long.truncated).toBe(true);
    expect(long.body.length).toBeLessThanOrEqual(60_000);
  });

  test("no grant, no call", async () => {
    kc.addCredential({
      owner: "Alex",
      service: "acme",
      host: "api.example.test",
      secret: SECRET,
    });
    expect(await call()).toHaveProperty("error");
    expect(seen).toHaveLength(0);
  });
});

describe("where the broker may connect", () => {
  test("a host that resolves to a private address is refused before any request", async () => {
    setup();
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1"]) {
      addresses = [address];
      const r = await call();
      expect(r).toHaveProperty("error");
      expect((r as { error: string }).error).toContain("private address");
    }
    // One private answer among public ones is enough to refuse.
    addresses = ["203.0.113.10", "192.168.1.20"];
    expect(await call()).toHaveProperty("error");
    expect(seen).toHaveLength(0);
  });

  test("the request is pinned to the checked addresses", async () => {
    setup();
    const pinned: string[][] = [];
    const r = await call({
      net: {
        ...net,
        send: async (target, init, isBlocked) => {
          pinned.push(target.addresses);
          return net.send!(target, init, isBlocked);
        },
      },
    });
    expect(r).toMatchObject({ status: 200 });
    expect(pinned).toEqual([["203.0.113.10"]]);
  });

  test("a redirect comes back unread and is never followed", async () => {
    setup();
    reply = () =>
      new Response("moved", {
        status: 302,
        headers: { location: "https://elsewhere.example.test/v1/items" },
      });
    const r = await call();
    expect(r).toMatchObject({
      status: 302,
      headers: { location: "https://elsewhere.example.test/v1/items" },
    });
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.example.test/v1/items?limit=2",
    ]);
  });
});

describe("a credential's host", () => {
  const add = (host: string) => () =>
    kc.addCredential({
      owner: "Alex",
      service: "acme",
      host,
      secret: SECRET,
    });

  test("is never an IP literal or a private name", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "8.8.8.8",
      "localhost",
      "metadata.internal",
      "printer.local",
      "intranet",
      "build.lan",
    ])
      expect(add(host)).toThrow(/host/);
    expect(kc.listCredentials()).toHaveLength(0);
    expect(add("api.example.test")()).toMatchObject({
      host: "api.example.test",
    });
  });

  test("can't be changed to one either", async () => {
    const meta = kc.addCredential({
      owner: "Alex",
      service: "acme",
      host: "api.example.test",
      secret: SECRET,
    });
    for (const host of ["127.0.0.1", "localhost", "db.internal"])
      await expect(
        kc.updateCredentialAsync(meta.id, "Alex", {
          spec: { service: "acme", host },
        }),
      ).rejects.toThrow(/host/);
    expect(kc.findCredential("acme")?.host).toBe("api.example.test");
  });
});

describe("path prefixes", () => {
  const refused = async (path: string) => {
    const r = await call({ path });
    return "error" in r;
  };

  test("match whole path segments, not characters", async () => {
    setup({ allowedPathPrefixes: ["/v1/items"] });
    for (const path of [
      "/v1/items-admin",
      "/v1/itemsanything",
      "/v1/items.json",
      "/v1/admin?next=/v1/items/1",
    ])
      expect(await refused(path)).toBe(true);
    expect(seen).toHaveLength(0);
    for (const path of [
      "/v1/items",
      "/v1/items/",
      "/v1/items/1",
      "/v1/items?next=/admin",
      "/v1/items/1?q=..%2Fadmin",
    ])
      expect(await refused(path)).toBe(false);
  });

  test("refuse encoded separators and dots once a prefix is set", async () => {
    setup({ allowedPathPrefixes: ["/v1/items"] });
    for (const path of [
      "/v1/items/..%2Fadmin",
      "/v1/items/..%2fadmin",
      "/v1/items%2F..%2F..%2Fadmin",
      "/v1/items/..%5Cadmin",
      "/v1/items/a%2Ejson",
      "/v1/items/%252F..%252Fadmin",
    ])
      expect(await refused(path)).toBe(true);
    expect(seen).toHaveLength(0);
  });

  test("without a prefix, an encoded slash is passed on as is", async () => {
    setup();
    expect(await refused("/v1/items/a%2Fb")).toBe(false);
    expect(seen[0]!.url).toBe("https://api.example.test/v1/items/a%2Fb");
  });

  test("the same rule holds for a scripted run's and an incident's calls", () => {
    const { grant } = setup({ allowedPathPrefixes: ["/v1/items"] });
    expect(
      kc.consumeGrantForBroker(grant.id, "s-1", "GET", "/v1/items-admin"),
    ).toHaveProperty("error");
    expect(
      kc.consumeGrantForBroker(grant.id, "s-1", "GET", "/v1/items/..%2Fx"),
    ).toHaveProperty("error");
    expect(
      kc.consumeGrantForBroker(grant.id, "s-1", "GET", "/v1/items/../x"),
    ).toHaveProperty("error");
    expect(
      kc.consumeGrantForBroker(grant.id, "s-1", "GET", "/v1/items/1"),
    ).toHaveProperty("credential");
  });

  test("are stored without a trailing slash, and refused when they can't name a segment", () => {
    const meta = kc.addCredential({
      owner: "Alex",
      service: "acme",
      host: "api.example.test",
      secret: SECRET,
      allowedPathPrefixes: ["/v1/items/", "/v2//", "/"],
    });
    expect(meta.allowedPathPrefixes).toEqual(["/v1/items", "/v2", "/"]);
    for (const prefix of [
      "/v1/../admin",
      "/v1/./items",
      "/v1/%2e%2e",
      "/v1?x=1",
      "/v1#top",
      "/v1\\items",
      "v1/items",
    ])
      expect(() =>
        kc.addCredential({
          owner: "Alex",
          service: "acme-2",
          host: "api.example.test",
          secret: SECRET,
          allowedPathPrefixes: [prefix],
        }),
      ).toThrow(/path prefix/);
  });
});

describe("the injected header", () => {
  const sent = async () => {
    expect(await call()).toMatchObject({ status: 200 });
    return new Headers(seen.at(-1)!.init.headers);
  };

  test("Authorization gets its Bearer scheme in any letter case", async () => {
    setup({ injection: { header: "authorization" } });
    expect((await sent()).get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  test("a pasted secret that already starts with its scheme is stored without it", async () => {
    setup({ secret: `Bearer ${SECRET}` });
    expect((await sent()).get("authorization")).toBe(`Bearer ${SECRET}`);
    reset();
    setup({ secret: `  bearer   ${SECRET}` });
    expect((await sent()).get("authorization")).toBe(`Bearer ${SECRET}`);
    reset();
    setup({
      secret: `Token ${SECRET}`,
      injection: { header: "Authorization", scheme: "Token" },
    });
    expect((await sent()).get("authorization")).toBe(`Token ${SECRET}`);
  });

  test("a header without a scheme keeps the secret as pasted", async () => {
    setup({ secret: `Bearer ${SECRET}`, injection: { header: "X-Api-Key" } });
    expect((await sent()).get("x-api-key")).toBe(`Bearer ${SECRET}`);
  });

  test("a new secret loses a pasted scheme too", async () => {
    const { meta } = setup();
    await kc.updateCredentialAsync(meta.id, "Alex", {
      spec: { service: "acme", host: "api.example.test" },
      secret: `Bearer sk-rotated-9999`,
    });
    expect((await sent()).get("authorization")).toBe("Bearer sk-rotated-9999");
  });
});
