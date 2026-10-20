import { BlockedAddressError, pinnedFetch } from "./shared/pinned-fetch";
import { assertFetchableUrl } from "./web-fetch";

export interface OauthDiscovery {
  resource?: string;
  scopes?: string[];
  endpoints: { authorize: string; token: string; register?: string };
  /** The AS accepts an HTTPS URL as client_id (Client ID Metadata Documents). */
  clientIdMetadataDocument?: true;
}

/** A definitive absence can be cached; transport failures must be retried soon. */
export class OauthDiscoveryError extends Error {
  constructor(readonly transient: boolean) {
    super("No valid OAuth authorization-server metadata for this MCP resource");
  }
}

const MAX_METADATA_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

/** A configured origin is already trusted as an MCP target. Metadata may not
 * turn that trust into access to another private service or plaintext origin. */
async function discoveryUrl(raw: unknown, resource: URL): Promise<URL> {
  if (typeof raw !== "string" || raw.length > 4096)
    throw new Error("Invalid OAuth metadata URL");
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.origin !== resource.origin && url.protocol !== "https:")
  )
    throw new Error("Unsafe OAuth metadata URL");
  if (url.origin !== resource.origin) {
    try {
      await assertFetchableUrl(url.href);
    } catch (error) {
      // DNS lookup errors carry a code; policy rejections do not.
      if (error instanceof Error && "code" in error)
        throw new OauthDiscoveryError(true);
      throw error;
    }
  }
  return url;
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    // Observe work even if the deadline already elapsed, so a late rejection
    // from DNS or a cancelled stream cannot become an unhandled rejection.
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function metadata(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error("OAuth metadata unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await bounded(reader.read(), signal).catch(() => {
        throw new OauthDiscoveryError(true);
      });
      if (done) break;
      size += value.length;
      if (size > MAX_METADATA_BYTES)
        throw new Error("OAuth metadata too large");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid OAuth metadata");
  return value as Record<string, unknown>;
}

/** Only Bearer challenges may supply resource_metadata. Split on commas outside
 * quoted strings so a Basic realm cannot smuggle a discovery parameter. */
function challengeMetadata(header: string): string | undefined {
  if (header.length > 8192) return undefined;
  let bearer = false;
  for (const part of header.match(/(?:[^,"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ??
    []) {
    const challenge = part.trim().match(/^([\w-]+)\s+(?![=\s])(.*)$/);
    const param = challenge ? challenge[2]! : part.trim();
    if (challenge) bearer = challenge[1]!.toLowerCase() === "bearer";
    const match = param.match(/^resource_metadata\s*=\s*"([^"\\]*)"\s*$/i);
    if (bearer && match) return match[1];
  }
  return undefined;
}

/** RFC 9728 binds the document to the requested resource. Like the MCP SDK,
 * also accept a same-origin parent path (an origin-wide `https://acme.test`
 * document for `https://acme.test/mcp`), but never a sibling path, a longer
 * path, or one carrying its own query or fragment. */
function coversResource(raw: string, requested: URL): boolean {
  const advertised = new URL(raw);
  if (advertised.href === requested.href) return true;
  if (
    advertised.origin !== requested.origin ||
    advertised.search ||
    advertised.hash
  )
    return false;
  const slash = (path: string) => (path.endsWith("/") ? path : `${path}/`);
  return (
    advertised.pathname.length <= requested.pathname.length &&
    slash(requested.pathname).startsWith(slash(advertised.pathname))
  );
}

function wellKnown(issuer: URL, name: string): string[] {
  const path =
    issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return [
    `${issuer.origin}/.well-known/${name}${path}`,
    `${issuer.origin}${path}/.well-known/${name}`,
  ];
}

/** RFC 9728 resource discovery followed by RFC 8414 / OIDC issuer discovery.
 * No credentials, redirects, recursive discovery, or unbounded provider lists.
 * One deadline covers DNS, all requests, and streaming JSON bodies.
 * Requests to the configured server's own origin are trusted like the server
 * itself; any other origin is resolved, checked and pinned at request time,
 * so a DNS answer that changes after `discoveryUrl` checked it cannot move
 * the request to a private address. */
export async function discoverMcpOauth(
  serverUrl: string,
): Promise<OauthDiscovery> {
  const resourceUrl = new URL(serverUrl);
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  let transient = false;
  const noteFailure = (error: unknown) => {
    transient ||=
      signal.aborted ||
      (error instanceof OauthDiscoveryError && error.transient);
  };
  const request = async (raw: string) => {
    signal.throwIfAborted();
    const url = await bounded(discoveryUrl(raw, resourceUrl), signal);
    const init = {
      headers: { Accept: "application/json" },
      redirect: "error" as const,
      signal,
    };
    const response = await bounded(
      url.origin === resourceUrl.origin
        ? fetch(url.href, { ...init, credentials: "omit" })
        : pinnedFetch(url.href, init),
      signal,
    ).catch((error) => {
      // A private address is a policy refusal, not a transport failure.
      if (error instanceof BlockedAddressError) throw error;
      throw new OauthDiscoveryError(true);
    });
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    )
      transient = true;
    return response;
  };
  // Validate the configured target too (notably userinfo, fragments and schemes).
  await bounded(discoveryUrl(serverUrl, resourceUrl), signal);
  let advertised: string | undefined;
  try {
    const response = await request(serverUrl);
    if (response.status === 401)
      advertised = challengeMetadata(
        response.headers.get("www-authenticate") ?? "",
      );
    void response.body?.cancel().catch(() => {});
  } catch (error) {
    noteFailure(error);
  }

  const path = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname;
  const candidates = new Set([
    ...(advertised ? [advertised] : []),
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${path}`,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
  ]);
  let resource: string | undefined;
  let scopes: string[] | undefined;
  let issuer = resourceUrl.origin;
  for (const candidate of candidates) {
    try {
      const pr = await metadata(await request(candidate), signal);
      if (
        typeof pr.resource !== "string" ||
        !coversResource(pr.resource, resourceUrl)
      )
        continue;
      if (
        !Array.isArray(pr.authorization_servers) ||
        !pr.authorization_servers.length
      )
        continue;
      const nextIssuer = await bounded(
        discoveryUrl(pr.authorization_servers[0], resourceUrl),
        signal,
      );
      if (nextIssuer.search) continue;
      if (
        pr.scopes_supported !== undefined &&
        (!Array.isArray(pr.scopes_supported) ||
          !pr.scopes_supported.every((s) => typeof s === "string"))
      )
        continue;
      resource = pr.resource as string;
      scopes = pr.scopes_supported as string[] | undefined;
      issuer = pr.authorization_servers[0] as string;
      break;
    } catch (error) {
      noteFailure(error);
    }
  }
  // Keep legacy origin-only AS discovery for servers without RFC 9728 metadata.
  const asCandidates = new Set([
    ...wellKnown(new URL(issuer), "oauth-authorization-server"),
    // OIDC's standard form appends to the issuer path; also support insertion.
    ...wellKnown(new URL(issuer), "openid-configuration").reverse(),
  ]);
  for (const candidate of asCandidates) {
    try {
      const as = await metadata(await request(candidate), signal);
      // Advertised issuers must match exactly. For the legacy origin guess,
      // accept the root slash that URL serialization inserts on our behalf.
      if (
        typeof as.issuer !== "string" ||
        (resource
          ? as.issuer !== issuer
          : new URL(as.issuer).href !== new URL(issuer).href)
      )
        continue;
      const authorize = await bounded(
        discoveryUrl(as.authorization_endpoint, resourceUrl),
        signal,
      );
      const token = await bounded(
        discoveryUrl(as.token_endpoint, resourceUrl),
        signal,
      );
      const register =
        as.registration_endpoint === undefined
          ? undefined
          : await bounded(
              discoveryUrl(as.registration_endpoint, resourceUrl),
              signal,
            );
      return {
        resource,
        scopes,
        endpoints: {
          authorize: authorize.href,
          token: token.href,
          register: register?.href,
        },
        ...(as.client_id_metadata_document_supported === true
          ? { clientIdMetadataDocument: true as const }
          : {}),
      };
    } catch (error) {
      noteFailure(error);
    }
  }
  throw new OauthDiscoveryError(transient);
}
