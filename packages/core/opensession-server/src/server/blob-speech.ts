/**
 * Blob speech: reads Blob's answers aloud with Fish Audio text to speech
 * (https://docs.fish.audio). The device posts the text here and plays the
 * mp3 the server streams back, so the Fish API key never leaves the server.
 *
 * The key and the model choice live in one 0600 file, the same contract as
 * the Desk voice key store (desk-voice.ts): read and written async, only ever
 * returned masked. FISH_AUDIO_API_KEY is the fallback when nothing is stored.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { stateDir } from "./paths";

const dir = () => stateDir("blob");
const settingsPath = () => `${dir()}/speech.json`;

export const FISH_TTS_URL = "https://api.fish.audio/v1/tts";

/** `s2.1-pro` is the paid, faster model. `s2.1-pro-free` costs nothing but is
 * slower and Fish may train on its requests. `drama-3` is the directable,
 * more expressive model at a higher price ($50 per M bytes; $10 until 30 Nov
 * 2026). Anything else is refused. */
export const BLOB_SPEECH_MODELS = [
  "s2.1-pro",
  "s2.1-pro-free",
  "drama-3",
] as const;
export type BlobSpeechModel = (typeof BLOB_SPEECH_MODELS)[number];
export const BLOB_SPEECH_MODEL: BlobSpeechModel = "s2.1-pro";

/** Longest text one request may speak. The app sends a sentence or two at a
 * time; this only bounds the cost of a single call. */
export const BLOB_SPEECH_MAX_CHARS = 1500;

/** A Fish voice (model) id is a short hex string; this bounds what is stored. */
const MAX_VOICE_ID_CHARS = 128;

export function isBlobSpeechModel(value: unknown): value is BlobSpeechModel {
  return (BLOB_SPEECH_MODELS as readonly unknown[]).includes(value);
}

interface SpeechSettingsFile {
  fishApiKey?: string;
  model?: string;
  voiceId?: string;
}

async function readSettingsFile(): Promise<SpeechSettingsFile> {
  try {
    const value: unknown = JSON.parse(await readFile(settingsPath(), "utf-8"));
    if (!value || typeof value !== "object")
      throw new Error("Invalid Blob speech settings");
    const field = (name: string): string | undefined => {
      const v = (value as Record<string, unknown>)[name];
      return typeof v === "string" ? v : undefined;
    };
    return {
      fishApiKey: field("fishApiKey"),
      model: field("model"),
      voiceId: field("voiceId"),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return {};
    throw error;
  }
}

// Serialized read-modify-write, as in desk-voice.ts: concurrent key and
// settings saves keep each other's fields.
let settingsWrite: Promise<void> = Promise.resolve();
function updateSettingsFile(
  update: (current: SpeechSettingsFile) => SpeechSettingsFile,
): Promise<void> {
  const path = settingsPath();
  const operation = settingsWrite.then(async () => {
    const next = update(await readSettingsFile());
    await mkdir(dir(), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  settingsWrite = operation.catch(() => {});
  return operation;
}

/** The stored settings with the key resolved: the stored key, else the
 * FISH_AUDIO_API_KEY environment variable. */
/**
 * The voice Blob uses until one is chosen. Fish picks a fresh random speaker
 * for every request without a `reference_id`, and Blob reads an answer as
 * several requests (one per sentence or piece), so an unset voice changed
 * between sentences. A public Fish voice ("Sarah": calm, conversational).
 */
export const DEFAULT_BLOB_VOICE_ID = "933563129e564b19a115bedd57b7406a";

async function resolvedSettings(): Promise<{
  key?: string;
  model: BlobSpeechModel;
  voiceId?: string;
}> {
  const file = await readSettingsFile();
  return {
    key: file.fishApiKey || process.env.FISH_AUDIO_API_KEY?.trim() || undefined,
    model: isBlobSpeechModel(file.model) ? file.model : BLOB_SPEECH_MODEL,
    voiceId: file.voiceId || undefined,
  };
}

export interface BlobSpeechStatus {
  configured: boolean;
  keyMasked?: string;
  model: BlobSpeechModel;
  models: readonly BlobSpeechModel[];
  voiceId?: string;
}

export async function blobSpeechStatus(): Promise<BlobSpeechStatus> {
  const { key, model, voiceId } = await resolvedSettings();
  return {
    configured: !!key,
    keyMasked: key ? `…${key.slice(-4)}` : undefined,
    model,
    models: BLOB_SPEECH_MODELS,
    voiceId,
  };
}

/** Empty string clears the stored key (the environment fallback still
 * applies). */
export function setBlobSpeechKey(apiKey: string): Promise<void> {
  return updateSettingsFile((current) => ({
    ...current,
    fishApiKey: apiKey.trim() || undefined,
  }));
}

export type SettingsResult = { ok: true } | { ok: false; error: string };

/** Validates before writing anything: an unknown model or a malformed voice
 * id leaves the settings as they were. `voiceId: null` or "" clears it;
 * leaving it out keeps the current one. */
export async function setBlobSpeechSettings(body: {
  model?: unknown;
  voiceId?: unknown;
}): Promise<SettingsResult> {
  if (!isBlobSpeechModel(body.model))
    return {
      ok: false,
      error: `model must be one of ${BLOB_SPEECH_MODELS.join(", ")}`,
    };
  const model = body.model;
  let keepVoice = false;
  let voiceId: string | undefined;
  if (body.voiceId === undefined) keepVoice = true;
  else if (body.voiceId === null) voiceId = undefined;
  else if (typeof body.voiceId === "string") {
    const trimmed = body.voiceId.trim();
    if (trimmed.length > MAX_VOICE_ID_CHARS || /[^A-Za-z0-9_-]/.test(trimmed))
      return { ok: false, error: "voiceId must be a Fish Audio voice id" };
    voiceId = trimmed || undefined;
  } else return { ok: false, error: "voiceId must be a string or null" };
  await updateSettingsFile((current) => ({
    ...current,
    model,
    voiceId: keepVoice ? current.voiceId : voiceId,
  }));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rate limit: a fixed one-minute window per user, the same shape as the
// public ingress limiter. Each request is a paid upstream call.

export const BLOB_SPEECH_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const MAX_TRACKED_USERS = 1000;
const rateTable = new Map<string, { count: number; resetAt: number }>();

/** True when this request is over the user's budget (and counts it). */
export function blobSpeechRateLimited(user: string, now = Date.now()): boolean {
  const rec = rateTable.get(user);
  if (!rec || rec.resetAt <= now) {
    if (rateTable.size >= MAX_TRACKED_USERS) {
      for (const [key, value] of rateTable)
        if (value.resetAt <= now) rateTable.delete(key);
      if (rateTable.size >= MAX_TRACKED_USERS) rateTable.clear();
    }
    rateTable.set(user, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > BLOB_SPEECH_PER_MINUTE;
}

export function resetBlobSpeechRateLimit(): void {
  rateTable.clear();
}

// ---------------------------------------------------------------------------
// Synthesis.

export type SpeechResult =
  | { ok: true; body: ReadableStream<Uint8Array> }
  | { ok: false; status: number; error: string };

/** Short, key-free text for an upstream failure. Fish's own message is not
 * passed through: it is not ours to word, and it could quote the request. */
function upstreamError(status: number): string {
  if (status === 401 || status === 403)
    return "Fish Audio rejected the API key";
  if (status === 402) return "Fish Audio account is out of credit";
  if (status === 429) return "Fish Audio rate limit reached";
  if (status >= 500) return "Fish Audio is unavailable";
  return `Fish Audio request failed (${status})`;
}

/** Normalizes the text: trimmed, refused when empty, cut at the cap. */
export function speechText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > BLOB_SPEECH_MAX_CHARS
    ? trimmed.slice(0, BLOB_SPEECH_MAX_CHARS)
    : trimmed;
}

/** Starts a Fish TTS request and hands back its audio stream unbuffered. */
export async function synthesizeBlobSpeech(
  text: string,
  signal?: AbortSignal,
): Promise<SpeechResult> {
  const { key, model, voiceId } = await resolvedSettings();
  if (!key)
    return {
      ok: false,
      status: 503,
      error: "Blob speech is not configured",
    };
  let res: Response;
  try {
    res = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        model,
      },
      body: JSON.stringify({
        text,
        format: "mp3",
        latency: "balanced",
        reference_id: voiceId || DEFAULT_BLOB_VOICE_ID,
      }),
      signal,
    });
  } catch {
    return { ok: false, status: 502, error: "Fish Audio is unreachable" };
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      status: 502,
      error: res.ok
        ? "Fish Audio returned no audio"
        : upstreamError(res.status),
    };
  }
  return { ok: true, body: res.body };
}
