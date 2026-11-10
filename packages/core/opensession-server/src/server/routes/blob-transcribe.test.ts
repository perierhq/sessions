import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "./context";
import { handleBlobSpeechRoutes } from "./blob-speech";
import { handleBlobTranscribeRoutes } from "./blob-transcribe";
import {
  BLOB_TRANSCRIBE_MAX_BYTES,
  BLOB_TRANSCRIBE_PER_MINUTE,
  FISH_ASR_URL,
  cleanTranscript,
  resetBlobTranscribeRateLimit,
} from "../blob-transcribe";

const realFetch = globalThis.fetch;
let scratch = "";
let previousStateDir: string | undefined;
let previousEnvKey: string | undefined;

interface Captured {
  url: string;
  headers: Headers;
  form: FormData;
}
let calls: Captured[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "blob-transcribe-test-"));
  previousStateDir = process.env.OPENSESSION_STATE_DIR;
  previousEnvKey = process.env.FISH_AUDIO_API_KEY;
  process.env.OPENSESSION_STATE_DIR = scratch;
  delete process.env.FISH_AUDIO_API_KEY;
  resetBlobTranscribeRateLimit();
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

const AUDIO = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

function ctx(
  query = "",
  body: BodyInit | null = AUDIO,
  contentType = "audio/mp4",
  login = "ada",
  method = "POST",
): RouteContext {
  const path = "/api/blob/transcribe";
  const url = new URL(`http://example.test${path}${query}`);
  return {
    req: new Request(url, {
      method,
      ...(method === "GET" ? {} : { body }),
      headers: { "Content-Type": contentType },
    }),
    url,
    path,
    publicPrefix: "/backstage",
    authUser: { login, name: login },
  };
}

async function call(...args: Parameters<typeof ctx>): Promise<Response> {
  const res = await handleBlobTranscribeRoutes(ctx(...args));
  if (!res) throw new Error("no route");
  return res;
}

function mockFish(
  respond: () => Response = () =>
    Response.json({
      text: "Cześć, [laughter] jak się masz?",
      duration: 1.5,
      segments: [],
      language: "Polish",
      language_code: "pl",
    }),
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      form: init?.body as FormData,
    });
    return respond();
  }) as typeof fetch;
}

async function setKey(): Promise<void> {
  const url = new URL("http://example.test/api/blob/speech/key");
  await handleBlobSpeechRoutes({
    req: new Request(url, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "fish-secret-abcd" }),
      headers: { "Content-Type": "application/json" },
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: { login: "ada", name: "ada" },
  });
}

describe("Blob transcription", () => {
  test("503 without a key, and Fish is never called", async () => {
    mockFish();
    const res = await call();
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("forwards the audio to transcribe-1-pro and returns clean text", async () => {
    await setKey();
    mockFish();
    const res = await call("?language=PL");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "Cześć, jak się masz?",
      language: "pl",
    });

    expect(calls).toHaveLength(1);
    const [sent] = calls;
    expect(sent.url).toBe(FISH_ASR_URL);
    expect(sent.headers.get("Authorization")).toBe("Bearer fish-secret-abcd");
    expect(sent.headers.get("model")).toBe("transcribe-1-pro");
    const audio = sent.form.get("audio") as File;
    expect(audio.name).toBe("audio.m4a");
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([...AUDIO]);
    expect(sent.form.get("language")).toBe("pl");
    expect(sent.form.get("tag_audio_events")).toBe("false");
    expect(sent.form.get("diarize")).toBe("false");
    expect(sent.form.get("ignore_timestamps")).toBe("true");
  });

  test("a malformed language hint is dropped", async () => {
    await setKey();
    mockFish();
    await call("?language=polish");
    expect(calls[0].form.get("language")).toBeNull();
  });

  test("refuses other content types, empty and oversized bodies", async () => {
    await setKey();
    mockFish();
    expect((await call("", AUDIO, "application/json")).status).toBe(415);
    expect((await call("", AUDIO, "audio/x-caf")).status).toBe(415);
    expect((await call("", new Uint8Array())).status).toBe(400);
    const big = new Uint8Array(BLOB_TRANSCRIBE_MAX_BYTES + 1);
    expect((await call("", big)).status).toBe(413);
    // A chunked body without Content-Length is cut off while it streams.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BLOB_TRANSCRIBE_MAX_BYTES));
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });
    expect((await call("", stream)).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  test("upstream failures are a 502 that never echoes the key", async () => {
    await setKey();
    for (const [status, message] of [
      [401, "Fish Audio rejected the API key"],
      [402, "Fish Audio account is out of credit"],
      [400, "Fish Audio request failed (400)"],
      [503, "Fish Audio is unavailable"],
    ] as const) {
      mockFish(() =>
        Response.json({ status, message: "bad fish-secret-abcd" }, { status }),
      );
      const res = await call();
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text).error).toBe(message);
      expect(text).not.toContain("fish-secret");
    }

    mockFish(() => Response.json({ duration: 1 }));
    expect((await call()).status).toBe(502);

    globalThis.fetch = (async () => {
      throw new Error("connect failed for fish-secret-abcd");
    }) as unknown as typeof fetch;
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("fish-secret");
  });

  test("each user gets a per-minute budget", async () => {
    await setKey();
    mockFish();
    for (let i = 0; i < BLOB_TRANSCRIBE_PER_MINUTE; i++)
      expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect((await call("", AUDIO, "audio/mp4", "bob")).status).toBe(200);
  });

  test("other methods and paths fall through", async () => {
    expect(
      await handleBlobTranscribeRoutes(
        ctx("", null, "audio/mp4", "ada", "GET"),
      ),
    ).toBeUndefined();
  });

  test("speaker markers and event cues are stripped", () => {
    expect(cleanTranscript("<|speaker:0|> Hi [laughter] there.  ")).toBe(
      "Hi there.",
    );
  });
});
