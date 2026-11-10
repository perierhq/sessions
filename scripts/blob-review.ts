#!/usr/bin/env bun
/**
 * Fetch the Blob review (GET /api/blob/review) from a running server and
 * print it as JSON. Used by the blob-review skill.
 *
 *   bun scripts/blob-review.ts [--days 14] [--user Name] [--entries]
 *
 * OPENSESSION_URL is the server (default http://127.0.0.1:3850); OS1_TOKEN
 * is the owner's bearer token. `--user` names the person when the server
 * runs without sign-in. `--entries` also fetches the owner message and the
 * reply of every sampled turn (GET /api/sessions/:id/entry/:entryId), cut
 * to 600 characters, under `entries`, so the agent can read what went wrong
 * without paging the whole transcript. The output stays on this machine.
 */
import { parseArgs } from "node:util";

const ENTRY_CHARS = 600;

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "14" },
    user: { type: "string" },
    entries: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    "bun scripts/blob-review.ts [--days 14] [--user Name] [--entries]\n" +
      "Env: OPENSESSION_URL (default http://127.0.0.1:3850), OS1_TOKEN",
  );
  process.exit(0);
}

const base = (process.env.OPENSESSION_URL ?? "http://127.0.0.1:3850").replace(
  /\/+$/,
  "",
);
const token = process.env.OS1_TOKEN?.trim();
const headers: Record<string, string> = token
  ? { Authorization: `Bearer ${token}` }
  : {};

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok)
    throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const query = new URLSearchParams({ days: values.days ?? "14" });
if (values.user) query.set("user", values.user);
const review = (await get(`/api/blob/review?${query}`)) as {
  samples?: Record<
    string,
    Array<{ sessionId?: string; entryId?: string; replyEntryId?: string }>
  >;
};

if (values.entries) {
  const wanted = new Map<string, { sessionId: string; entryId: string }>();
  for (const list of Object.values(review.samples ?? {}))
    for (const sample of list) {
      if (!sample.sessionId) continue;
      for (const entryId of [sample.entryId, sample.replyEntryId])
        if (entryId)
          wanted.set(`${sample.sessionId}/${entryId}`, {
            sessionId: sample.sessionId,
            entryId,
          });
    }
  const entries: Record<string, string> = {};
  for (const [key, { sessionId, entryId }] of wanted) {
    try {
      const entry = (await get(
        `/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(entryId)}`,
      )) as { content?: string };
      entries[key] = (entry.content ?? "").slice(0, ENTRY_CHARS);
    } catch (error) {
      entries[key] =
        `(unavailable: ${error instanceof Error ? error.message : error})`;
    }
  }
  console.log(JSON.stringify({ ...review, entries }, null, 2));
} else {
  console.log(JSON.stringify(review, null, 2));
}
