/**
 * Blob speech routes (src/server/blob-speech.ts): the Blob app reads its
 * answers aloud through Fish Audio without ever holding the API key.
 *
 * `status`, `key` and `settings` mirror the Desk voice settings routes
 * (routes/desk-voice.ts). `POST /api/blob/speech` streams the mp3 straight
 * from Fish to the device. Like every /api route, these sit behind the
 * gateway's sign-in gate.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  blobSpeechRateLimited,
  blobSpeechStatus,
  setBlobSpeechKey,
  setBlobSpeechSettings,
  speechText,
  synthesizeBlobSpeech,
} from "../blob-speech";

async function statusResponse(): Promise<Response> {
  return Response.json(await blobSpeechStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function handleBlobSpeechRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== "/api/blob/speech" && !path.startsWith("/api/blob/speech/"))
    return undefined;

  if (path === "/api/blob/speech/status" && req.method === "GET")
    return statusResponse();

  if (path === "/api/blob/speech/key" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.apiKey !== "string")
      return Response.json(
        { error: "expected { apiKey: string }" },
        { status: 400 },
      );
    await setBlobSpeechKey(body.apiKey);
    return statusResponse();
  }

  if (path === "/api/blob/speech/settings" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object")
      return Response.json(
        { error: "expected { model: string, voiceId?: string | null }" },
        { status: 400 },
      );
    const result = await setBlobSpeechSettings(body);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: 400 });
    return statusResponse();
  }

  if (path === "/api/blob/speech" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const text = speechText(body?.text);
    if (!text)
      return Response.json(
        { error: "expected { text: string }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body?.user) || "anonymous";
    if (blobSpeechRateLimited(user))
      return Response.json(
        { error: "Too many speech requests, try again in a minute" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    // The client hanging up cancels the upstream request too.
    const result = await synthesizeBlobSpeech(text, req.signal);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: result.status });
    return new Response(result.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  }

  return undefined;
}
