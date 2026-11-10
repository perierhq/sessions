/**
 * Bark: the message for each notification kind, encryption the Bark app can
 * decrypt, masked settings, the public-https-only server, signed-in routes,
 * no send while off, the retry rules, the test route, and the wiring through
 * deliverNotification. Runs on the in-memory kernel store with the pinned
 * fetch's resolver and transport replaced; nothing leaves the process.
 *
 * Test keys are built at runtime from short, obviously fake seeds.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createDecipheriv, createHash, type DecipherGCM } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  NotificationEvent,
  NotificationThread,
} from "./notification-threads";

const root = mkdtempSync(join(tmpdir(), "bark-test-"));
const saved = {
  state: process.env.OPENSESSION_STATE_DIR,
  secrets: process.env.OPENSESSION_WORKSPACE_SECRETS_STORE,
  ui: process.env.OPENSESSION_UI_BASE,
};
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(root, "secrets.json");
process.env.OPENSESSION_UI_BASE = "https://sessions.example.test";

const webPushes: Array<Record<string, unknown>> = [];
mock.module("./push", () => ({
  sendPushToUser: async (_user: string, payload: Record<string, unknown>) => {
    webPushes.push(payload);
  },
  pushTopic: (threadId: string) =>
    createHash("sha256").update(threadId).digest("base64url").slice(0, 32),
}));

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const bark = await import("./bark");
const { deliverNotification } = await import("./notifications");
const { updateSupervisorBark } = await import("./supervisor-inbox");
const { handleSupervisorRoutes } = await import("./routes/supervisor");

/** A fake key of `length` characters, repeating `seed`. */
const fakeKey = (seed: string, length: number) =>
  seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
const DEVICE_KEY = `Test${fakeKey("Device", 19)}`;
const OTHER_DEVICE_KEY = `Other${fakeKey("Device", 11)}`;
const KEYS = {
  AES128: fakeKey("0123456789abcdef", 16),
  AES192: fakeKey("0123456789abcdef", 24),
  AES256: fakeKey("0123456789abcdef", 32),
} as const;
const BASE = "https://sessions.example.test";
/** CryptoSwift 1.8.4 (Bark's pinned version) output for the GCM test below;
 *  the same program reproduces Bark's published CBC vector. */
const GCM_VECTOR =
  "Eu691r+JCPFZPrx0b/0rHyVezj2Vog00esccpvA9rYcJ8oCdDjCXwCMJ+c9gs+6uviLd3c83GJz8gt8lkTlc0JC2uycM6fa4Kqc=";
/** A signed-in person, as web-auth.ts sets it. */
const ADA = { login: "ada", name: "Ada" };

let store: InstanceType<typeof SessionKernelStore>;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;
let requests: Array<{ url: string; body: Record<string, string> }> = [];
/** What each send answers: a status, or an error to throw. */
let answers: Array<number | Error> = [];
let resolved: string[] = ["203.0.113.10"];
let restoreTiming = () => {};
let restoreNet = () => {};

beforeEach(() => {
  rmSync(join(root, "secrets.json"), { force: true });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  requests = [];
  answers = [];
  resolved = ["203.0.113.10"];
  webPushes.length = 0;
  restoreTiming = bark.__setBarkTimingForTest({
    timeoutMs: 1_000,
    retryDelaysMs: [0, 0],
  });
  restoreNet = bark.__setBarkNetForTest({
    resolve: async () => resolved,
    send: async (target, init) => {
      requests.push({
        url: target.url.href,
        body: JSON.parse(String(init.body ?? "{}")),
      });
      const answer = answers.shift() ?? 200;
      if (answer instanceof Error) throw answer;
      return {
        status: answer,
        headers: new Headers({
          "content-type": "application/json",
          ...(answer >= 300 && answer < 400
            ? { location: "https://elsewhere.example.test/" }
            : {}),
        }),
        body: new TextEncoder().encode(JSON.stringify({ code: answer })),
      };
    },
  });
});

afterEach(() => {
  restoreNet();
  restoreTiming();
  __setSessionKernelStoreForTest(previousStore);
  store.close?.();
});

afterAll(() => {
  for (const [key, value] of [
    ["OPENSESSION_STATE_DIR", saved.state],
    ["OPENSESSION_WORKSPACE_SECRETS_STORE", saved.secrets],
    ["OPENSESSION_UI_BASE", saved.ui],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  authUser: { login: string; name: string } | null = ADA,
) {
  const url = new URL(`http://localhost${path}`);
  const response = await handleSupervisorRoutes({
    req: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser,
  });
  if (!response) throw new Error(`no route for ${method} ${path}`);
  return { status: response.status, json: (await response.json()) as any };
}

function thread(
  overrides: Partial<NotificationThread> & Pick<NotificationThread, "kind">,
): NotificationThread {
  return {
    id: "supervisor:si-1",
    subject: { type: "supervisor", id: "si-1", title: "Agent title" },
    reason: "Needs you",
    url: "/session/os-sup?item=si-1",
    unread: true,
    done: false,
    updatedAt: 1,
    ...overrides,
  } as NotificationThread;
}

function event(
  kind: NotificationEvent["kind"],
  push?: NotificationEvent["push"],
): NotificationEvent {
  return {
    kind,
    subject: { type: "supervisor", id: "si-1", title: "Agent title" },
    reason: "Needs you",
    url: "/session/os-sup?item=si-1",
    ...(push ? { push } : {}),
  };
}

const payload = { title: "Needs you", body: "acme: a decision is waiting" };

const opts = { sealed: false, base: BASE } as const;

describe("message mapping", () => {
  test("a supervisor decision opens the item in Blob", () => {
    const message = bark.barkMessageFor(
      thread({
        kind: "supervisor_needs_you",
        subject: {
          type: "supervisor",
          id: "si-1",
          title: "Agent title",
          context: "acme",
        },
      }),
      event("supervisor_needs_you"),
      "alert",
      payload,
      opts,
    );
    expect(message).toEqual({
      title: "Needs you",
      body: "acme: a decision is waiting",
      level: "active",
      group: "acme",
      url: "blob://item/si-1",
      icon: `${BASE}/apple-touch-icon.png`,
      isArchive: "1",
    });
  });

  test("openIn web sends the absolute web URL instead", () => {
    const message = bark.barkMessageFor(
      thread({ kind: "supervisor_needs_you" }),
      event("supervisor_needs_you"),
      "alert",
      payload,
      { ...opts, openIn: "web" },
    );
    expect(message.url).toBe(`${BASE}/session/os-sup?item=si-1`);
  });

  test("something down is critical; without a project the group is Blob", () => {
    const message = bark.barkMessageFor(
      thread({ kind: "supervisor_needs_you" }),
      event("supervisor_needs_you", { body: "x", urgency: "high" }),
      "alert",
      payload,
      opts,
    );
    expect(message.level).toBe("critical");
    expect(message.group).toBe("Blob");
  });

  test("levels follow the push urgency", () => {
    const incident = thread({
      id: "incident:inc-1",
      kind: "incident_needs_you",
      subject: { type: "incident", id: "inc-1", title: "x", context: "acme" },
      url: "/incidents/inc-1",
    });
    const level = (
      urgency: "high" | "low" | undefined,
      delivery: "alert" | "replace" = "alert",
    ) =>
      bark.barkLevel(
        incident,
        { push: urgency ? { urgency } : undefined },
        delivery,
      );
    // A veto (high) is time sensitive, never critical outside supervisor.
    expect(level("high")).toBe("timeSensitive");
    expect(level("low")).toBe("passive");
    expect(level(undefined)).toBe("active");
    expect(level("high", "replace")).toBe("passive");
    const message = bark.barkMessageFor(
      incident,
      event("incident_needs_you", { body: "x", urgency: "high" }),
      "alert",
      {
        title: "Needs you",
        body: "acme · Approve the fix",
        url: "/incidents/inc-1",
      },
      opts,
    );
    expect(message.url).toBe(`${BASE}/incidents/inc-1`);
    expect(message.group).toBe("acme");
  });

  test("in clear, a kind without fixed copy says only its kind", () => {
    const mention = thread({
      id: "session:s-1",
      kind: "comment",
      subject: {
        type: "session",
        id: "s-1",
        title: "Secret plan",
        context: "acme",
      },
      url: "/session/s-1",
    });
    const written = { title: "Bob commented", body: "The secret plan is…" };
    const clear = bark.barkMessageFor(
      mention,
      event("comment"),
      "alert",
      written,
      opts,
    );
    expect(clear).toMatchObject({
      title: "New comment",
      body: bark.BARK_GENERIC_BODY,
      group: "Sessions",
      url: `${BASE}/session/s-1`,
    });
    expect(JSON.stringify(clear)).not.toContain("ecret");
    const reminder = bark.barkMessageFor(
      thread({ ...mention, kind: "reminder" }),
      event("reminder"),
      "alert",
      written,
      opts,
    );
    expect(reminder.title).toBe("Reminder");
    // Sealed, the normal copy is fine.
    const sealed = bark.barkMessageFor(
      mention,
      event("comment"),
      "alert",
      written,
      { ...opts, sealed: true },
    );
    expect(sealed).toMatchObject({ title: "Bob commented", group: "acme" });
  });

  test("no icon when the instance is not on https", () => {
    const message = bark.barkMessageFor(
      thread({
        kind: "review_requested",
        subject: { type: "pr", id: "1", title: "t" },
        url: "/pr/1",
      }),
      event("review_requested"),
      "alert",
      { title: "t", url: "/pr/1" },
      { sealed: false, base: "http://127.0.0.1:3850" },
    );
    expect(message.icon).toBeUndefined();
    expect(message.group).toBe("Sessions");
  });
});

function decrypt(
  ciphertext: string,
  iv: string,
  algorithm: keyof typeof bark.BARK_ALGORITHMS,
  mode: "CBC" | "GCM",
  key: string,
): string {
  const bits = bark.BARK_ALGORITHMS[algorithm] * 8;
  const data = Buffer.from(ciphertext, "base64");
  if (mode === "GCM") {
    const decipher = createDecipheriv(
      `aes-${bits}-gcm`,
      Buffer.from(key),
      Buffer.from(iv),
    );
    // Bark's GCM(.combined): the 16-byte tag follows the ciphertext.
    (decipher as DecipherGCM).setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }
  const decipher = createDecipheriv(
    `aes-${bits}-cbc`,
    Buffer.from(key),
    Buffer.from(iv),
  );
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

describe("encryption", () => {
  test("matches Bark's documented example (AES128 CBC)", () => {
    // docs/en-us/encryption.md in Finb/Bark: key 1234567890123456, iv
    // 1111111111111111.
    const sealed = bark.encryptForBark(
      '{"body": "test", "sound": "birdsong"}',
      { algorithm: "AES128", mode: "CBC", key: fakeKey("1234567890", 16) },
      fakeKey("1", 16),
    );
    expect(sealed.ciphertext).toBe(
      "d3QhjQjP5majvNt5CjsvFWwqqj2gKl96RFj5OO+u6ynTt7lkyigDYNA3abnnCLpr",
    );
  });

  test("matches CryptoSwift 1.8.4 as Bark calls it (AES256 GCM)", () => {
    // Produced by AES(key: key.bytes, blockMode: GCM(iv: iv.bytes, mode:
    // .combined), padding: .noPadding).encrypt(...).toBase64(), the calls
    // in Bark's Model/Algorithm.swift L90, L108, L112.
    const sealed = bark.encryptForBark(
      '{"title":"Needs you","body":"acme: a decision is waiting"}',
      { algorithm: "AES256", mode: "GCM", key: KEYS.AES256 },
      "abcdefghijkl",
    );
    expect(sealed.ciphertext).toBe(GCM_VECTOR);
  });

  test("ECB is not offered", () => {
    expect(bark.BARK_MODES).toEqual(["GCM", "CBC"]);
    expect(
      bark.validateBarkPatch({
        encryption: { algorithm: "AES128", mode: "ECB", key: KEYS.AES128 },
      }),
    ).toEqual({ error: "Choose GCM or CBC" });
  });

  for (const algorithm of ["AES128", "AES192", "AES256"] as const)
    for (const mode of ["GCM", "CBC"] as const)
      test(`${algorithm} ${mode} round-trips the whole message`, () => {
        const message = {
          title: "Needs you",
          body: "acme: a decision is waiting",
          level: "timeSensitive" as const,
          group: "acme",
          url: "blob://item/si-1",
          isArchive: "1" as const,
        };
        const body = bark.barkRequestBody(DEVICE_KEY, message, {
          encryption: { algorithm, mode, key: KEYS[algorithm] },
          collapseId: "abc",
        });
        expect(Object.keys(body).sort()).toEqual([
          "ciphertext",
          "device_key",
          "id",
          "iv",
        ]);
        expect(body.iv).toHaveLength(mode === "GCM" ? 12 : 16);
        // GCM is unpadded: ciphertext + 16-byte tag, no block rounding.
        if (mode === "GCM")
          expect(Buffer.from(body.ciphertext!, "base64").length).toBe(
            Buffer.byteLength(JSON.stringify(message)) + 16,
          );
        expect(
          JSON.parse(
            decrypt(
              body.ciphertext!,
              body.iv!,
              algorithm,
              mode,
              KEYS[algorithm],
            ),
          ),
        ).toEqual(message);
      });
});

describe("settings", () => {
  test("GET masks the device key; it is stored only as a secret", async () => {
    const put = await call("PUT", "/api/supervisor/bark", {
      deviceKey: DEVICE_KEY,
      enabled: true,
      encryption: { algorithm: "AES256", mode: "GCM", key: KEYS.AES256 },
    });
    expect(put.status).toBe(200);
    const got = await call("GET", "/api/supervisor/bark");
    expect(got.json).toEqual({
      bark: {
        enabled: true,
        serverUrl: "https://api.day.app",
        openIn: "blob",
        deviceKey: `••••${DEVICE_KEY.slice(-4)}`,
        encryption: { algorithm: "AES256", mode: "GCM" },
      },
    });
    expect(JSON.stringify(got.json)).not.toContain(DEVICE_KEY);
    expect(JSON.stringify(put.json)).not.toContain(DEVICE_KEY);
    expect(JSON.stringify(got.json)).not.toContain(KEYS.AES128);
    const secrets = readFileSync(join(root, "secrets.json"), "utf8");
    expect(secrets).toContain(DEVICE_KEY);
  });

  test("only a signed-in person reaches the routes", async () => {
    const claimed = { user: "Ada", deviceKey: DEVICE_KEY };
    expect(
      (await call("PUT", "/api/supervisor/bark", claimed, null)).status,
    ).toBe(401);
    expect(
      (await call("GET", "/api/supervisor/bark?user=Ada", undefined, null))
        .status,
    ).toBe(401);
    expect(
      (await call("POST", "/api/supervisor/bark/test", { user: "Ada" }, null))
        .status,
    ).toBe(401);
    const automation = { login: "bot", name: "Bot", automation: true };
    expect(
      (await call("GET", "/api/supervisor/bark", undefined, automation)).status,
    ).toBe(401);
    expect(requests).toHaveLength(0);
  });

  test("the server must be public https", async () => {
    for (const serverUrl of [
      "http://bark.example.test",
      "https://user:pw@bark.example.test",
      "https://bark.example.test/?q=1",
      "https://localhost",
      "https://127.0.0.1",
      "https://100.100.1.2",
      "https://bark.tailnet.ts.net",
      "https://bark",
      "not a url",
    ]) {
      const put = await call("PUT", "/api/supervisor/bark", { serverUrl });
      expect(put.status).toBe(400);
    }
    const ok = await call("PUT", "/api/supervisor/bark", {
      serverUrl: "https://bark.example.test/",
    });
    expect(ok.json.bark.serverUrl).toBe("https://bark.example.test");
  });

  test("openIn is saved and checked", async () => {
    const put = await call("PUT", "/api/supervisor/bark", { openIn: "web" });
    expect(put.json.bark.openIn).toBe("web");
    expect(
      (await call("PUT", "/api/supervisor/bark", { openIn: "app" })).status,
    ).toBe(400);
  });

  test("turning on needs a key; a wrong-length encryption key is refused", async () => {
    expect(
      (await call("PUT", "/api/supervisor/bark", { enabled: true })).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/api/supervisor/bark", {
          encryption: { algorithm: "AES256", mode: "GCM", key: "short" },
        })
      ).status,
    ).toBe(400);
    // A new algorithm needs a new key.
    expect(
      (
        await call("PUT", "/api/supervisor/bark", {
          encryption: { algorithm: "AES128", mode: "GCM" },
        })
      ).status,
    ).toBe(400);
  });

  test("replacing or clearing a key deletes the old secret", async () => {
    await call("PUT", "/api/supervisor/bark", { deviceKey: DEVICE_KEY });
    await call("PUT", "/api/supervisor/bark", { deviceKey: OTHER_DEVICE_KEY });
    let secrets = readFileSync(join(root, "secrets.json"), "utf8");
    expect(secrets).not.toContain(DEVICE_KEY);
    expect(secrets).toContain(OTHER_DEVICE_KEY);
    const cleared = await call("PUT", "/api/supervisor/bark", {
      deviceKey: null,
    });
    expect(cleared.json.bark).toMatchObject({
      deviceKey: null,
      enabled: false,
    });
    secrets = readFileSync(join(root, "secrets.json"), "utf8");
    expect(secrets).not.toContain(OTHER_DEVICE_KEY);
  });
});

describe("sending", () => {
  const supervisorThread = thread({ kind: "supervisor_needs_you" });
  const send = () =>
    bark.sendBarkNotification(
      "Ada",
      supervisorThread,
      event("supervisor_needs_you"),
      "alert",
      payload,
    );
  const turnOn = (extra: Record<string, unknown> = {}) =>
    call("PUT", "/api/supervisor/bark", {
      deviceKey: DEVICE_KEY,
      enabled: true,
      ...extra,
    });
  const connectError = (code: string) =>
    Object.assign(new Error(code), { code });

  test("nothing is sent while Bark is off", async () => {
    await call("PUT", "/api/supervisor/bark", {
      deviceKey: DEVICE_KEY,
      enabled: false,
    });
    await send();
    expect(requests).toHaveLength(0);
  });

  test("sends to <server>/push in clear without an encryption key", async () => {
    await turnOn({ serverUrl: "https://bark.example.test" });
    await bark.sendBarkNotification(
      "ada",
      supervisorThread,
      event("supervisor_needs_you"),
      "alert",
      payload,
      "collapse",
    );
    expect(requests).toEqual([
      {
        url: "https://bark.example.test/push",
        body: {
          device_key: DEVICE_KEY,
          title: "Needs you",
          body: "acme: a decision is waiting",
          level: "active",
          group: "Blob",
          url: "blob://item/si-1",
          icon: `${BASE}/apple-touch-icon.png`,
          isArchive: "1",
          id: "collapse",
        },
      },
    ]);
  });

  test("a server that resolves to a private address gets nothing", async () => {
    await turnOn({ serverUrl: "https://bark.example.test" });
    resolved = ["10.0.0.5"];
    await send();
    expect(requests).toHaveLength(0);
    expect((await call("POST", "/api/supervisor/bark/test", {})).status).toBe(
      502,
    );
    expect(requests).toHaveLength(0);
  });

  test("a saved server that no longer passes is refused at send time", async () => {
    await turnOn();
    await updateSupervisorBark("Ada", (raw) => ({
      ...raw,
      serverUrl: "https://127.0.0.1",
    }));
    await send();
    expect(requests).toHaveLength(0);
  });

  test("retries 429, 5xx and refused connections, nothing else", async () => {
    await turnOn();
    answers = [500, 200];
    await send();
    expect(requests).toHaveLength(2);
    requests = [];
    answers = [429, 503, 500, 500];
    await send();
    expect(requests).toHaveLength(3);
    requests = [];
    answers = [connectError("ECONNREFUSED"), 200];
    await send();
    expect(requests).toHaveLength(2);
    for (const answer of [
      400,
      408,
      connectError("ECONNRESET"),
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    ]) {
      requests = [];
      answers = [answer, 200];
      await send();
      expect(requests).toHaveLength(1);
    }
  });

  test("a redirect is refused, not followed", async () => {
    await turnOn();
    answers = [302, 200];
    const result = await bark.sendBarkTest("Ada");
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(1);
  });

  test("the test route sends the fixed test push, even while off", async () => {
    expect((await call("POST", "/api/supervisor/bark/test", {})).status).toBe(
      400,
    );
    await call("PUT", "/api/supervisor/bark", { deviceKey: DEVICE_KEY });
    const sent = await call("POST", "/api/supervisor/bark/test", {});
    expect(sent).toEqual({ status: 200, json: { ok: true } });
    expect(requests[0]!.body).toMatchObject({
      device_key: DEVICE_KEY,
      ...bark.BARK_TEST_MESSAGE,
      isArchive: "1",
    });
    answers = [400];
    expect((await call("POST", "/api/supervisor/bark/test", {})).status).toBe(
      502,
    );
  });

  test("deliverNotification starts Bark without waiting; same alert as Web Push", async () => {
    await turnOn({
      encryption: { algorithm: "AES128", mode: "CBC", key: KEYS.AES128 },
    });
    await deliverNotification("Ada", {
      kind: "supervisor_needs_you",
      subject: {
        type: "supervisor",
        id: "si-9",
        title: "Customer wrote something",
        context: "acme",
      },
      reason: "Needs you",
      body: "1. Refund  2. Decline",
      url: "/session/os-sup?item=si-9",
      eventKey: "si-9:1",
      push: { body: "acme: a decision is waiting" },
    });
    expect(webPushes).toHaveLength(1);
    for (let i = 0; i < 100 && requests.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    expect(body.title).toBeUndefined();
    const message = JSON.parse(
      decrypt(body.ciphertext!, body.iv!, "AES128", "CBC", KEYS.AES128),
    );
    expect(message).toMatchObject({
      title: webPushes[0]!.title,
      body: "acme: a decision is waiting",
      level: "active",
      group: "acme",
      url: "blob://item/si-9",
    });
    // Fixed copy only: the agent's title and options never leave.
    expect(JSON.stringify(message)).not.toContain("Customer");
    expect(JSON.stringify(message)).not.toContain("Refund");
  });

  test("a slow Bark server does not hold up deliverNotification", async () => {
    await turnOn();
    let release = () => {};
    restoreNet();
    restoreNet = bark.__setBarkNetForTest({
      resolve: async () => resolved,
      send: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 200,
              headers: new Headers(),
              body: new Uint8Array(),
            });
        }),
    });
    const thread = await deliverNotification("Ada", {
      kind: "supervisor_needs_you",
      subject: { type: "supervisor", id: "si-10", title: "t" },
      reason: "Needs you",
      url: "/session/os-sup?item=si-10",
      eventKey: "si-10:1",
      push: { body: "A decision is waiting" },
    });
    expect(thread).not.toBeNull();
    expect(webPushes).toHaveLength(1);
    release();
  });
});
