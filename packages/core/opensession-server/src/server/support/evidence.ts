// What a support session's own tool calls returned, so a draft's sources
// can be checked against them (verify.ts): the URLs its web_fetch read and
// the record ids its Support connector calls returned (from the call's
// arguments and the start of its result). Fed from the run's stream events
// on the server (run-session.ts, session-create.ts), as the Plain
// discussion mirror is (agents/plain/discussion-mirror.ts). In memory and
// bounded: a restart forgets it, so a draft cites nothing verifiable and
// waits for a person. Never logged. Nothing runs at import.
import { MCP_CALL_TOOL } from "@tellahq/opensession-protocol/tool-presentation";
import type { StreamEvent } from "../run-events";
import { WEB_FETCH_TOOL } from "../pi-web-search";

/** Sessions remembered at most; the oldest is forgotten first. */
const MAX_SESSIONS = 200;
/** Per session. */
const MAX_URLS = 100;
const MAX_IDS = 2_000;
/** Tool calls waiting for their result, across sessions. */
const MAX_PENDING = 500;
const MAX_ID_CHARS = 200;
/** The support session's own tools are no connector. */
const OWN_SERVER = "opensession-support";

interface Evidence {
  urls: Set<string>;
  /** `<connector>\0<id>` */
  records: Set<string>;
}

const sessions = new Map<string, Evidence>();
const pending = new Map<
  string,
  { sessionId: string; tool: string; input: unknown }
>();

export function __resetSupportEvidenceForTest(): void {
  sessions.clear();
  pending.clear();
}

function evidenceFor(sessionId: string): Evidence {
  let e = sessions.get(sessionId);
  if (e) {
    // Most recently used last.
    sessions.delete(sessionId);
    sessions.set(sessionId, e);
    return e;
  }
  e = { urls: new Set(), records: new Set() };
  sessions.set(sessionId, e);
  while (sessions.size > MAX_SESSIONS)
    sessions.delete(sessions.keys().next().value!);
  return e;
}

function add(set: Set<string>, value: string, max: number): void {
  if (set.has(value)) set.delete(value);
  set.add(value);
  while (set.size > max) set.delete(set.values().next().value!);
}

/** A URL as compared: no fragment, no trailing slash on the path, host in
 *  lower case. null when it isn't an http(s) URL. */
export function normalizeEvidenceUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    const href = url.href;
    return href.endsWith("/") && url.pathname !== "/"
      ? href.slice(0, -1)
      : href;
  } catch {
    return null;
  }
}

/** The stream carries no error flag on results; an "Error…" body is the
 *  tell (as discussion-mirror.ts reads it). */
function looksLikeError(content: string): boolean {
  return /^\s*(error|✗|failed|mcp error)\b/i.test(content);
}

/** A web_fetch that worked starts with the untrusted-content label
 *  (pi-web-search.ts labelUntrusted). */
const FETCHED = /^\[Untrusted web content from an? .+ web page read\./;

/** The connector a catalog tool id belongs to (`<server>_<tool>`). */
function connectorOf(toolId: unknown): string | null {
  if (typeof toolId !== "string") return null;
  const cut = toolId.indexOf("_");
  if (cut <= 0) return null;
  const server = toolId.slice(0, cut);
  return server === OWN_SERVER ? null : server;
}

/** Every string in a tool's arguments, a few levels deep. */
function strings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= 50 || depth > 4) return out;
  if (typeof value === "string") {
    if (value.length > 0 && value.length <= MAX_ID_CHARS) out.push(value);
  } else if (typeof value === "number" && Number.isFinite(value)) {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) strings(v, depth + 1, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) strings(v, depth + 1, out);
  }
  return out;
}

const ID_TOKEN = /[A-Za-z0-9][A-Za-z0-9_.:@-]{2,127}/g;

/** A tool call of support session `sessionId` started. Only web_fetch and
 *  catalog calls are kept. */
export function supportToolUse(
  sessionId: string | undefined,
  support: boolean,
  event: Pick<StreamEvent, "toolName" | "toolInput" | "toolUseId">,
): void {
  if (!support || !sessionId || !event.toolUseId || !event.toolName) return;
  if (event.toolName !== WEB_FETCH_TOOL && event.toolName !== MCP_CALL_TOOL)
    return;
  pending.set(event.toolUseId, {
    sessionId,
    tool: event.toolName,
    input: event.toolInput,
  });
  while (pending.size > MAX_PENDING)
    pending.delete(pending.keys().next().value!);
}

/** The result of a tool call supportToolUse kept. */
export function supportToolResult(
  event: Pick<StreamEvent, "toolUseId" | "content">,
): void {
  if (!event.toolUseId) return;
  const call = pending.get(event.toolUseId);
  if (!call) return;
  pending.delete(event.toolUseId);
  const content = event.content ?? "";
  if (looksLikeError(content)) return;
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (call.tool === WEB_FETCH_TOOL) {
    if (!FETCHED.test(content) || typeof input.url !== "string") return;
    const url = normalizeEvidenceUrl(input.url);
    if (url) add(evidenceFor(call.sessionId).urls, url, MAX_URLS);
    return;
  }
  const connector = connectorOf(input.name);
  if (!connector || !content.trim()) return;
  const records = evidenceFor(call.sessionId).records;
  const ids = new Set(strings(input.arguments).map((x) => x.trim()));
  for (const [token] of content.matchAll(ID_TOKEN)) ids.add(token);
  for (const id of ids)
    if (id && id.length <= MAX_ID_CHARS)
      add(records, `${connector}\u0000${id}`, MAX_IDS);
}

/** Whether `sessionId`'s web_fetch read `url`. */
export function sessionFetched(sessionId: string, url: string): boolean {
  const normal = normalizeEvidenceUrl(url);
  return normal !== null && !!sessions.get(sessionId)?.urls.has(normal);
}

/** Whether a `connector` call of `sessionId` returned record `id`. */
export function sessionReturnedRecord(
  sessionId: string,
  connector: string,
  id: string,
): boolean {
  return !!sessions.get(sessionId)?.records.has(`${connector}\u0000${id}`);
}
