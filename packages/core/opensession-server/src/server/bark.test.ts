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
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const barkSound = await import("./bark-sound");
const { deliverNotification, markNotifications } =
  await import("./notifications");
const { handleBlobSpeechRoutes } = await import("./routes/blob-speech");
const {
  updateSupervisorBark,
  postSupervisorItem,
  __setSupervisorInboxDepsForTest,
} = await import("./supervisor-inbox");
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
const BLOB_ICON = `${BASE}/bot-icon/blob-notification-v1.png`;
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
let restoreSound = () => {};
let restoreInbox = () => {};
/** Texts the fake speech service was asked to say. */
let spoken: string[] = [];

beforeEach(() => {
  rmSync(join(root, "secrets.json"), { force: true });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  requests = [];
  answers = [];
  resolved = ["203.0.113.10"];
  webPushes.length = 0;
  spoken = [];
  // No ffmpeg, no Fish key: speech is unavailable unless a test says so.
  restoreSound = barkSound.__setBarkSoundDepsForTest({
    ffmpeg: "ffmpeg-missing-for-test",
    speech: async () => ({ configured: false, voice: "test-voice" }),
  });
  // Pushes a posted item would start stay out of these tests.
  restoreInbox = __setSupervisorInboxDepsForTest({
    notify: async () => null,
    markDone: async () => {},
    supervisorSessionId: async () => "os-sup",
    ensureWatch: async () => undefined,
  });
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
  restoreSound();
  restoreInbox();
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
      subtitle: "acme",
      body: "acme: a decision is waiting",
      level: "active",
      group: "acme",
      url: "blob://item/si-1",
      icon: BLOB_ICON,
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
        // The id rides inside too: Bark files the history entry under it.
        const sealed = { ...message, id: "abc" };
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
            Buffer.byteLength(JSON.stringify(sealed)) + 16,
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
        ).toEqual(sealed);
        expect(body.id).toBe("abc");
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
        speak: false,
        speakAvailable: false,
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
          icon: BLOB_ICON,
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
    let release: (() => void) | undefined;
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
    // Let the held send arrive and finish inside this test.
    for (let i = 0; i < 200 && !release; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    release?.();
  });
});

/** Wait until `count` Bark requests went out (they run without waiting). */
async function requestsSettle(count: number): Promise<void> {
  for (let i = 0; i < 200 && requests.length < count; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("what each push carries", () => {
  const turnOn = (extra: Record<string, unknown> = {}) =>
    call("PUT", "/api/supervisor/bark", {
      deviceKey: DEVICE_KEY,
      enabled: true,
      ...extra,
    });
  const supervisorThread = thread({
    kind: "supervisor_needs_you",
    subject: {
      type: "supervisor",
      id: "si-1",
      title: "Agent title",
      context: "acme",
    },
  });

  test("Blob's icon on Blob's pushes, the instance's on the rest", () => {
    const icon = (t: NotificationThread) =>
      bark.barkMessageFor(t, event(t.kind), "alert", payload, opts).icon;
    expect(icon(supervisorThread)).toBe(BLOB_ICON);
    const session = thread({
      id: "session:s-1",
      kind: "mention",
      subject: { type: "session", id: "s-1", title: "t" },
      url: "/session/s-1",
    });
    expect(icon(session)).toBe(`${BASE}/apple-touch-icon.png`);
    expect(icon({ ...session, actor: "Blob" })).toBe(BLOB_ICON);
  });

  test("the project is the subtitle; in clear a plain kind has none", () => {
    const comment = thread({
      id: "session:s-1",
      kind: "comment",
      subject: { type: "session", id: "s-1", title: "Plan", context: "acme" },
      url: "/session/s-1",
    });
    const written = { title: "Bob commented", body: "The plan is…" };
    const clear = bark.barkMessageFor(
      comment,
      event("comment"),
      "alert",
      written,
      opts,
    );
    expect(clear.subtitle).toBeUndefined();
    expect(clear.markdown).toBeUndefined();
    expect(clear.ttl).toBeUndefined();
    expect(clear.badge).toBeUndefined();
    const sealed = bark.barkMessageFor(
      comment,
      event("comment"),
      "alert",
      written,
      { ...opts, sealed: true },
    );
    expect(sealed.subtitle).toBe("acme");
    const supervisor = bark.barkMessageFor(
      supervisorThread,
      event("supervisor_needs_you"),
      "alert",
      payload,
      opts,
    );
    // The title stays the fixed one.
    expect(supervisor).toMatchObject({ title: "Needs you", subtitle: "acme" });
  });

  test("the badge counts open needs-you items, on supervisor pushes only", () => {
    const badge = (t: NotificationThread, count: number) =>
      bark.barkMessageFor(t, event(t.kind), "alert", payload, {
        ...opts,
        badge: count,
      }).badge;
    expect(badge(supervisorThread, 3)).toBe("3");
    // Bark's 0 also clears its Notification Center, this push included.
    expect(badge(supervisorThread, 0)).toBeUndefined();
    const session = thread({
      id: "session:s-1",
      kind: "mention",
      subject: { type: "session", id: "s-1", title: "t" },
      url: "/session/s-1",
    });
    expect(badge(session, 3)).toBeUndefined();
  });

  test("a push to Bark sets the badge from the person's open items", async () => {
    for (const title of ["First", "Second"])
      await postSupervisorItem({
        user: "Ada",
        source: "supervisor",
        kind: "needs-you",
        title,
      });
    await postSupervisorItem({
      user: "Ada",
      source: "supervisor",
      kind: "fyi",
      title: "Only news",
    });
    await turnOn();
    await bark.sendBarkNotification(
      "Ada",
      supervisorThread,
      event("supervisor_needs_you"),
      "alert",
      payload,
    );
    // A request a previous test left in flight may land first.
    const sent = requests.find((r) => r.body.url === "blob://item/si-1");
    expect(sent?.body.badge).toBe("2");
  });

  test("ttl follows the item's expiry, bounded; clear plain kinds have none", () => {
    const now = 1_000_000;
    const ttl = (expiresAt: number, t = supervisorThread) =>
      bark.barkMessageFor(
        t,
        event(t.kind, { body: "x", expiresAt }),
        "alert",
        payload,
        { ...opts, now },
      ).ttl;
    expect(ttl(now + 2 * 60 * 60 * 1000)).toBe(String(2 * 60 * 60));
    expect(ttl(now + 365 * 24 * 60 * 60 * 1000)).toBe(
      String(30 * 24 * 60 * 60),
    );
    expect(ttl(now - 5_000)).toBe("60");
    const comment = thread({
      id: "session:s-1",
      kind: "comment",
      subject: { type: "session", id: "s-1", title: "t" },
      url: "/session/s-1",
    });
    expect(ttl(now + 60 * 60 * 1000, comment)).toBeUndefined();
  });

  test("a needs-you event carries its item's expiry", async () => {
    const events: NotificationEvent[] = [];
    restoreInbox();
    restoreInbox = __setSupervisorInboxDepsForTest({
      notify: async (_user, e) => {
        events.push(e);
        return null;
      },
      markDone: async () => {},
      supervisorSessionId: async () => "os-sup",
      ensureWatch: async () => undefined,
      timeZone: () => "UTC",
    });
    const { item } = await postSupervisorItem({
      user: "Ada",
      source: "supervisor",
      kind: "needs-you",
      title: "Pick one",
    });
    const needsYou = events.find((e) => e.kind === "supervisor_needs_you");
    expect(needsYou?.push?.expiresAt).toBe(
      item.updatedAt + 30 * 24 * 60 * 60 * 1000,
    );
  });

  test("markdown only when sealed and it is Markdown; body stays the fallback", () => {
    const digest = thread({
      id: "supervisor:digest-2026-01-02",
      kind: "supervisor_digest",
      subject: { type: "supervisor", id: "digest-2026-01-02", title: "Daily" },
      reason: "Daily digest",
    });
    const hints = {
      body: "2 things happened",
      sealedMarkdown: "- **Shipped acme**\n- **Fixed the build**",
    };
    const fixed = { title: "Daily digest", body: "2 things happened" };
    const sealed = bark.barkMessageFor(
      digest,
      event("supervisor_digest", hints),
      "alert",
      fixed,
      { ...opts, sealed: true },
    );
    expect(sealed.markdown).toBe(hints.sealedMarkdown);
    expect(sealed.body).toBe("2 things happened");
    const clear = bark.barkMessageFor(
      digest,
      event("supervisor_digest", hints),
      "alert",
      fixed,
      opts,
    );
    expect(clear.markdown).toBeUndefined();
    expect(JSON.stringify(clear)).not.toContain("Shipped");
    const flat = bark.barkMessageFor(
      digest,
      event("supervisor_digest", { ...hints, sealedMarkdown: "just words" }),
      "alert",
      fixed,
      { ...opts, sealed: true },
    );
    expect(flat.markdown).toBeUndefined();
  });

  test("the digest list bolds titles and escapes what they hold", async () => {
    const { digestMarkdown } = await import("./supervisor-inbox");
    const items = ["Shipped *acme*", "Fixed [the] build", "c", "d", "e", "f"];
    const markdown = digestMarkdown(items.map((title) => ({ title })));
    expect(markdown.split("\n")).toEqual([
      "- **Shipped \\*acme\\***",
      "- **Fixed \\[the\\] build**",
      "- **c**",
      "- **d**",
      "- **e**",
      "- and 1 more",
    ]);
  });

  test("only a critical push rings on", () => {
    const down = bark.barkMessageFor(
      supervisorThread,
      event("supervisor_needs_you", { body: "x", urgency: "high" }),
      "alert",
      payload,
      opts,
    );
    expect(down).toMatchObject({ level: "critical", call: "1" });
    const normal = bark.barkMessageFor(
      supervisorThread,
      event("supervisor_needs_you", { body: "x" }),
      "alert",
      payload,
      opts,
    );
    expect(normal.call).toBeUndefined();
  });
});

describe("retract when handled", () => {
  const raise = (id: string) =>
    deliverNotification("Ada", {
      kind: "supervisor_needs_you",
      subject: { type: "supervisor", id, title: "Customer wrote" },
      reason: "Needs you",
      url: `/session/os-sup?item=${id}`,
      eventKey: `${id}:1`,
      push: { body: "A decision is waiting" },
    });

  for (const encrypted of [false, true])
    test(`done deletes the push by its id${encrypted ? ", encrypted too" : ""}`, async () => {
      await call("PUT", "/api/supervisor/bark", {
        deviceKey: DEVICE_KEY,
        enabled: true,
        ...(encrypted
          ? {
              encryption: {
                algorithm: "AES256",
                mode: "GCM",
                key: KEYS.AES256,
              },
            }
          : {}),
      });
      const raised = await raise("si-20");
      await requestsSettle(1);
      const pushed = requests[0]!.body;
      expect(pushed.id).toBeTruthy();
      expect(
        await markNotifications("Ada", { ids: [raised!.id], done: true }),
      ).toBe(1);
      await requestsSettle(2);
      // Always in clear: bark-server must see `delete` to send it silently.
      expect(requests[1]!.body).toEqual({
        device_key: DEVICE_KEY,
        id: pushed.id!,
        delete: "1",
      });
      // Done again changes nothing and sends nothing.
      await markNotifications("Ada", { ids: [raised!.id], done: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(requests).toHaveLength(2);
    });

  test("nothing is retracted while Bark is off, or for a row never pushed", async () => {
    await call("PUT", "/api/supervisor/bark", {
      deviceKey: DEVICE_KEY,
      enabled: false,
    });
    const raised = await raise("si-21");
    await markNotifications("Ada", { ids: [raised!.id], done: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(0);
    await call("PUT", "/api/supervisor/bark", { enabled: true });
    await deliverNotification("Ada", {
      kind: "supervisor_needs_you",
      subject: { type: "supervisor", id: "si-22", title: "t" },
      reason: "Needs you",
      url: "/session/os-sup?item=si-22",
      eventKey: "si-22:1",
      delivery: "quiet",
    });
    await markNotifications("Ada", { ids: ["supervisor:si-22"], done: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(0);
  });
});

describe("Blob's voice", () => {
  const fakeFfmpeg = join(root, "fake-ffmpeg");
  const fakeAudio = new TextEncoder().encode("fake mp3 bytes");
  // Answers -version and "converts" by copying the input to the output.
  writeFileSync(
    fakeFfmpeg,
    [
      "#!/bin/sh",
      'for a in "$@"; do [ "$a" = "-version" ] && exit 0; done',
      'in=""; prev=""; for a in "$@"; do [ "$prev" = "-i" ] && in="$a"; prev="$a"; out="$a"; done',
      'cp "$in" "$out"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeFfmpeg, 0o755);

  const speakDeps = () =>
    barkSound.__setBarkSoundDepsForTest({
      ffmpeg: fakeFfmpeg,
      speech: async () => ({ configured: true, voice: "test-voice" }),
      synthesize: async (text) => {
        spoken.push(text);
        return {
          ok: true,
          body: new Blob([fakeAudio]).stream() as ReadableStream<Uint8Array>,
        };
      },
    });

  const get = async (path: string) => {
    const url = new URL(`http://localhost${path}`);
    return handleBlobSpeechRoutes({
      req: new Request(url),
      url,
      path,
      publicPrefix: "",
      authUser: null,
    });
  };

  const sendNeedsYou = () =>
    bark.sendBarkNotification(
      "Ada",
      thread({ kind: "supervisor_needs_you" }),
      event("supervisor_needs_you", { body: "acme: a decision is waiting" }),
      "alert",
      payload,
    );

  test("speak attaches a content-addressed .caf and keeps a fallback sound", async () => {
    restoreSound();
    restoreSound = speakDeps();
    const put = await call("PUT", "/api/supervisor/bark", {
      deviceKey: DEVICE_KEY,
      enabled: true,
      speak: true,
    });
    expect(put.json.bark).toMatchObject({ speak: true, speakAvailable: true });
    await sendNeedsYou();
    const body = requests[0]!.body;
    const prefix = `${BASE}/api/blob/speech/caf/`;
    expect(body.soundUrl?.startsWith(prefix)).toBe(true);
    expect(body.soundUrl).toMatch(/\/[0-9a-f]{64}\.caf$/);
    expect(body.sound).toBe(bark.BARK_FALLBACK_SOUND);
    const path = body.soundUrl!.slice(BASE.length);
    expect(barkSound.isBarkSoundPath(path)).toBe(true);
    const response = await get(path);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("audio/x-caf");
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(fakeAudio);
    // The same fixed copy is the same URL, spoken once.
    await sendNeedsYou();
    expect(requests[1]!.body.soundUrl).toBe(body.soundUrl);
    expect((await get(path))?.status).toBe(200);
    expect(spoken).toEqual(["Needs you. acme: a decision is waiting"]);
    // Only a sound the server pushed is served.
    expect(
      (await get(`/api/blob/speech/caf/${"0".repeat(64)}.caf`))?.status,
    ).toBe(404);
  });

  test("off, unavailable or not a supervisor kind: no sound at all", async () => {
    await call("PUT", "/api/supervisor/bark", {
      deviceKey: DEVICE_KEY,
      enabled: true,
      speak: true,
    });
    // beforeEach left speech unavailable (no ffmpeg, no key).
    expect((await call("GET", "/api/supervisor/bark")).json.bark).toMatchObject(
      { speak: true, speakAvailable: false },
    );
    await sendNeedsYou();
    restoreSound();
    restoreSound = speakDeps();
    await call("PUT", "/api/supervisor/bark", { speak: false });
    await sendNeedsYou();
    await call("PUT", "/api/supervisor/bark", { speak: true });
    await bark.sendBarkNotification(
      "Ada",
      thread({
        id: "session:s-1",
        kind: "mention",
        subject: { type: "session", id: "s-1", title: "t" },
        url: "/session/s-1",
      }),
      event("mention"),
      "alert",
      { title: "t", url: "/session/s-1" },
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.body.soundUrl).toBeUndefined();
      expect(request.body.sound).toBeUndefined();
    }
    expect(spoken).toEqual([]);
  });

  test("speak must be a boolean", async () => {
    const put = await call("PUT", "/api/supervisor/bark", { speak: "yes" });
    expect(put).toEqual({
      status: 400,
      json: { error: "speak must be true or false" },
    });
  });

  test("the sign-in gate opens exactly the sound path", () => {
    const hash = "a".repeat(64);
    expect(barkSound.isBarkSoundPath(`/api/blob/speech/caf/${hash}.caf`)).toBe(
      true,
    );
    for (const path of [
      `/api/blob/speech/caf/${hash}.mp3`,
      `/api/blob/speech/caf/${hash.slice(1)}.caf`,
      `/api/blob/speech/caf/../${hash}.caf`,
      "/api/blob/speech",
      "/api/blob/speech/status",
    ])
      expect(barkSound.isBarkSoundPath(path)).toBe(false);
  });
});
