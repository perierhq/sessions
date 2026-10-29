/**
 * Editing a credential from Settings: a partial update that keeps what it
 * doesn't name, a rotated secret that is never returned, an optional expiry
 * date the broker enforces, and a status-only test call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = join(mkdtempSync(join(tmpdir(), "kc-edit-")), "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

const kc = await import("./keychain");
const { brokerCall, testCredential } = await import("./keychain-broker");
const {
  handleKeychainRoutes,
  lendingByCredential,
  __setKeychainProjectsForTest,
} = await import("./routes/keychain");
const { fetchBackedNet } = await import("./testing/pinned-fetch-double");

const SECRET = "sk-edit-secret-1234";
const ROTATED = "sk-rotated-secret-5678";

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
  Response.json({ items: [SECRET] }, { status: 200 });
const net = fetchBackedNet(async (url, init) => {
  seen.push({ url: String(url), init });
  return reply();
});

beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  reset();
  seen = [];
  reply = () => Response.json({ items: [SECRET] }, { status: 200 });
});
afterEach(reset);

const add = (over: Partial<Parameters<typeof kc.addCredential>[0]> = {}) =>
  kc.addCredential({
    owner: "Alex",
    service: "acme-api",
    host: "api.example.test",
    secret: SECRET,
    ...over,
  });

const alex = { login: "alex-gh", name: "Alex Example" };

function route(
  method: "PATCH" | "POST",
  path: string,
  authUser: { login: string; name: string; automation?: boolean } | null,
  body: unknown,
) {
  const url = new URL(path, "https://os.example.test");
  return handleKeychainRoutes({
    path: url.pathname,
    url,
    publicPrefix: "",
    authUser,
    req: new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  }) as Promise<Response>;
}

describe("PATCH /api/keychain/credentials/:id", () => {
  test("changes only the fields it names and never returns the secret", async () => {
    const meta = add({
      description: "Orders API",
      allowedMethods: ["GET"],
      scope: "workspace",
    });
    const res = await route(
      "PATCH",
      `/api/keychain/credentials/${meta.id}`,
      alex,
      { allowedPathPrefixes: ["/v1/orders"] },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.credential).toMatchObject({
      description: "Orders API",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/v1/orders"],
      scope: "workspace",
    });
  });

  test("a field set to null or empty is cleared", async () => {
    const meta = add({ description: "Orders API", allowedMethods: ["GET"] });
    const res = await route(
      "PATCH",
      `/api/keychain/credentials/${meta.id}`,
      alex,
      { description: "", allowedMethods: [] },
    );
    const body = await res.json();
    expect(body.credential.description).toBeUndefined();
    expect(body.credential.allowedMethods).toBeUndefined();
  });

  test("rotates the secret: the next call sends the new one", async () => {
    const meta = add();
    kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "s-1",
      requestedBy: "Sam",
      mode: "standing",
    });
    const res = await route(
      "PATCH",
      `/api/keychain/credentials/${meta.id}`,
      alex,
      { secret: ROTATED },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secretRotated).toBe(true);
    expect(JSON.stringify(body)).not.toContain(ROTATED);
    await brokerCall({
      sessionId: "s-1",
      credential: "acme-api",
      method: "GET",
      path: "/v1/items",
      net,
    });
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe(
      `Bearer ${ROTATED}`,
    );
  });

  test("an empty secret keeps the current one", async () => {
    const meta = add();
    const res = await route(
      "PATCH",
      `/api/keychain/credentials/${meta.id}`,
      alex,
      { secret: "", description: "Orders" },
    );
    expect((await res.json()).secretRotated).toBe(false);
  });

  test("needs the owner's verified sign-in", async () => {
    const meta = add();
    const path = `/api/keychain/credentials/${meta.id}`;
    expect(
      (await route("PATCH", path, null, { description: "x" })).status,
    ).toBe(401);
    expect(
      (
        await route(
          "PATCH",
          path,
          { ...alex, automation: true },
          { description: "x" },
        )
      ).status,
    ).toBe(401);
    const bea = await route(
      "PATCH",
      path,
      { login: "bea-gh", name: "Bea Example" },
      { description: "x" },
    );
    expect(bea.status).toBe(403);
    expect((await bea.json()).error).toMatch(/owner/);
  });

  test("a stale revision is refused", async () => {
    const meta = add();
    const res = await route(
      "PATCH",
      `/api/keychain/credentials/${meta.id}`,
      alex,
      { description: "x", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" },
    );
    expect(res.status).toBe(409);
  });
});

describe("name", () => {
  test("is display text beside the ID, which keeps its slug rule", async () => {
    const res = await route("POST", "/api/keychain/credentials", alex, {
      name: "  Betterbahn search\u202e status  ",
      service: "betterbahn-search-status",
      host: "api.example.test",
      secret: SECRET,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).credential).toMatchObject({
      name: "Betterbahn search  status",
      service: "betterbahn-search-status",
    });
    const refused = await route("POST", "/api/keychain/credentials", alex, {
      service: "Betterbahn search status",
      host: "api.example.test",
      secret: SECRET,
    });
    expect(refused.status).toBe(400);
  });

  test("is capped in length", () => {
    const meta = add({ name: "x".repeat(500) });
    expect(meta.name).toHaveLength(kc.MAX_CREDENTIAL_NAME_CHARS);
  });

  test("changes and clears through PATCH; the ID stays", async () => {
    const meta = add({ name: "Acme orders" });
    const renamed = await route(
      "PATCH",
      `/api/keychain/credentials/${meta.id}`,
      alex,
      { name: "Acme orders, production" },
    );
    expect((await renamed.json()).credential).toMatchObject({
      name: "Acme orders, production",
      service: "acme-api",
    });
    const cleared = await route(
      "PATCH",
      `/api/keychain/credentials/${meta.id}`,
      alex,
      { name: "" },
    );
    expect((await cleared.json()).credential.name).toBeUndefined();
    expect(kc.listCredentials()[0]!.name).toBeUndefined();
  });

  test("a login takes one too", () => {
    const meta = add({
      kind: "login",
      host: undefined,
      service: "acme-staging",
      name: "Acme staging",
      loginUrl: "https://app.example.test/login",
      username: "qa@example.test",
    });
    expect(meta.name).toBe("Acme staging");
  });
});

describe("expiry", () => {
  test("adding through the route keeps the expiry and test path", async () => {
    const res = await route("POST", "/api/keychain/credentials", alex, {
      service: "acme-api",
      host: "api.example.test",
      secret: SECRET,
      expiresOn: "2099-03-01",
      testPath: "/v1/me",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).credential).toMatchObject({
      expiresOn: "2099-03-01",
      testPath: "/v1/me",
    });
  });

  test("is a day, kept on the credential", () => {
    const meta = add({ expiresOn: "2099-03-01" });
    expect(meta.expiresOn).toBe("2099-03-01");
    expect(() => add({ service: "bad", expiresOn: "March 1" })).toThrow(
      /expiry/,
    );
    expect(() => add({ service: "bad2", expiresOn: "2099-02-31" })).toThrow(
      /expiry/,
    );
  });

  test("an expired credential is refused before a grant is spent", async () => {
    const meta = add({ expiresOn: "2020-01-01" });
    const grant = kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "s-1",
      requestedBy: "Sam",
      mode: "once",
    });
    const r = await brokerCall({
      sessionId: "s-1",
      credential: "acme-api",
      method: "GET",
      path: "/v1/items",
      net,
    });
    expect(r).toMatchObject({ error: expect.stringMatching(/expired/) });
    expect(seen).toHaveLength(0);
    expect(kc.listGrants().find((g) => g.id === grant.id)?.status).toBe(
      "active",
    );
  });

  test("clearing the date makes it usable again", async () => {
    const meta = add({ expiresOn: "2020-01-01" });
    kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "s-1",
      requestedBy: "Sam",
      mode: "standing",
    });
    await kc.patchCredentialAsync(meta.id, "Alex", { expiresOn: null });
    const r = await brokerCall({
      sessionId: "s-1",
      credential: "acme-api",
      method: "GET",
      path: "/v1/items",
      net,
    });
    expect(r).toMatchObject({ status: 200 });
  });
});

describe("test call", () => {
  test("a draft: one GET with the injected secret, status only", async () => {
    reply = () => new Response("nope", { status: 401 });
    const r = await testCredential({
      by: "Alex",
      spec: { service: "acme-api", host: "api.example.test" },
      secret: SECRET,
      path: "/v1/me",
      net,
    });
    expect(r).toEqual({ status: 401, reason: "Unauthorized" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.example.test/v1/me");
    expect(seen[0]!.init.method).toBe("GET");
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe(
      `Bearer ${SECRET}`,
    );
    // Nothing is saved by a test.
    expect(kc.listCredentials()).toHaveLength(0);
  });

  test("a saved credential uses its stored secret and test path", async () => {
    const meta = add({ testPath: "/v1/me" });
    const r = await testCredential({ by: "Alex", credentialId: meta.id, net });
    expect(r).toEqual({ status: 200, reason: "OK" });
    expect(seen[0]!.url).toBe("https://api.example.test/v1/me");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test("a saved credential with unsaved edits tests the edits", async () => {
    const meta = add();
    await testCredential({
      by: "Alex",
      credentialId: meta.id,
      spec: { host: "api2.example.test", injection: { header: "X-Api-Key" } },
      secret: ROTATED,
      net,
    });
    expect(seen[0]!.url).toBe("https://api2.example.test/");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe(ROTATED);
    expect(kc.findCredential(meta.id)?.host).toBe("api.example.test");
  });

  test("only the owner can test a saved credential", async () => {
    const meta = add();
    const r = await testCredential({ by: "Bea", credentialId: meta.id, net });
    expect(r).toMatchObject({ error: expect.stringMatching(/owner/) });
    expect(seen).toHaveLength(0);
  });

  test("stays inside the credential's limits", async () => {
    const meta = add({
      allowedPathPrefixes: ["/v1/orders"],
      allowedMethods: ["GET"],
    });
    const outside = await testCredential({
      by: "Alex",
      credentialId: meta.id,
      path: "/v1/admin",
      net,
    });
    expect(outside).toMatchObject({ error: expect.stringMatching(/prefixes/) });
    const postOnly = await testCredential({
      by: "Alex",
      spec: {
        service: "acme-post",
        host: "api.example.test",
        allowedMethods: ["POST"],
      },
      secret: SECRET,
      net,
    });
    expect(postOnly).toMatchObject({ error: expect.stringMatching(/GET/) });
    expect(seen).toHaveLength(0);
  });

  test("a login can't be tested", async () => {
    const r = await testCredential({
      by: "Alex",
      spec: {
        service: "acme-staging",
        kind: "login",
        loginUrl: "https://app.example.test/login",
        username: "qa@example.test",
      },
      secret: "pw",
      net,
    });
    expect(r).toMatchObject({ error: expect.stringMatching(/login/) });
  });

  test("the test path must sit inside the path limits", () => {
    expect(() =>
      add({ allowedPathPrefixes: ["/v1/orders"], testPath: "/v2/me" }),
    ).toThrow(/test path/);
  });

  test("the route needs a verified sign-in", async () => {
    const res = await route("POST", "/api/keychain/test", null, {
      spec: { service: "acme-api", host: "api.example.test" },
      secret: SECRET,
    });
    expect(res.status).toBe(401);
  });
});

describe("widening the limits", () => {
  const standing = (credentialId: string, sessionId = "s-1") =>
    kc.__mintGrantForTest({
      credentialId,
      sessionId,
      requestedBy: "Sam",
      mode: "standing",
    });
  const status = (id: string) =>
    kc.listGrants().find((g) => g.id === id)?.status;
  const callAcme = (path = "/v1/orders", method: "GET" | "DELETE" = "GET") =>
    brokerCall({ sessionId: "s-1", credential: "acme-api", method, path, net });

  test("pauses grants approved under the narrower limits", async () => {
    const meta = add({ allowedMethods: ["GET"], allowedPathPrefixes: ["/v1"] });
    const grant = standing(meta.id);
    const result = await kc.patchCredentialAsync(meta.id, "Alex", {
      allowedMethods: ["GET", "DELETE"],
    });
    expect(result.grantsSuspended).toBe(1);
    expect(result.widened).toEqual(["methods now include DELETE"]);
    expect(status(grant.id)).toBe("suspended");
    const r = await callAcme("/v1/orders", "DELETE");
    expect(r).toMatchObject({ error: expect.stringMatching(/paused/) });
    expect(seen).toHaveLength(0);
  });

  test("turning status-only off pauses them too", async () => {
    const meta = add({ statusOnly: true });
    const grant = standing(meta.id);
    await kc.patchCredentialAsync(meta.id, "Alex", { statusOnly: false });
    expect(status(grant.id)).toBe("suspended");
  });

  test("narrowing keeps them working", async () => {
    const meta = add({ allowedPathPrefixes: ["/v1"] });
    const grant = standing(meta.id);
    const result = await kc.patchCredentialAsync(meta.id, "Alex", {
      allowedPathPrefixes: ["/v1/orders"],
      allowedMethods: ["GET"],
    });
    expect(result.grantsSuspended).toBe(0);
    expect(status(grant.id)).toBe("active");
    expect(await callAcme()).toMatchObject({ status: 200 });
  });

  test("a workspace credential's implicit grants were never approved, so stay", async () => {
    add({ allowedMethods: ["GET"], scope: "workspace" });
    await brokerCall({
      sessionId: "s-1",
      credential: "acme-api",
      method: "GET",
      path: "/v1",
      purpose: "check",
      net,
    });
    const implicit = kc.listGrants()[0]!;
    await kc.patchCredentialAsync(implicit.credentialId, "Alex", {
      allowedMethods: [],
    });
    expect(status(implicit.id)).toBe("active");
  });

  test("the owner allows a paused grant again, and only the owner", async () => {
    const meta = add({ allowedMethods: ["GET"] });
    const grant = standing(meta.id);
    await kc.patchCredentialAsync(meta.id, "Alex", { allowedMethods: [] });
    const path = `/api/keychain/grants/${grant.id}/resume`;
    expect((await route("POST", path, null, {})).status).toBe(401);
    const bea = await route(
      "POST",
      path,
      { login: "bea-gh", name: "Bea Example" },
      {},
    );
    expect(bea.status).toBe(403);
    const ok = await route("POST", path, alex, {});
    expect(ok.status).toBe(200);
    expect(status(grant.id)).toBe("active");
    expect(await callAcme("/v1", "DELETE")).toMatchObject({ status: 200 });
  });

  /** A run grant claimed by live run `runId`. */
  const claimedRun = async (credentialId: string, runId: string) => {
    kc.__mintGrantForTest({
      credentialId,
      sessionId: "s-1",
      requestedBy: "Sam",
      mode: "run",
      run: { command: "bun sync.ts", maxCalls: 500 },
    });
    const claim = await kc.claimRunGrants({
      sessionId: "s-1",
      credentials: ["acme-api"],
      command: "bun sync.ts",
      runId,
      deadline: Date.now() + 3_600_000,
    });
    if ("error" in claim) throw new Error(claim.error);
    return claim.claims[0]!.grant;
  };

  test("a run paused mid-run is refused, and its grant closes when the run ends", async () => {
    const meta = add({ allowedMethods: ["GET"] });
    const grant = await claimedRun(meta.id, "kr-live");
    await kc.patchCredentialAsync(meta.id, "Alex", {
      allowedMethods: ["GET", "POST"],
    });
    expect(status(grant.id)).toBe("suspended");
    expect(kc.useRunGrant(grant.id, "kr-live", "GET", "/v1")).toEqual({
      error: expect.stringMatching(/suspended/),
      status: 403,
    });
    await kc.settleRunGrants("kr-live", [{ grantId: grant.id, calls: 12 }]);
    expect(status(grant.id)).toBe("used");
    await expect(kc.resumeGrantAsync(grant.id, "Alex")).rejects.toThrow(
      /run has ended/,
    );
    expect(status(grant.id)).toBe("used");
  });

  test("boot closes a paused run grant whose run is gone", async () => {
    const meta = add({ allowedMethods: ["GET"] });
    const grant = await claimedRun(meta.id, "kr-gone");
    await kc.patchCredentialAsync(meta.id, "Alex", { allowedMethods: [] });
    expect(status(grant.id)).toBe("suspended");
    expect(await kc.settleOrphanRunGrants(() => false)).toBe(1);
    const after = kc.listGrants().find((g) => g.id === grant.id)!;
    expect(after).toMatchObject({ status: "used", interrupted: true });
    await expect(kc.resumeGrantAsync(grant.id, "Alex")).rejects.toThrow(
      /run has ended/,
    );
  });

  test("a paused run grant whose run is still going can be allowed again", async () => {
    const meta = add({ allowedMethods: ["GET"] });
    const grant = await claimedRun(meta.id, "kr-live");
    await kc.patchCredentialAsync(meta.id, "Alex", { allowedMethods: [] });
    expect(await kc.settleOrphanRunGrants(() => true)).toBe(0);
    await kc.resumeGrantAsync(grant.id, "Alex");
    expect(kc.useRunGrant(grant.id, "kr-live", "DELETE", "/v1")).toHaveProperty(
      "credential",
    );
  });

  test("a paused grant can be revoked, and expires like any other", async () => {
    const meta = add({ allowedMethods: ["GET"] });
    const a = standing(meta.id);
    const b = kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "s-2",
      requestedBy: "Sam",
      mode: "standing",
      expiresAt: new Date(Date.now() + 50).toISOString(),
    });
    await kc.patchCredentialAsync(meta.id, "Alex", { allowedMethods: [] });
    expect(kc.revokeGrant(a.id, "Alex")).toEqual({ ok: true });
    expect(status(a.id)).toBe("revoked");
    await Bun.sleep(60);
    expect(status(b.id)).toBe("expired");
    expect(kc.resumeGrantAsync(b.id, "Alex")).rejects.toThrow(/expired/);
  });
});

describe("where a credential is lent", () => {
  test("each project whose access lends it to an incident role", () => {
    const lent = lendingByCredential([
      {
        project: "acme-todo",
        access: {
          credentials: [
            { credential: "kc-1", roles: { investigator: "standing" } },
            { credential: "kc-2", roles: {} },
          ],
        },
      },
      {
        project: "acme-web",
        access: {
          credentials: [{ credential: "kc-1", roles: { verifier: "once" } }],
        },
      },
    ]);
    expect(lent.get("kc-1")).toEqual([
      { project: "acme-todo", roles: { investigator: "standing" } },
      { project: "acme-web", roles: { verifier: "once" } },
    ]);
    // Listed but lent to no role: not lent.
    expect(lent.get("kc-2")).toBeUndefined();
  });

  test("GET /api/keychain carries it, and still answers without projects", async () => {
    const meta = add();
    __setKeychainProjectsForTest(async () => [
      {
        project: "acme-todo",
        access: {
          credentials: [
            { credential: meta.id, roles: { investigator: "once" } },
          ],
        },
      },
    ]);
    const url = new URL("/api/keychain", "https://os.example.test");
    const get = () =>
      handleKeychainRoutes({
        path: url.pathname,
        url,
        publicPrefix: "",
        authUser: alex,
        req: new Request(url),
      }) as Promise<Response>;
    const body = await (await get()).json();
    expect(body.credentials[0].lentIn).toEqual([
      { project: "acme-todo", roles: { investigator: "once" } },
    ]);
    __setKeychainProjectsForTest(async () => {
      throw new Error("catalog unavailable");
    });
    const fallback = await get();
    expect(fallback.status).toBe(200);
    expect((await fallback.json()).credentials[0].lentIn).toBeUndefined();
    __setKeychainProjectsForTest(undefined);
  });
});

describe("header and scheme", () => {
  const sent = async () => {
    await testCredential({
      by: "Alex",
      credentialId: kc.findCredential("acme-api")!.id,
      net,
    });
    return new Headers(seen.at(-1)!.init.headers);
  };

  test("Basic with user:password is sent base64-encoded", async () => {
    add({
      secret: "qa:pa55",
      injection: { header: "Authorization", scheme: "Basic" },
    });
    expect((await sent()).get("authorization")).toBe(
      `Basic ${Buffer.from("qa:pa55").toString("base64")}`,
    );
  });

  test("Basic with an encoded value, Token, and no scheme are sent as given", async () => {
    const meta = add({
      secret: "dXNlcjpwYXNz",
      injection: { header: "Authorization", scheme: "Basic" },
    });
    expect((await sent()).get("authorization")).toBe("Basic dXNlcjpwYXNz");
    await kc.patchCredentialAsync(meta.id, "Alex", {
      injection: { header: "Authorization", scheme: "Token" },
    });
    expect((await sent()).get("authorization")).toBe("Token dXNlcjpwYXNz");
    await kc.patchCredentialAsync(meta.id, "Alex", {
      injection: { header: "X-Api-Key", scheme: "" },
    });
    expect((await sent()).get("x-api-key")).toBe("dXNlcjpwYXNz");
  });

  test("the Basic encoding is scrubbed from what comes back", () => {
    const encoded = Buffer.from("qa:pa55").toString("base64");
    expect(kc.scrubSecret(`echo ${encoded}`, "qa:pa55")).toBe(
      "echo [redacted]",
    );
  });
});
