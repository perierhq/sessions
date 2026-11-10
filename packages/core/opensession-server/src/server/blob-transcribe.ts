/**
 * Blob transcription: turns what Kacper said into text with Fish Audio speech
 * to text (https://docs.fish.audio, `POST /v1/asr`, model
 * `transcribe-1-pro`). The device records the microphone while it shows live
 * on-device captions, posts the recording here when listening stops, and uses
 * Fish's text in place of the on-device one. The Fish key is the Blob speech
 * key (blob-speech.ts) and never leaves the server.
 *
 * Price: $0.36 per audio hour. The size cap and the per-user rate limit bound
 * what one device can spend.
 */

import {
  blobFishKey,
  perUserMinuteLimiter,
  upstreamError,
} from "./blob-speech";

export const FISH_ASR_URL = "https://api.fish.audio/v1/asr";
/** Sent as the `model` header, written exactly: anything else is silently
 * served (and billed) as `transcribe-1`. */
export const FISH_ASR_MODEL = "transcribe-1-pro";

/** Largest recording one request may send. The app records AAC at about
 * 64 kbps, so this is well over two minutes of speech. */
export const BLOB_TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;

export const BLOB_TRANSCRIBE_PER_MINUTE = 20;

/** Formats transcribe-1-pro accepts, by Content-Type, with the file name the
 * upload gets. Fish detects the format from the bytes, so the name only has
 * to be plausible. */
const AUDIO_TYPES: Record<string, string> = {
  "audio/mp4": "audio.m4a",
  "audio/m4a": "audio.m4a",
  "audio/x-m4a": "audio.m4a",
  "audio/aac": "audio.aac",
  "audio/wav": "audio.wav",
  "audio/x-wav": "audio.wav",
  "audio/wave": "audio.wav",
  "audio/mpeg": "audio.mp3",
  "audio/ogg": "audio.ogg",
  "audio/webm": "audio.webm",
  "audio/flac": "audio.flac",
};

export function blobAudioFileName(contentType: string): string | undefined {
  return AUDIO_TYPES[contentType.split(";")[0].trim().toLowerCase()];
}

/** A lowercase two-letter ISO 639-1 hint, or undefined. */
export function transcribeLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

const limiter = perUserMinuteLimiter(BLOB_TRANSCRIBE_PER_MINUTE);

export function blobTranscribeRateLimited(
  user: string,
  now = Date.now(),
): boolean {
  return limiter.limited(user, now);
}

export function resetBlobTranscribeRateLimit(): void {
  limiter.reset();
}

/** Speaker markers (`<|speaker:0|>`) and bracketed event cues (`[laughter]`)
 * are not words that were said. They are asked off upstream; this is the
 * backstop. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/<\|[^|]*\|>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type TranscribeResult =
  | { ok: true; text: string; language?: string }
  | { ok: false; status: number; error: string };

export async function transcribeBlobAudio(
  audio: Uint8Array<ArrayBuffer>,
  fileName: string,
  language?: string,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const key = await blobFishKey();
  if (!key)
    return { ok: false, status: 503, error: "Blob speech is not configured" };
  const form = new FormData();
  form.append("audio", new Blob([audio]), fileName);
  if (language) form.append("language", language);
  form.append("ignore_timestamps", "true");
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");
  let res: Response;
  try {
    res = await fetch(FISH_ASR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, model: FISH_ASR_MODEL },
      body: form,
      signal,
    });
  } catch {
    return { ok: false, status: 502, error: "Fish Audio is unreachable" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: 502, error: upstreamError(res.status) };
  }
  const body: unknown = await res.json().catch(() => null);
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof record.text !== "string")
    return { ok: false, status: 502, error: "Fish Audio returned no text" };
  return {
    ok: true,
    text: cleanTranscript(record.text),
    language: transcribeLanguage(record.language_code),
  };
}
