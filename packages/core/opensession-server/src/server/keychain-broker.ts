/**
 * The keychain broker: one HTTPS call with a borrowed credential, made from
 * inside this process for the call_credential tool (keychain-tools.ts).
 *
 * The session is the caller's, taken from the run-rpc token that routed the
 * tool call, never from anything the agent supplies. So a grant is usable
 * only in the session it was issued to; its id alone authorizes nothing.
 *
 * The request goes only to the credential's host over HTTPS on the default
 * port, through the same address policy as web_fetch and incident egress
 * (shared/pinned-fetch.ts): the host is resolved once, refused if any
 * address is private, loopback or link-local, and the connection dials only
 * the checked addresses. The method and the normalized path are checked
 * against the credential's ceiling after URL parsing, so `..` segments
 * cannot step outside an allowed prefix. Redirects are returned unread,
 * never followed. The secret is scrubbed from the response headers and
 * body, and a statusOnly credential returns nothing but the status.
 *
 * A workspace credential needs no grant from its owner: the session's first
 * call mints its implicit workspace grant. Each call to it must say why
 * (`purpose`), and the audit line records that and who made the call.
 *
 * An incident agent's call (`incident` set by the server, never by the
 * agent) uses only that incident's grant in this session. It never mints a
 * workspace grant, and it never falls back to an interactive grant.
 */

import { STATUS_CODES } from "node:http";
import { audit, auditAsync } from "./audit";
import {
  BlockedAddressError,
  DECODABLE_ACCEPT_ENCODING,
  defaultPinnedFetchDeps,
  type PinnedFetchDeps,
  type PinnedResponse,
  resolvePinnedTarget,
  untilAborted,
  withDefaultHeaders,
} from "./shared/pinned-fetch";
import {
  activeGrantFor,
  activeIncidentGrantFor,
  brokerHeaders,
  consumeGrantForBroker,
  displaySafe,
  ensureKeychainLoaded,
  headerProblem,
  findCredential,
  isWorkspaceCredential,
  prepareCredentialTest,
  recordCredentialUse,
  scrubSecret,
  suspendedGrantFor,
  SUSPENDED_GRANT_ERROR,
  testRefusal,
  workspaceGrantFor,
} from "./keychain";

export const BROKER_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type BrokerMethod = (typeof BROKER_METHODS)[number];

const BROKER_TIMEOUT_MS = 30_000;
/** What we read of a response body, and what reaches the model of it. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RETURNED_CHARS = 60_000;

/** Request headers the agent may set. Everything else is dropped, so it
 *  cannot override the injected credential, cookies or the host. */
const FORWARDED_HEADERS = new Set([
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "idempotency-key",
  "user-agent",
]);
/** Response headers worth showing. */
const RETURNED_HEADERS = ["content-type", "location", "retry-after", "etag"];

export interface BrokerCallInput {
  sessionId: string;
  credential: string;
  method: BrokerMethod;
  /** Path and optional query on the credential's host, starting with "/". */
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Who is driving the session, for the audit line. */
  requestedBy?: string;
  /** Why this call is made. Required for a workspace credential, where no
   *  owner approved a purpose; recorded with the call either way. */
  purpose?: string;
  signal?: AbortSignal;
  /** Set by the incident access server for an incident agent: the call may
   *  use only this incident's grant. */
  incident?: { incidentId: string; role: string };
  /** The pinned connection's seams. Test seam. */
  net?: Partial<PinnedFetchDeps>;
}

export type BrokerCallResult =
  | { error: string }
  | {
      status: number;
      statusOnly?: true;
      headers?: Record<string, string>;
      body?: string;
      truncated?: true;
    };

export async function brokerCall(
  input: BrokerCallInput,
): Promise<BrokerCallResult> {
  await ensureKeychainLoaded();
  const meta = findCredential(input.credential);
  if (!meta)
    return {
      error: `no credential matches "${input.credential}"; list_credentials shows the ones in the keychain`,
    };
  if (/^[a-z][a-z0-9+.-]*:/i.test(input.path))
    return {
      error: `pass only the path and query: ${meta.service} calls https://${meta.host} itself, e.g. /v1/items?limit=5`,
    };
  if (!input.path.startsWith("/") || input.path.startsWith("//"))
    return {
      error: `path must start with a single / and stay on https://${meta.host}`,
    };
  let target: URL;
  try {
    target = new URL(`https://${meta.host}${input.path}`);
  } catch {
    return { error: "path is not a valid URL path" };
  }
  if (target.hostname !== meta.host || target.port || target.username)
    return { error: `path must stay on https://${meta.host}` };

  const purpose = displaySafe(input.purpose) || "";
  const incident = input.incident;
  const incidentFields = incident
    ? { incident_id: incident.incidentId, incident_role: incident.role }
    : {};
  const who = {
    credential_id: meta.id,
    service: meta.service,
    session_id: input.sessionId,
    method: input.method,
    path: target.pathname,
    ...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
    ...incidentFields,
  };
  /** A refused call, on the record with the credential it named. */
  const deny = (error: string, grantId?: string): { error: string } => {
    audit({
      kind: "keychain_broker_denied",
      ...who,
      ...(grantId ? { grant_id: grantId } : {}),
      reason: error,
    });
    return { error };
  };
  let grant = incident
    ? activeIncidentGrantFor(input.sessionId, meta.id, incident.incidentId)
    : activeGrantFor(input.sessionId, meta.id);
  if (incident && !grant)
    return deny(`This agent holds no grant for ${meta.service}`);
  const workspace = !incident && isWorkspaceCredential(meta);
  if (workspace && !purpose && (!grant || grant.mode === "workspace"))
    return {
      error: `${meta.service} is a workspace credential: pass purpose, one sentence saying why you make this call. It is recorded with the call`,
    };
  if (!grant && workspace) {
    const minted = await workspaceGrantFor({
      credential: meta.id,
      sessionId: input.sessionId,
      requestedBy: input.requestedBy || "unknown",
      purpose,
    });
    if ("error" in minted) return minted;
    grant = minted;
  }
  if (!grant && suspendedGrantFor(input.sessionId, meta.id))
    return deny(`${meta.service}: ${SUSPENDED_GRANT_ERROR}`);
  if (!grant)
    return deny(
      `this session holds no live grant for ${meta.service}. Ask its owner with request_credential first.`,
    );
  // Checked before the grant is spent: a header that can't be sent would
  // fail the request after a once grant was already used.
  const forwarded: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers || {}))
    if (FORWARDED_HEADERS.has(k.toLowerCase())) forwarded[k.toLowerCase()] = v;
  const unsendable = headerProblem(forwarded);
  if (unsendable) return { error: unsendable };
  const use = consumeGrantForBroker(
    grant.id,
    input.sessionId,
    input.method,
    target.pathname,
    incident?.incidentId,
  );
  if ("error" in use) return deny(use.error, grant.id);
  const { credential } = use;

  const headers = new Headers(forwarded);
  for (const [k, v] of Object.entries(brokerHeaders(credential)))
    headers.set(k, v);

  // One line per call, written once its outcome is known.
  const started = Date.now();
  const called = grant;
  const settle = (
    outcome: { status: number; bytes: number } | { error: string },
  ) => {
    audit({
      kind: "keychain_broker_call",
      ...who,
      grant_id: called.id,
      owner: called.owner,
      host: credential.host,
      mode: called.mode,
      ...(purpose ? { purpose } : {}),
      ...outcome,
      duration_ms: Date.now() - started,
    });
    recordCredentialUse(credential.id, {
      sessionId: input.sessionId,
      ...(input.requestedBy ? { by: input.requestedBy } : {}),
      ...("status" in outcome
        ? { status: outcome.status }
        : { error: outcome.error }),
    });
  };

  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(BROKER_TIMEOUT_MS)])
    : AbortSignal.timeout(BROKER_TIMEOUT_MS);
  let res: PinnedResponse;
  try {
    res = await credentialRequest(
      target,
      {
        method: input.method,
        headers: Object.fromEntries(headers),
        ...(input.method === "GET" || input.method === "HEAD" || !input.body
          ? {}
          : { body: input.body }),
        signal,
        // A status-only call stops reading at the first byte.
        maxBodyBytes: credential.statusOnly ? 1 : MAX_BODY_BYTES,
      },
      input.net,
    );
  } catch (e: any) {
    const error = credentialRequestError(credential.host, e);
    settle({ error });
    return { error };
  }
  settle({ status: res.status, bytes: res.body.length });

  if (credential.statusOnly) return { status: res.status, statusOnly: true };

  const scrub = (text: string) => scrubSecret(text, credential.secret);
  const outHeaders: Record<string, string> = {};
  for (const name of RETURNED_HEADERS) {
    const v = res.headers.get(name);
    if (v) outHeaders[name] = scrub(v);
  }
  const contentType = res.headers.get("content-type") || "";
  const textual =
    !res.undecodable &&
    (!contentType ||
      /text\/|json|xml|x-www-form-urlencoded/i.test(contentType));
  const bytes = res.body;
  const cut = res.truncated === true;
  if (!textual)
    return {
      status: res.status,
      headers: outHeaders,
      body: `[${bytes.length}${cut ? "+" : ""} bytes of ${
        res.undecodable
          ? `${res.headers.get("content-encoding") || "encoded"} content`
          : contentType
      } omitted]`,
    };
  let body = scrub(new TextDecoder().decode(bytes));
  let truncated = cut;
  if (body.length > MAX_RETURNED_CHARS) {
    body = body.slice(0, MAX_RETURNED_CHARS);
    truncated = true;
  }
  return {
    status: res.status,
    headers: outHeaders,
    body,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

const TEST_TIMEOUT_MS = 15_000;

export type CredentialTestResult =
  | { status: number; reason: string }
  | { error: string };

/**
 * The owner's status-only test: one GET with the credential as they are
 * editing it (saved, saved with unsaved changes, or a draft), to its test
 * path or the one given, within its limits and through the same address
 * policy as every call. Only the status comes back: the body is never read.
 * Nothing is saved, no grant is involved, and the attempt is audited as
 * keychain_test without the secret.
 */
export async function testCredential(input: {
  /** The verified person testing; must own a saved credential. */
  by: string;
  credentialId?: string;
  spec?: Parameters<typeof prepareCredentialTest>[0]["spec"];
  secret?: string;
  path?: string;
  net?: Partial<PinnedFetchDeps>;
}): Promise<CredentialTestResult> {
  await ensureKeychainLoaded();
  let prepared: ReturnType<typeof prepareCredentialTest>;
  try {
    prepared = prepareCredentialTest(input);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const { credential, path } = prepared;
  const target = new URL(`https://${credential.host}${path}`);
  const result: CredentialTestResult = await (async () => {
    if (target.hostname !== credential.host || target.port || target.username)
      return { error: `the test path must stay on https://${credential.host}` };
    const refusal = testRefusal(credential, target.pathname);
    if (refusal) return { error: refusal };
    try {
      const res = await credentialRequest(
        target,
        {
          method: "GET",
          headers: brokerHeaders(credential),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
          maxBodyBytes: 1,
        },
        input.net,
      );
      return { status: res.status, reason: STATUS_CODES[res.status] ?? "" };
    } catch (e) {
      return { error: credentialRequestError(credential.host, e) };
    }
  })();
  auditAsync({
    kind: "keychain_test",
    ...(input.credentialId ? { credential_id: input.credentialId } : {}),
    service: credential.service,
    host: credential.host,
    path: target.pathname,
    by: input.by,
    ...("status" in result
      ? { status: result.status }
      : { error: result.error }),
  });
  return result;
}

/**
 * One request to a credential's host, for the broker and the scripted-run
 * proxy: resolved once, refused if any address is private, and connected
 * only to the checked addresses. A redirect comes back unread. A body over
 * `maxBodyBytes` is cut there and marked `truncated`.
 *
 * Accept-Encoding is always the proxy's, never the caller's: it names only
 * the codings the pinned transport decodes, so the body reaches the secret
 * scrubber as text. A server that answers in another coding anyway comes
 * back `undecodable`, and the caller must not hand that body on raw.
 */
export async function credentialRequest(
  target: URL,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    signal: AbortSignal;
    maxBodyBytes: number;
  },
  net?: Partial<PinnedFetchDeps>,
): Promise<PinnedResponse> {
  const deps: PinnedFetchDeps = { ...defaultPinnedFetchDeps, ...net };
  const pinned = await untilAborted(
    resolvePinnedTarget(target.href, deps),
    init.signal,
  );
  return untilAborted(
    deps.send(
      pinned,
      {
        method: init.method,
        headers: {
          ...withDefaultHeaders(
            Object.fromEntries(
              Object.entries(init.headers).filter(
                ([name]) => name.toLowerCase() !== "accept-encoding",
              ),
            ),
          ),
          "accept-encoding": DECODABLE_ACCEPT_ENCODING,
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: init.signal,
        maxBodyBytes: init.maxBodyBytes,
        overflow: "truncate",
      },
      deps.isBlocked,
    ),
    init.signal,
  );
}

/** What a failed credentialRequest tells the caller: a refusal by address
 *  policy says why; anything else says only that it failed. */
export function credentialRequestError(host: string, error: unknown): string {
  if (error instanceof BlockedAddressError)
    return `the request to ${host} was refused: ${error.message}`;
  const name = (error as { name?: unknown } | null)?.name;
  return `the request to ${host} ${name === "TimeoutError" ? "timed out" : "failed"}`;
}

export async function readCapped(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    if (value.length > room) {
      chunks.push(value.subarray(0, room));
      size = max;
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, cut };
}
