/**
 * Per-credential usage: each brokered call is audited after its response,
 * with its outcome and the credential it used, and the credential keeps
 * when it was last used and by which session.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = join(mkdtempSync(join(tmpdir(), "kc-usage-")), "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

const events: Array<Record<string, unknown>> = [];
const realAudit = await import("./audit");
mock.module("./audit", () => ({
  ...realAudit,
  audit: (event: Record<string, unknown>) => events.push(event),
  auditAsync: (event: Record<string, unknown>) => events.push(event),
}));

const kc = await import("./keychain");
const { brokerCall } = await import("./keychain-broker");
const { fetchBackedNet } = await import("./testing/pinned-fetch-double");

const SECRET = "sk-usage-secret-1234";

function reset(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}

let reply: () => Response = () => new Response("[1,2,3]", { status: 200 });
const net = fetchBackedNet(async () => reply());

beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  reset();
  events.length = 0;
  reply = () => new Response("[1,2,3]", { status: 200 });
});
afterEach(reset);

function setup(over: Partial<Parameters<typeof kc.addCredential>[0]> = {}) {
  const meta = kc.addCredential({
    owner: "Alex",
    service: "acme-api",
    host: "api.example.test",
    secret: SECRET,
    ...over,
  });
  kc.__mintGrantForTest({
    credentialId: meta.id,
    sessionId: "s-1",
    requestedBy: "Sam",
    mode: "standing",
  });
  return meta;
}

const call = (over: Partial<Parameters<typeof brokerCall>[0]> = {}) =>
  brokerCall({
    sessionId: "s-1",
    credential: "acme-api",
    method: "GET",
    path: "/v1/items?page=2",
    requestedBy: "Sam",
    net,
    ...over,
  });

const ofKind = (kind: string) => events.filter((e) => e.kind === kind);

describe("broker audit", () => {
  test("one line per call, after the response, with its outcome", async () => {
    const meta = setup();
    reply = () => new Response("nope", { status: 429 });
    await call();
    const lines = ofKind("keychain_broker_call");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      credential_id: meta.id,
      service: "acme-api",
      session_id: "s-1",
      method: "GET",
      path: "/v1/items",
      status: 429,
      requested_by: "Sam",
    });
    expect(typeof lines[0]!.duration_ms).toBe("number");
    expect(lines[0]!.bytes).toBe(4);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  test("a call that fails on the way records why", async () => {
    setup();
    reply = () => {
      throw new Error("socket hang up");
    };
    await call();
    expect(ofKind("keychain_broker_call")[0]).toMatchObject({
      error: "the request to api.example.test failed",
    });
  });

  test("a refused call names the credential and the reason", async () => {
    const meta = setup({ allowedPathPrefixes: ["/v1/orders"] });
    await call();
    expect(ofKind("keychain_broker_call")).toHaveLength(0);
    expect(ofKind("keychain_broker_denied")[0]).toMatchObject({
      credential_id: meta.id,
      service: "acme-api",
      requested_by: "Sam",
      reason: expect.stringMatching(/prefixes/),
    });
  });

  test("no grant is a refusal on the record too", async () => {
    const meta = kc.addCredential({
      owner: "Alex",
      service: "acme-api",
      host: "api.example.test",
      secret: SECRET,
    });
    await call();
    expect(ofKind("keychain_broker_denied")[0]).toMatchObject({
      credential_id: meta.id,
      reason: expect.stringMatching(/no live grant/),
    });
  });
});

describe("last used", () => {
  test("a call records when, which session and its status", async () => {
    const meta = setup();
    expect(kc.findCredential(meta.id)?.lastUsed).toBeUndefined();
    await call();
    expect(kc.findCredential(meta.id)?.lastUsed).toMatchObject({
      sessionId: "s-1",
      by: "Sam",
      status: 200,
    });
    // An edit keeps it.
    await kc.patchCredentialAsync(meta.id, "Alex", { description: "Orders" });
    expect(kc.findCredential(meta.id)?.lastUsed?.sessionId).toBe("s-1");
  });

  test("a busy credential still saves its last use once a minute", async () => {
    const meta = setup();
    const saved = () =>
      JSON.parse(readFileSync(STORE, "utf8")).credentials.find(
        (c: { id: string }) => c.id === meta.id,
      )?.lastUsed?.at;
    const start = Date.now();
    const at = (ms: number) => new Date(start + ms).toISOString();
    const useAt = async (ms: number) => {
      setSystemTime(new Date(start + ms));
      kc.recordCredentialUse(meta.id, { sessionId: "s-1", status: 200 });
      // Let any write it started land before the next call.
      await Bun.sleep(40);
    };
    try {
      await useAt(0);
      expect(saved()).toBe(at(0));
      // Within a minute of the last save: rides along with the next write.
      await useAt(30_000);
      expect(saved()).toBe(at(0));
      // A minute after the last save, though only 30s after the last call.
      await useAt(60_000);
      expect(saved()).toBe(at(60_000));
      await useAt(90_000);
      expect(saved()).toBe(at(60_000));
      await useAt(120_000);
      expect(saved()).toBe(at(120_000));
    } finally {
      setSystemTime();
    }
  });

  test("a refused call is not a use", async () => {
    const meta = setup({ allowedMethods: ["GET"] });
    await call({ method: "DELETE" });
    expect(kc.findCredential(meta.id)?.lastUsed).toBeUndefined();
  });
});
