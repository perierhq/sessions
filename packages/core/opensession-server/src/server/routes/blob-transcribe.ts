/**
 * Blob transcription route (src/server/blob-transcribe.ts).
 *
 * `POST /api/blob/transcribe?language=pl` takes the raw recording as the body
 * with its audio Content-Type, the same raw-bytes shape as the profile picture
 * upload (routes/profile.ts), and answers `{ text, language? }`. Like every
 * /api route it sits behind the gateway's sign-in gate.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  BLOB_TRANSCRIBE_MAX_BYTES,
  blobAudioFileName,
  blobTranscribeRateLimited,
  transcribeBlobAudio,
  transcribeLanguage,
} from "../blob-transcribe";

const tooLarge = () =>
  Response.json(
    { error: "That recording is too large. The limit is 10MB." },
    { status: 413 },
  );

/** Reads the body, stopping as soon as it passes `max` bytes (a chunked
 * upload has no Content-Length to check first). Undefined when too large. */
async function readCapped(
  req: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function handleBlobTranscribeRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;
  if (path !== "/api/blob/transcribe" || req.method !== "POST")
    return undefined;

  const fileName = blobAudioFileName(req.headers.get("content-type") || "");
  if (!fileName)
    return Response.json(
      { error: "Send the recording as m4a, aac, wav, mp3, ogg, webm or flac" },
      { status: 415 },
    );
  if (
    Number(req.headers.get("content-length") || 0) > BLOB_TRANSCRIBE_MAX_BYTES
  )
    return tooLarge();
  const user = requestUser(ctx) || "anonymous";
  if (blobTranscribeRateLimited(user))
    return Response.json(
      { error: "Too many transcription requests, try again in a minute" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  const audio = await readCapped(req, BLOB_TRANSCRIBE_MAX_BYTES).catch(
    () => null,
  );
  if (audio === undefined) return tooLarge();
  if (!audio?.byteLength)
    return Response.json({ error: "The recording is empty" }, { status: 400 });

  // The client hanging up cancels the upstream request too.
  const result = await transcribeBlobAudio(
    audio,
    fileName,
    transcribeLanguage(url.searchParams.get("language")),
    req.signal,
  );
  if (!result.ok)
    return Response.json({ error: result.error }, { status: result.status });
  return Response.json(
    { text: result.text, language: result.language },
    { headers: { "Cache-Control": "no-store" } },
  );
}
