/**
 * Blob glossary route (src/server/blob-glossary.ts). Like every /api route
 * it sits behind the gateway's sign-in gate.
 *
 *   GET /api/blob/glossary   { terms: string[] }   at most 100 terms
 */
import type { RouteContext } from "./context";
import { GLOSSARY_CACHE_MS, blobGlossary } from "../blob-glossary";

export async function handleBlobGlossaryRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== "/api/blob/glossary" || req.method !== "GET") return undefined;
  return Response.json(
    { terms: blobGlossary() },
    {
      headers: {
        "Cache-Control": `private, max-age=${GLOSSARY_CACHE_MS / 1000}`,
      },
    },
  );
}
