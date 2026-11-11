/**
 * Blob reading a Bark push aloud: the `soundUrl` of a supervisor push
 * (bark.ts), when the person turned "speak" on in their Bark settings.
 *
 * Bark downloads a `.caf` file of at most 30 seconds and 6 MB before it shows
 * the push, gives up after 10 seconds and then plays `sound` instead, and
 * caches the file by its exact URL (Bark docs, `soundUrl`). So:
 *
 * - The URL is content-addressed, `/api/blob/speech/caf/<sha256>.caf` over a
 *   server secret, the voice and the text. The same fixed copy ("Needs you.
 *   acme: a decision is waiting") gets the same URL, is synthesized once and
 *   downloaded once. The hash is the capability: the route is open to
 *   Bark's plain download (opensession.ts exempts exactly this path), and
 *   without the secret nobody can name a sound that was never pushed.
 * - Only text the server pushed can be spoken: the push writes a small entry
 *   next to the file, and the route synthesizes only a known entry, once.
 * - Synthesis starts when the push is sent, without waiting, so the file is
 *   usually ready by the time the phone asks; the route waits for it then.
 * - Fish Audio (blob-speech.ts) returns mp3; ffmpeg turns it into CAF. A
 *   server without ffmpeg, or without a Fish key, reports the feature
 *   unavailable and pushes without a sound URL.
 * - An entry not pushed again for 30 days expires with its file, as Bark
 *   drops a cached sound unused for 30 days.
 *
 * All file and process work is async. Nothing runs at import time.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  blobSpeechStatus,
  DEFAULT_BLOB_VOICE_ID,
  synthesizeBlobSpeech,
  type SpeechResult,
} from "./blob-speech";
import { stateDir } from "./paths";

export const BARK_SOUND_PREFIX = "/api/blob/speech/caf/";
const SOUND_PATH = /^\/api\/blob\/speech\/caf\/([0-9a-f]{64})\.caf$/;
export const BARK_SOUND_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Bark's limits, with room to spare. */
const MAX_SECONDS = 29;
const MAX_BYTES = 6 * 1024 * 1024;
const SYNTH_TIMEOUT_MS = 20_000;
const FFMPEG_TIMEOUT_MS = 20_000;
/** The push never waits longer than this for its sound URL. */
const URL_TIMEOUT_MS = 2_000;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

interface BarkSoundDeps {
  ffmpeg: string;
  synthesize: (text: string, signal?: AbortSignal) => Promise<SpeechResult>;
  speech: () => Promise<{ configured: boolean; voice: string }>;
  now: () => number;
}

const defaultDeps: BarkSoundDeps = {
  ffmpeg: "ffmpeg",
  synthesize: synthesizeBlobSpeech,
  speech: async () => {
    const status = await blobSpeechStatus();
    return {
      configured: status.configured,
      voice: `${status.model}:${status.voiceId || DEFAULT_BLOB_VOICE_ID}`,
    };
  },
  now: Date.now,
};

let deps: BarkSoundDeps = defaultDeps;
let ffmpegPresent: Promise<boolean> | null = null;
let secret: Promise<string> | null = null;
let lastPrune = 0;
const making = new Map<string, Promise<string | null>>();

/** Swap dependencies in tests. Returns a restore function. */
export function __setBarkSoundDepsForTest(
  overrides: Partial<BarkSoundDeps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  ffmpegPresent = null;
  secret = null;
  lastPrune = 0;
  making.clear();
  return () => {
    deps = previous;
    ffmpegPresent = null;
    secret = null;
    making.clear();
  };
}

const dir = () => `${stateDir("blob")}/bark-sounds`;
const entryPath = (hash: string) => `${dir()}/${hash}.json`;
const soundPath = (hash: string) => `${dir()}/${hash}.caf`;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Run a process to its end, killed after `timeoutMs`. */
async function run(argv: string[], timeoutMs: number): Promise<boolean> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    return false;
  }
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    return (await child.exited) === 0;
  } finally {
    clearTimeout(timer);
  }
}

function ffmpegAvailable(): Promise<boolean> {
  ffmpegPresent ??= run([deps.ffmpeg, "-hide_banner", "-version"], 5_000);
  return ffmpegPresent;
}

/** Whether pushes can speak here: ffmpeg on the server and a Fish key. */
export async function barkSoundAvailable(): Promise<boolean> {
  const [ffmpeg, speech] = await Promise.all([
    ffmpegAvailable(),
    deps.speech().catch(() => ({ configured: false, voice: "" })),
  ]);
  return ffmpeg && speech.configured;
}

/** The server secret behind the hashes, made on first use (0600). */
function soundSecret(): Promise<string> {
  secret ??= (async () => {
    const path = `${dir()}/secret`;
    try {
      return (await readFile(path, "utf8")).trim();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await mkdir(dir(), { recursive: true });
    try {
      await writeFile(path, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    return (await readFile(path, "utf8")).trim();
  })();
  secret.catch(() => {
    secret = null;
  });
  return secret;
}

export function barkSoundHash(
  secretValue: string,
  voice: string,
  text: string,
): string {
  return createHash("sha256")
    .update(`${secretValue}\n${voice}\n${text}`)
    .digest("hex");
}

async function soundUrlFor(text: string, base: string): Promise<string | null> {
  if (!(await barkSoundAvailable())) return null;
  const { voice } = await deps.speech();
  const hash = barkSoundHash(await soundSecret(), voice, text);
  await mkdir(dir(), { recursive: true });
  try {
    await writeFile(
      entryPath(hash),
      JSON.stringify({ text, voice, createdAt: deps.now() }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // Pushed again: the entry and its file live another 30 days.
    const now = new Date(deps.now());
    await utimes(entryPath(hash), now, now).catch(() => {});
  }
  void ensureSound(hash).catch(() => {});
  void pruneSounds().catch(() => {});
  return `${base}${BARK_SOUND_PREFIX}${hash}.caf`;
}

/**
 * The `soundUrl` for Blob saying `text`, or undefined when the server can't
 * make it. Starts the synthesis without waiting for it, never throws, and
 * never holds the push more than a moment.
 */
export async function barkSoundUrl(
  text: string,
  base: string,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await Promise.race([
      soundUrlFor(text, base),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), URL_TIMEOUT_MS);
      }),
    ]);
    return url ?? undefined;
  } catch (error) {
    console.warn(
      "[bark-sound] no sound for this push:",
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function freshEntry(
  hash: string,
): Promise<{ text: string; voice: string } | null> {
  try {
    const info = await stat(entryPath(hash));
    if (deps.now() - info.mtimeMs > BARK_SOUND_MAX_AGE_MS) return null;
    const value: unknown = JSON.parse(await readFile(entryPath(hash), "utf8"));
    if (!value || typeof value !== "object") return null;
    const { text, voice } = value as Record<string, unknown>;
    return typeof text === "string" && typeof voice === "string"
      ? { text, voice }
      : null;
  } catch {
    return null;
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Synthesize and convert one known entry. The file, or null. */
async function makeSound(hash: string): Promise<string | null> {
  const entry = await freshEntry(hash);
  if (!entry) return null;
  const result = await deps.synthesize(
    entry.text,
    AbortSignal.timeout(SYNTH_TIMEOUT_MS),
  );
  if (!result.ok) {
    console.warn(`[bark-sound] speech failed: ${result.error}`);
    return null;
  }
  const mp3 = await readBounded(result.body);
  if (!mp3) return null;
  const temporary = `${dir()}/${hash}.${crypto.randomUUID()}`;
  try {
    await writeFile(`${temporary}.mp3`, mp3, { mode: 0o600 });
    const converted = await run(
      [
        deps.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        `${temporary}.mp3`,
        "-t",
        String(MAX_SECONDS),
        "-ac",
        "1",
        "-ar",
        "22050",
        "-f",
        "caf",
        `${temporary}.caf`,
      ],
      FFMPEG_TIMEOUT_MS,
    );
    if (!converted) {
      console.warn("[bark-sound] ffmpeg could not convert the speech");
      return null;
    }
    const info = await stat(`${temporary}.caf`);
    if (info.size === 0 || info.size > MAX_BYTES) return null;
    await rename(`${temporary}.caf`, soundPath(hash));
    return soundPath(hash);
  } finally {
    await rm(`${temporary}.mp3`, { force: true });
    await rm(`${temporary}.caf`, { force: true });
  }
}

/** The finished file for `hash`, making it once when it is due. */
function ensureSound(hash: string): Promise<string | null> {
  const pending = making.get(hash);
  if (pending) return pending;
  const job = (async () => {
    if (!(await freshEntry(hash))) return null;
    try {
      await stat(soundPath(hash));
      return soundPath(hash);
    } catch {}
    return makeSound(hash);
  })().finally(() => making.delete(hash));
  making.set(hash, job);
  return job;
}

/** Drop entries not pushed for 30 days, their files, orphans and leftover
 *  temporary files. At most every few hours; the folder stays small. */
async function pruneSounds(): Promise<void> {
  const now = deps.now();
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  const names = await readdir(dir()).catch(() => [] as string[]);
  const fresh = new Set<string>();
  for (const name of names) {
    const hash = name.match(/^([0-9a-f]{64})\.json$/)?.[1];
    if (!hash) continue;
    const info = await stat(`${dir()}/${name}`).catch(() => null);
    if (info && now - info.mtimeMs <= BARK_SOUND_MAX_AGE_MS) fresh.add(hash);
    else await rm(`${dir()}/${name}`, { force: true });
  }
  for (const name of names) {
    if (name === "secret" || name.endsWith(".json")) continue;
    const hash = name.match(/^([0-9a-f]{64})/)?.[1];
    const finished = /^[0-9a-f]{64}\.caf$/.test(name);
    if (hash && fresh.has(hash) && finished) continue;
    // A temporary file still being written is left alone for an hour.
    if (hash && fresh.has(hash)) {
      const info = await stat(`${dir()}/${name}`).catch(() => null);
      if (info && now - info.mtimeMs < 60 * 60 * 1000) continue;
    }
    await rm(`${dir()}/${name}`, { force: true });
  }
}

/**
 * `GET /api/blob/speech/caf/<hash>.caf`: the spoken sound, made on first
 * request when the push's synthesis has not finished. 404 for a hash the
 * server never pushed or one that expired. Cacheable for good: a new text or
 * voice is a new URL.
 */
export async function serveBarkSound(
  path: string,
): Promise<Response | undefined> {
  const hash = path.match(SOUND_PATH)?.[1];
  if (!hash) return undefined;
  const file = await ensureSound(hash).catch(() => null);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(file), {
    headers: {
      "Content-Type": "audio/x-caf",
      "Cache-Control": "public, max-age=2592000, immutable",
    },
  });
}

/** Whether `path` names a spoken sound, for the sign-in gate. */
export function isBarkSoundPath(path: string): boolean {
  return SOUND_PATH.test(path);
}
