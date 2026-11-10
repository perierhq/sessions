import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../paths";
import type { RouteContext } from "./context";
import { handleBlobSpeechRoutes } from "./blob-speech";
import {
  BLOB_SPEECH_MAX_CHARS,
  BLOB_SPEECH_PER_MINUTE,
  FISH_TTS_URL,
  resetBlobSpeechRateLimit,
} from "../blob-speech";

const realFetch = globalThis.fetch;
let scratch = "";
let previousStateDir: string | undefined;
let previousEnvKey: string | undefined;

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}
let calls: Captured[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "blob-speech-test-"));
  previousStateDir = process.env.OPENSESSION_STATE_DIR;
  previousEnvKey = process.env.FISH_AUDIO_API_KEY;
  process.env.OPENSESSION_STATE_DIR = scratch;
  delete process.env.FISH_AUDIO_API_KEY;
  resetBlobSpeechRateLimit();
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  if (previousEnvKey === undefined) delete process.env.FISH_AUDIO_API_KEY;
  else process.env.FISH_AUDIO_API_KEY = previousEnvKey;
  rmSync(scratch, { recursive: true, force: true });
});

function ctx(
  path: string,
  method: string,
  body?: unknown,
  login = "ada",
): RouteContext {
  const url = new URL(`http://example.test${path}`);
  return {
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
    path,
    publicPrefix: "/backstage",
    authUser: { login, name: login },
  };
}

async function call(
  path: string,
  method: string,
  body?: unknown,
  login?: string,
): Promise<Response> {
  const res = await handleBlobSpeechRoutes(ctx(path, method, body, login));
  if (!res) throw new Error(`no route for ${method} ${path}`);
  return res;
}

/** Fish returns `chunks` as a chunked body; every request is captured. */
function mockFish(
  respond: () => Response = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x49, 0x44, 0x33]));
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "audio/mpeg" } },
    ),
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return respond();
  }) as typeof fetch;
}

describe("Blob speech settings", () => {
  test("status starts unconfigured on the default model", async () => {
    const status = await (await call("/api/blob/speech/status", "GET")).json();
    expect(status).toEqual({
      configured: false,
      model: "s2.1-pro",
      models: ["s2.1-pro", "s2.1-pro-free"],
    });
  });

  test("the key is stored privately, masked, and cleared by an empty string", async () => {
    const set = await call("/api/blob/speech/key", "PUT", {
      apiKey: "  fish-secret-abcd  ",
    });
    const status = await set.json();
    expect(status.configured).toBe(true);
    expect(status.keyMasked).toBe("…abcd");
    expect(JSON.stringify(status)).not.toContain("fish-secret");
    expect(statSync(join(stateDir("blob"), "speech.json")).mode & 0o777).toBe(
      0o600,
    );

    const cleared = await (
      await call("/api/blob/speech/key", "PUT", { apiKey: "" })
    ).json();
    expect(cleared.configured).toBe(false);
    expect(cleared.keyMasked).toBeUndefined();
  });

  test("the key route needs a string", async () => {
    expect((await call("/api/blob/speech/key", "PUT", {})).status).toBe(400);
  });

  test("FISH_AUDIO_API_KEY is the fallback", async () => {
    process.env.FISH_AUDIO_API_KEY = "env-key-9876";
    const status = await (await call("/api/blob/speech/status", "GET")).json();
    expect(status.configured).toBe(true);
    expect(status.keyMasked).toBe("…9876");
  });

  test("settings accept the two models and a voice id", async () => {
    const res = await call("/api/blob/speech/settings", "PUT", {
      model: "s2.1-pro-free",
      voiceId: "abc123",
    });
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status.model).toBe("s2.1-pro-free");
    expect(status.voiceId).toBe("abc123");

    // Leaving voiceId out keeps it; null clears it.
    const kept = await (
      await call("/api/blob/speech/settings", "PUT", { model: "s2.1-pro" })
    ).json();
    expect(kept).toMatchObject({ model: "s2.1-pro", voiceId: "abc123" });
    const cleared = await (
      await call("/api/blob/speech/settings", "PUT", {
        model: "s2.1-pro",
        voiceId: null,
      })
    ).json();
    expect(cleared.voiceId).toBeUndefined();
  });

  test("settings fail closed on other models and bad voice ids", async () => {
    for (const body of [
      { model: "s1" },
      { model: "s2-pro" },
      {},
      { model: "s2.1-pro", voiceId: 42 },
      { model: "s2.1-pro", voiceId: "../etc" },
    ]) {
      const res = await call("/api/blob/speech/settings", "PUT", body);
      expect(res.status).toBe(400);
    }
    const status = await (await call("/api/blob/speech/status", "GET")).json();
    expect(status.model).toBe("s2.1-pro");
    expect(status.voiceId).toBeUndefined();
  });
});

describe("Blob speech synthesis", () => {
  test("503 without a key, and Fish is never called", async () => {
    mockFish();
    const res = await call("/api/blob/speech", "POST", { text: "Hello" });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("streams Fish's audio and sends the right headers and body", async () => {
    await call("/api/blob/speech/key", "PUT", { apiKey: "fish-secret-abcd" });
    await call("/api/blob/speech/settings", "PUT", {
      model: "s2.1-pro-free",
      voiceId: "voice42",
    });
    mockFish();
    const res = await call("/api/blob/speech", "POST", {
      text: "  Cześć, jestem Blob.  ",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([
      0x49, 0x44, 0x33, 1, 2, 3, 4,
    ]);

    expect(calls).toHaveLength(1);
    const [sent] = calls;
    expect(sent.url).toBe(FISH_TTS_URL);
    expect(sent.headers.get("Authorization")).toBe("Bearer fish-secret-abcd");
    expect(sent.headers.get("model")).toBe("s2.1-pro-free");
    expect(sent.body).toEqual({
      text: "Cześć, jestem Blob.",
      format: "mp3",
      latency: "balanced",
      reference_id: "voice42",
    });
  });

  test("no reference_id without a voice id", async () => {
    await call("/api/blob/speech/key", "PUT", { apiKey: "fish-secret-abcd" });
    mockFish();
    await call("/api/blob/speech", "POST", { text: "Hi" });
    expect(calls[0].headers.get("model")).toBe("s2.1-pro");
    expect(calls[0].body).not.toHaveProperty("reference_id");
  });

  test("empty text is rejected and long text is cut at the cap", async () => {
    await call("/api/blob/speech/key", "PUT", { apiKey: "fish-secret-abcd" });
    mockFish();
    for (const body of [{}, { text: "   " }, { text: 7 }])
      expect((await call("/api/blob/speech", "POST", body)).status).toBe(400);
    expect(calls).toHaveLength(0);

    await call("/api/blob/speech", "POST", {
      text: "a".repeat(BLOB_SPEECH_MAX_CHARS + 500),
    });
    expect(String(calls[0].body.text)).toHaveLength(BLOB_SPEECH_MAX_CHARS);
  });

  test("upstream failures are a 502 that never echoes the key", async () => {
    await call("/api/blob/speech/key", "PUT", { apiKey: "fish-secret-abcd" });
    for (const [status, message] of [
      [401, "Fish Audio rejected the API key"],
      [402, "Fish Audio account is out of credit"],
      [503, "Fish Audio is unavailable"],
    ] as const) {
      mockFish(() =>
        Response.json(
          { status, message: "bad key fish-secret-abcd" },
          { status },
        ),
      );
      const res = await call("/api/blob/speech", "POST", { text: "Hi" });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text).error).toBe(message);
      expect(text).not.toContain("fish-secret");
    }

    globalThis.fetch = (async () => {
      throw new Error("connect failed for fish-secret-abcd");
    }) as unknown as typeof fetch;
    const res = await call("/api/blob/speech", "POST", { text: "Hi" });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("fish-secret");
  });

  test("each user gets a per-minute budget", async () => {
    await call("/api/blob/speech/key", "PUT", { apiKey: "fish-secret-abcd" });
    mockFish();
    for (let i = 0; i < BLOB_SPEECH_PER_MINUTE; i++)
      expect(
        (await call("/api/blob/speech", "POST", { text: "Hi" })).status,
      ).toBe(200);
    const limited = await call("/api/blob/speech", "POST", { text: "Hi" });
    expect(limited.status).toBe(429);
    const other = await call("/api/blob/speech", "POST", { text: "Hi" }, "bob");
    expect(other.status).toBe(200);
  });

  test("other paths fall through", async () => {
    expect(
      await handleBlobSpeechRoutes(ctx("/api/blob/speechless", "GET")),
    ).toBeUndefined();
    expect(
      await handleBlobSpeechRoutes(ctx("/api/blob/speech", "GET")),
    ).toBeUndefined();
  });
});
