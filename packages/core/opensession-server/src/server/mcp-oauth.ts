/**
 * Browser-based OAuth for HTTP MCP servers (the feeds design — "easy to
 * connect any MCP, per user as well").
 *
 * Replaces the unusable headless flow (pi's CLI OAuth listens on the
 * VPS's 127.0.0.1, unreachable from the user's browser): Open Session runs the
 * OAuth 2.1 + PKCE flow itself with a redirect to
 * `<publicBaseUrl>/api/connections/mcp-oauth/callback`, so a
 * Connect button works from any signed-in device (iPhone PWA included).
 *
 * Grants are stored per server in ~/.opensession-mcp-oauth.json (0600):
 * one optional `shared` grant (workspace-wide identity, like the Linear/Plain
 * servers today) and per-user grants keyed by canonical team name (same
 * identity table as commit attribution — the github-auth.ts pattern). At run
 * time withDynamicCredentials() injects `Authorization: Bearer <token>` into
 * the server's headers — the run user's own grant when they have one, else
 * the shared grant. Engines never see refresh tokens; rotation happens here:
 * a run awaits freshMcpAuthHeader before it connects (refreshing a grant
 * that is expired or about to be, with or without a user behind the run),
 * and a 2-minute ticker refreshes ahead of expiry. Refreshes are serialized
 * per grant across processes, so a rotating refresh token is spent once.
 *
 * Discovery follows the MCP auth spec: RFC 9728 protected-resource metadata
 * for the server resource → authorization server → RFC 8414 AS metadata →
 * dynamic client registration (RFC 7591, token_endpoint_auth_method "none").
 * When the AS has no registration endpoint or refuses registration but
 * accepts Client ID Metadata Documents, the client_id is instead the URL of
 * the document this instance serves on its public ingress (Oneleet, e.g.,
 * disables dynamic registration).
 */
import { randomBytes, createHash } from "crypto";
import { readFile, writeFile } from "node:fs/promises";
import { discoverMcpOauth, OauthDiscoveryError } from "./mcp-oauth-discovery";
import { configuredIngress, configuredServer, productName } from "./config";
import { statePath } from "./paths";
import { pinnedFetch } from "./shared/pinned-fetch";
import { resolveTeammate } from "./shared/user-mappings";
import { readJsonFileCopy } from "./shared/json-file-cache";
import { writeFileAtomic, writeFileAtomicAsync } from "./shared/atomic-write";
import { withFileLock } from "./shared/file-lock";

const STORE_PATH = statePath(".opensession-mcp-oauth.json");

interface OauthEndpoints {
  authorize: string;
  token: string;
  register?: string;
}

interface Grant {
  tokens: {
    accessToken: string;
    refreshToken?: string;
    /** ms epoch; absent = no known expiry. */
    expiresAt?: number;
  };
  updatedAt: string;
  /** Team member (or GitHub login fallback) who completed the flow. */
  connectedBy?: string;
  /** The provider refused the refresh token: the grant stops working at
   *  expiry, and only a new sign-in clears this. */
  refreshError?: { at: string; message: string };
}

interface ServerAuth {
  serverUrl: string;
  resource?: string;
  /** scopes_supported from RFC 9728 metadata — some ASes (Cognito, e.g.
   *  Plain's) reject unknown scopes, so the authorize request must stick to
   *  what the resource advertises. */
  scopes?: string[];
  endpoints: OauthEndpoints;
  clientInfo: { clientId: string };
  shared?: Grant;
  users?: Record<string, Grant>;
}

type Store = Record<string, ServerAuth>;

/**
 * Which grant slot on a ServerAuth we're talking about: the workspace-wide
 * one, or one team member's. Addressing a slot by name only ("shared" vs a
 * team name in the same string) let a caller pair one identity's grant with
 * another identity's slot, so a refresh could write a token into a slot it
 * never read from. The union keeps the two together.
 */
type GrantSlot = { kind: "shared" } | { kind: "user"; teamName: string };

/** A grant plus the slot it was read from — the expiry decision and the
 *  refreshed token's destination can no longer disagree. */
type GrantRef = GrantSlot & { grant: Grant };

/** Team name from a pending flow: absent = the shared grant. */
function slotFor(teamName?: string): GrantSlot {
  return teamName ? { kind: "user", teamName } : { kind: "shared" };
}

function slotLabel(slot: GrantSlot): string {
  return slot.kind === "shared" ? "shared" : slot.teamName;
}

function grantRef(
  auth: ServerAuth | undefined,
  slot: GrantSlot,
): GrantRef | undefined {
  const grant =
    slot.kind === "shared" ? auth?.shared : auth?.users?.[slot.teamName];
  return grant ? { ...slot, grant } : undefined;
}

function writeGrant(entry: ServerAuth, slot: GrantSlot, grant: Grant): void {
  if (slot.kind === "shared") entry.shared = grant;
  else entry.users = { ...(entry.users || {}), [slot.teamName]: grant };
}

function readStore(): Store {
  try {
    return readJsonFileCopy<Store>(STORE_PATH) ?? {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  writeFileAtomic(STORE_PATH, JSON.stringify(store, null, 2) + "\n", 0o600);
}

/**
 * Preset OAuth providers — servers whose OAuth is NOT the MCP spec (no RFC
 * 9728 discovery / dynamic registration). Slack: fixed app credentials from
 * the env, user-scope consent, token in authed_user.access_token (xoxp-,
 * "send messages as them"). The grant store/refresh/injection is shared
 * with MCP-spec grants; only start/complete differ.
 */
interface OauthPreset {
  authorize: string;
  token: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Query params for the authorize URL (slack: user_scope). */
  authorizeParams: Record<string, string>;
  /** Pull the token out of the exchange response. */
  extract(res: any): {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
  /** Env var the grant token is injected as for stdio MCP servers. */
  envVar?: string;
  /** Env var naming the person a stdio server acts for, as their Slack id
   *  when known, so it can credit them on what it posts. */
  senderEnvVar?: string;
}

const OAUTH_PRESETS: Record<string, OauthPreset> = {
  slack: {
    authorize: "https://slack.com/oauth/v2/authorize",
    token: "https://slack.com/api/oauth.v2.access",
    clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
    clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    authorizeParams: {
      user_scope:
        "channels:read,channels:write,groups:read,channels:history,groups:history,chat:write,files:write,users:read,search:read",
    },
    extract: (res) => ({
      accessToken: res?.authed_user?.access_token,
      refreshToken: res?.authed_user?.refresh_token,
      expiresIn: res?.authed_user?.expires_in,
    }),
    // Reads only: scripts/mcp-slack.ts always posts with its bot token.
    envVar: "SLACK_USER_TOKEN",
    senderEnvVar: "SLACK_POST_VIA",
  },
};

export function oauthPresetFor(name: string): OauthPreset | undefined {
  const p = OAUTH_PRESETS[name];
  if (!p) return undefined;
  return process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]
    ? p
    : undefined;
}

function callbackUrl(): string {
  return `${configuredServer().publicBaseUrl}/api/connections/mcp-oauth/callback`;
}

export const CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/** The public URL of this instance's client metadata document, which doubles
 *  as its client_id. Only an HTTPS public ingress can serve one: the
 *  authorization server fetches it from the internet. */
export function clientMetadataUrl(): string | undefined {
  const base = configuredIngress().publicBaseUrl;
  return base.startsWith("https://")
    ? `${base}${CLIENT_METADATA_PATH}`
    : undefined;
}

/** draft-ietf-oauth-client-id-metadata-document: a public PKCE client. */
export function clientMetadataDocument(clientId: string) {
  return {
    client_id: clientId,
    client_name: productName(),
    client_uri: configuredServer().publicBaseUrl,
    redirect_uris: [callbackUrl()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Public ingress route serving the client metadata document. */
export function mcpOauthPublicRoutes(): Map<
  string,
  (req: Request, url: URL) => Promise<Response>
> {
  return new Map([
    [
      `GET ${CLIENT_METADATA_PATH}`,
      async () => {
        const clientId = clientMetadataUrl();
        if (!clientId) return new Response(null, { status: 404 });
        return Response.json(clientMetadataDocument(clientId), {
          headers: { "Cache-Control": "public, max-age=300" },
        });
      },
    ],
  ]);
}

/** A POST to an authorization server. Redirects are refused, never followed:
 *  a 307 or 308 would resend the body (an authorization code, a refresh
 *  token) to wherever it pointed. An endpoint on the configured MCP server's
 *  own origin is trusted like the server itself, as discovery trusts it; any
 *  other origin is resolved, checked against private addresses and pinned at
 *  request time, so a DNS answer that changed since discovery cannot move
 *  the request. */
function oauthPost(
  endpoint: string,
  serverUrl: string,
  init: {
    headers: Record<string, string>;
    body: string | URLSearchParams;
    signal: AbortSignal;
  },
): Promise<Response> {
  const sameOrigin = (() => {
    try {
      const origin = new URL(endpoint).origin;
      return origin !== "null" && origin === new URL(serverUrl).origin;
    } catch {
      return false;
    }
  })();
  const headers = { Accept: "application/json", ...init.headers };
  return sameOrigin
    ? fetch(endpoint, { ...init, headers, method: "POST", redirect: "error" })
    : pinnedFetch(endpoint, {
        ...init,
        headers,
        method: "POST",
        redirect: "error",
      });
}

/** Dynamic client registration (RFC 7591). Returns the client_id. */
async function registerClient(
  name: string,
  register: string,
  serverUrl: string,
): Promise<string> {
  const registrationUrl = new URL(register);
  const registrationResponse = await oauthPost(register, serverUrl, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: productName(),
      redirect_uris: [callbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const registrationText = await registrationResponse.text();
  if (!registrationResponse.ok) {
    if (
      registrationResponse.status === 403 &&
      registrationUrl.hostname === "api.figma.com"
    ) {
      throw new Error(
        "Figma does not currently allow Open Session to connect. Its remote MCP server accepts only clients listed in the Figma MCP Catalog.",
      );
    }
    if (
      registrationResponse.status === 400 &&
      registrationText.includes("invalid_redirect_uri") &&
      registrationUrl.hostname === "vercel.com"
    ) {
      // Vercel MCP is a closed program: only clients Vercel has reviewed get
      // their redirect URI approved (docs/agent-resources/vercel-mcp).
      throw new Error(
        "Vercel MCP only connects to AI clients Vercel has approved (Claude Code, ChatGPT, Cursor, …), so it rejects Open Session's callback URL.",
      );
    }
    const detail = registrationText.trim().slice(0, 200);
    throw new Error(
      `${name}: client registration failed (HTTP ${registrationResponse.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  let reg: { client_id?: string; error_description?: string };
  try {
    reg = JSON.parse(registrationText);
  } catch {
    throw new Error(`${name}: client registration returned invalid JSON`);
  }
  if (!reg.client_id)
    throw new Error(
      `${name}: client registration failed (${reg.error_description || "no client_id"})`,
    );
  return reg.client_id;
}

/** Ensure a public client for this server (cached in the store): a dynamic
 *  registration, else this instance's client metadata document URL. */
async function ensureServerAuth(
  name: string,
  serverUrl: string,
): Promise<ServerAuth> {
  const store = readStore();
  const cur = store[name];
  if (cur?.clientInfo?.clientId && cur.serverUrl === serverUrl) return cur;
  const { resource, scopes, endpoints, clientIdMetadataDocument } =
    await discoverMcpOauth(serverUrl);
  const metadataClientId = clientIdMetadataDocument
    ? clientMetadataUrl()
    : undefined;
  let clientId: string;
  if (endpoints.register) {
    try {
      clientId = await registerClient(name, endpoints.register, serverUrl);
    } catch (error) {
      if (!metadataClientId) throw error;
      clientId = metadataClientId;
    }
  } else if (metadataClientId) {
    clientId = metadataClientId;
  } else {
    throw new Error(
      clientIdMetadataDocument
        ? `${name}: client registration needs a public HTTPS ingress URL for Open Session's client metadata document`
        : `${name}: authorization server offers no dynamic client registration`,
    );
  }
  const next: ServerAuth = {
    serverUrl,
    resource,
    ...(scopes ? { scopes } : {}),
    endpoints,
    clientInfo: { clientId },
    ...(cur ? { shared: cur.shared, users: cur.users } : {}),
  };
  const fresh = readStore();
  fresh[name] = next;
  writeStore(fresh);
  return next;
}

// Pending flows keyed by state (10-min TTL); parked on globalThis so a
// frontend-triggered hot reload doesn't strand an in-flight consent.
interface PendingFlow {
  name: string;
  verifier: string;
  teamName?: string; // absent = shared grant
  createdAt: number;
}
const pending: Map<string, PendingFlow> = ((globalThis as any).__osMcpOauth ??=
  new Map<string, PendingFlow>());
const PENDING_TTL_MS = 10 * 60_000;

/** Which server a callback's state belongs to, for the result page's brand mark. */
export function pendingFlowServer(state: string): string | undefined {
  return pending.get(state)?.name;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint the authorize URL for a server. `forUser` (any user ref — name,
 * github login, slack id) makes it a per-user grant; absent = shared.
 */
export async function startMcpOauthFlow(
  name: string,
  serverUrl: string,
  forUser?: string,
): Promise<{ url: string }> {
  const teamName = forUser ? resolveTeammate(forUser)?.name : undefined;
  if (forUser && !teamName)
    throw new Error(`"${forUser}" doesn't resolve to a configured teammate`);
  const preset = oauthPresetFor(name);
  if (preset) {
    const state = b64url(randomBytes(24));
    pending.set(state, {
      name,
      verifier: "",
      teamName,
      createdAt: Date.now(),
    });
    const url = new URL(preset.authorize);
    url.searchParams.set("client_id", process.env[preset.clientIdEnv]!);
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("state", state);
    for (const [k, v] of Object.entries(preset.authorizeParams))
      url.searchParams.set(k, v);
    // Ensure a store entry exists so grants have a home.
    const store = readStore();
    store[name] = store[name] || {
      serverUrl,
      endpoints: { authorize: preset.authorize, token: preset.token },
      clientInfo: { clientId: process.env[preset.clientIdEnv]! },
    };
    writeStore(store);
    return { url: url.toString() };
  }
  const auth = await ensureServerAuth(name, serverUrl);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  for (const [k, v] of pending)
    if (Date.now() - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  pending.set(state, { name, verifier, teamName, createdAt: Date.now() });
  const url = new URL(auth.endpoints.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", auth.clientInfo.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Request only advertised scopes. MCP authorization is not necessarily
  // OpenID Connect; when scopes are absent, let the server use its defaults.
  if (auth.scopes?.length) url.searchParams.set("scope", auth.scopes.join(" "));
  url.searchParams.set("prompt", "consent");
  if (auth.resource) url.searchParams.set("resource", auth.resource);
  return { url: url.toString() };
}

/** Complete a flow from the callback redirect. Returns what got connected. */
export async function completeMcpOauthFlow(
  state: string,
  code: string,
  completedBy?: string,
): Promise<{ name: string; teamName?: string }> {
  const flow = pending.get(state);
  if (!flow || Date.now() - flow.createdAt > PENDING_TTL_MS)
    throw new Error("This connect link expired. Start again from Connections.");
  pending.delete(state);
  const preset = oauthPresetFor(flow.name);
  if (preset) {
    const body = new URLSearchParams({
      code,
      client_id: process.env[preset.clientIdEnv]!,
      client_secret: process.env[preset.clientSecretEnv]!,
      redirect_uri: callbackUrl(),
    });
    const res = (await (
      await fetch(preset.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as any;
    const tok = preset.extract(res);
    if (!tok.accessToken)
      throw new Error(
        `Token exchange failed: ${res?.error || "no user token in response"}`,
      );
    const grant: Grant = {
      tokens: {
        accessToken: tok.accessToken,
        ...(tok.refreshToken ? { refreshToken: tok.refreshToken } : {}),
        ...(tok.expiresIn
          ? { expiresAt: Date.now() + tok.expiresIn * 1000 }
          : {}),
      },
      updatedAt: new Date().toISOString(),
      ...(completedBy ? { connectedBy: completedBy } : {}),
    };
    const fresh = readStore();
    const entry = fresh[flow.name];
    if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
    writeGrant(entry, slotFor(flow.teamName), grant);
    writeStore(fresh);
    return { name: flow.name, teamName: flow.teamName };
  }
  const store = readStore();
  const auth = store[flow.name];
  if (!auth) throw new Error(`No pending registration for ${flow.name}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    client_id: auth.clientInfo.clientId,
    code_verifier: flow.verifier,
  });
  if (auth.resource) body.set("resource", auth.resource);
  const res = (await (
    await oauthPost(auth.endpoints.token, auth.serverUrl, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    })
  ).json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.access_token)
    throw new Error(
      `Token exchange failed: ${res.error_description || res.error || "no access_token"}`,
    );
  const grant: Grant = {
    tokens: {
      accessToken: res.access_token,
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
      ...(res.expires_in
        ? { expiresAt: Date.now() + res.expires_in * 1000 }
        : {}),
    },
    updatedAt: new Date().toISOString(),
    ...(completedBy ? { connectedBy: completedBy } : {}),
  };
  const fresh = readStore();
  const entry = fresh[flow.name];
  if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
  writeGrant(entry, slotFor(flow.teamName), grant);
  writeStore(fresh);
  return { name: flow.name, teamName: flow.teamName };
}

const REFRESH_AHEAD_MS = 5 * 60_000;

/** What an agent, the access check and Settings say about a server whose
 *  sign-in can no longer be used. */
export const SIGN_IN_EXPIRED_REASON =
  "sign-in expired. A person needs to reconnect it in Settings → Connections.";

/** Whether a grant's access token is past its expiry. */
function grantExpired(grant: Grant, now = Date.now()): boolean {
  const exp = grant.tokens.expiresAt;
  return !!exp && exp <= now;
}

/** How long before expiry a grant is refreshed: five minutes, or half the
 *  token's lifetime when that is shorter (some providers issue 5-minute
 *  tokens, which would otherwise be due the moment they are issued). */
function refreshAheadMs(grant: Grant): number {
  const exp = grant.tokens.expiresAt;
  const issued = Date.parse(grant.updatedAt);
  const lifetime = exp && Number.isFinite(issued) ? exp - issued : Infinity;
  return Math.min(REFRESH_AHEAD_MS, Math.max(lifetime / 2, 0));
}

/** A grant this close to expiry is refreshed before use, not behind it. */
const REFRESH_BEFORE_USE_MS = 30_000;

/** Whether a grant should be refreshed now: close to or past expiry, with a
 *  refresh token that the provider has not already refused. */
function refreshDue(grant: Grant, now = Date.now()): boolean {
  const exp = grant.tokens.expiresAt;
  return (
    !!grant.tokens.refreshToken &&
    !grant.refreshError &&
    !!exp &&
    exp - now < refreshAheadMs(grant)
  );
}

async function readStoreAsync(): Promise<Store> {
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

/** One refresh per grant slot at a time in this process; the file lock below
 *  holds other processes off. */
const refreshing: Map<string, Promise<GrantRef | undefined>> = ((
  globalThis as any
).__osMcpOauthRefreshing ??= new Map());

/**
 * Refresh one grant when it is due, serialized across callers and processes.
 * Under the store's lock the grant is read again first: when another caller
 * already rotated it, that result is used, so a rotating refresh token is
 * never sent twice. A refused refresh is kept on the grant (refreshError) so
 * the reason can be shown and the provider is not asked again until a person
 * reconnects. Network and server errors are logged and retried later.
 */
function refreshSlot(
  name: string,
  slot: GrantSlot,
): Promise<GrantRef | undefined> {
  const key = `${name}\0${slotLabel(slot)}`;
  const running = refreshing.get(key);
  if (running) return running;
  const work = withFileLock(
    STORE_PATH,
    async () => {
      const store = await readStoreAsync();
      const auth = store[name];
      const ref = grantRef(auth, slot);
      if (!auth || !ref || !refreshDue(ref.grant)) return ref;
      const refreshToken = ref.grant.tokens.refreshToken!;
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: auth.clientInfo.clientId,
      });
      if (auth.resource) body.set("resource", auth.resource);
      let next: Grant;
      try {
        const response = await oauthPost(auth.endpoints.token, auth.serverUrl, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        const res = (await response.json().catch(() => ({}))) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error?: string;
          error_description?: string;
        };
        if (!response.ok || !res.access_token) {
          const message = `${res.error || `HTTP ${response.status}`}${res.error_description ? `: ${res.error_description}` : ""}`;
          console.warn(
            `[mcp-oauth] refresh refused for ${name}/${slotLabel(ref)}: ${message}`,
          );
          // A 4xx answer is the provider's decision; a 5xx may pass.
          if (response.status < 400 || response.status >= 500) return ref;
          next = {
            ...ref.grant,
            refreshError: { at: new Date().toISOString(), message },
          };
        } else {
          next = {
            ...ref.grant,
            tokens: {
              accessToken: res.access_token,
              refreshToken: res.refresh_token || refreshToken,
              ...(res.expires_in
                ? { expiresAt: Date.now() + res.expires_in * 1000 }
                : {}),
            },
            updatedAt: new Date().toISOString(),
          };
          delete next.refreshError;
        }
      } catch (e) {
        console.error(
          `[mcp-oauth] refresh failed for ${name}/${slotLabel(ref)}:`,
          e,
        );
        return ref;
      }
      // Write over what is on disk now, so nothing written meanwhile by a
      // sign-in or a disconnect is lost. A grant replaced meanwhile wins.
      const fresh = await readStoreAsync();
      const entry = fresh[name];
      const current = grantRef(entry, slot);
      if (!entry || current?.grant.tokens.refreshToken !== refreshToken)
        return current;
      writeGrant(entry, slot, next);
      await writeFileAtomicAsync(
        STORE_PATH,
        JSON.stringify(fresh, null, 2) + "\n",
        0o600,
      );
      return { ...slot, grant: next };
    },
    "MCP sign-in store",
  ).finally(() => refreshing.delete(key));
  refreshing.set(key, work);
  return work;
}

async function refreshExpiring(): Promise<void> {
  const store = await readStoreAsync();
  for (const [name, auth] of Object.entries(store)) {
    const slots: GrantSlot[] = [
      ...(auth.shared ? [{ kind: "shared" } as const] : []),
      ...Object.keys(auth.users || {}).map(
        (teamName) => ({ kind: "user", teamName }) as const,
      ),
    ];
    for (const slot of slots) {
      const ref = grantRef(auth, slot);
      if (ref && refreshDue(ref.grant))
        await refreshSlot(name, slot).catch((e) =>
          console.error(`[mcp-oauth] refresh check failed for ${name}:`, e),
        );
    }
  }
}

/**
 * Refresh grants ahead of expiry every two minutes, so a run that starts
 * later (an incident agent at night) finds a current sign-in. Idempotent;
 * called from gateway boot.
 */
export function startMcpOauthRefresher(): void {
  const g = globalThis as any;
  if (g.__osMcpOauthTicker) return;
  g.__osMcpOauthTicker = setInterval(() => {
    refreshExpiring().catch(() => {});
  }, 2 * 60_000);
  g.__osMcpOauthTicker.unref?.();
  refreshExpiring().catch(() => {});
}

/**
 * The Authorization header value for a server, for a run by `user` — the
 * user's own grant first (per-user MCP identity), else the shared grant.
 * Sync (called from filterMcpServers): an expired grant gives no header and
 * starts a refresh. Callers about to use a server await
 * freshMcpAuthHeader instead.
 */
export function mcpAuthHeader(name: string, user?: string): string | undefined {
  return mcpUserGrantHeader(name, user) ?? mcpSharedGrantHeader(name);
}

/** The user's own grant ONLY (no shared fallback) — lets callers order
 *  identities explicitly (e.g. session creator first, then prompter). */
export function mcpUserGrantHeader(
  name: string,
  user?: string,
): string | undefined {
  if (!user) return undefined;
  const teamName = resolveTeammate(user)?.name;
  if (!teamName) return undefined;
  return grantHeader(name, { kind: "user", teamName });
}

/** The workspace-wide grant ONLY. */
export function mcpSharedGrantHeader(name: string): string | undefined {
  return grantHeader(name, { kind: "shared" });
}

function headerOf(ref: GrantRef | undefined): string | undefined {
  if (!ref || grantExpired(ref.grant)) return undefined;
  return `Bearer ${ref.grant.tokens.accessToken}`;
}

function grantHeader(name: string, slot: GrantSlot): string | undefined {
  const auth = readStore()[name];
  const ref = grantRef(auth, slot);
  if (!auth || !ref) return undefined;
  if (refreshDue(ref.grant)) refreshSlot(name, slot).catch(() => {});
  return headerOf(ref);
}

/** The grant slots a run by these identities may use, in priority order:
 *  each user's own grant, then the shared one. */
function slotsFor(users: readonly string[]): GrantSlot[] {
  const slots: GrantSlot[] = [];
  for (const user of users) {
    const teamName = resolveTeammate(user)?.name;
    if (
      teamName &&
      !slots.some((s) => s.kind === "user" && s.teamName === teamName)
    )
      slots.push({ kind: "user", teamName });
  }
  slots.push({ kind: "shared" });
  return slots;
}

/**
 * The Authorization header for a run by `users` (priority order; empty for a
 * run with nobody behind it). A grant that is expired or within 30 seconds of
 * it is refreshed first; one merely close to expiry is refreshed behind the
 * call. Use before connecting to a server.
 */
export async function freshMcpAuthHeader(
  name: string,
  users: readonly string[] = [],
): Promise<string | undefined> {
  const store = await readStoreAsync();
  const auth = store[name];
  if (!auth) return undefined;
  for (const slot of slotsFor(users)) {
    let ref = grantRef(auth, slot);
    if (!ref) continue;
    if (refreshDue(ref.grant)) {
      const exp = ref.grant.tokens.expiresAt!;
      // Expired or about to be: wait for the new token. Otherwise refresh
      // behind this request and use the current one.
      if (exp - Date.now() < REFRESH_BEFORE_USE_MS)
        ref = await refreshSlot(name, slot).catch(() => ref);
      else refreshSlot(name, slot).catch(() => {});
    }
    const header = headerOf(ref);
    if (header) return header;
  }
  return undefined;
}

/**
 * Why a run by `users` can't use this server's sign-in, or undefined when it
 * can or has none: every grant it could use has expired and cannot be
 * refreshed (no refresh token, or the provider refused it).
 */
export function mcpSignInProblem(
  name: string,
  users: readonly string[] = [],
): string | undefined {
  return signInProblemIn(readStore(), name, users);
}

/** mcpSignInProblem for each name, reading the store without blocking. */
export async function mcpSignInProblems(
  names: readonly string[],
  users: readonly string[] = [],
): Promise<Record<string, string>> {
  const store = await readStoreAsync();
  const out: Record<string, string> = {};
  for (const name of names) {
    const problem = signInProblemIn(store, name, users);
    if (problem) out[name] = problem;
  }
  return out;
}

function signInProblemIn(
  store: Store,
  name: string,
  users: readonly string[],
): string | undefined {
  const auth = store[name];
  if (!auth) return undefined;
  const refs = slotsFor(users)
    .map((slot) => grantRef(auth, slot))
    .filter((ref): ref is GrantRef => !!ref);
  if (!refs.length) return undefined;
  const now = Date.now();
  const usable = refs.some(
    (ref) => !grantExpired(ref.grant, now) || refreshDue(ref.grant, now),
  );
  return usable ? undefined : SIGN_IN_EXPIRED_REASON;
}

/** Connection status for the UI: who's connected on each grant, and
 *  whether the workspace grant's sign-in expired for good (a person has to
 *  reconnect it). */
export function mcpOauthStatus(name: string): {
  shared?: { connectedBy?: string; updatedAt: string; expired?: true };
  users: string[];
} {
  const store = readStore();
  const auth = store[name];
  // No users: only the workspace grant counts.
  const expired = !!auth?.shared && !!signInProblemIn(store, name, []);
  return {
    ...(auth?.shared
      ? {
          shared: {
            connectedBy: auth.shared.connectedBy,
            updatedAt: auth.shared.updatedAt,
            ...(expired ? { expired: true as const } : {}),
          },
        }
      : {}),
    users: Object.keys(auth?.users || {}),
  };
}

// OAuth-capability probe (RFC 9728 protected-resource metadata on the
// server resource) — drives "Connect my account" visibility for servers that
// run on a static workspace key today (e.g. posthog).
//
// The answer is kept on disk, not only in memory, because it decides
// MEMBERSHIP of the My accounts list rather than one row's state: a cold
// process cannot say which tools belong on that list at all, so the panel
// would have to wait on a probe per configured server before it could draw a
// single row. Whether a resource publishes OAuth metadata is a stable fact
// about that service, so the last answer is a good one to show while a fresh
// probe runs behind it.
//
// A probe that never got an answer is remembered in memory only, and briefly:
// a network blip must not persist "this tool has no personal sign-in" and drop
// the row from everyone's list for an hour.
const CAPABLE_PATH = statePath(".opensession-mcp-capable-v2.json");
const CAPABLE_TTL_MS = 60 * 60_000;
const CAPABLE_ERROR_TTL_MS = 60_000;

/** `soft`: the probe errored, so this is a placeholder that keeps us from
 *  hammering an unreachable origin, not a fact worth persisting. */
interface Capability {
  capable: boolean;
  ts: number;
  soft?: boolean;
}

const capableCache = new Map<string, Capability>();
const capableInflight = new Map<string, Promise<boolean>>();
let capabilityLoad: Promise<void> | undefined;
let capabilityWrite = Promise.resolve();

function loadCapabilities(): Promise<void> {
  return (capabilityLoad ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(CAPABLE_PATH, "utf8")) as Record<
        string,
        Capability
      >;
      for (const [url, e] of Object.entries(raw))
        if (typeof e?.capable === "boolean" && typeof e?.ts === "number")
          capableCache.set(url, { capable: e.capable, ts: e.ts });
    } catch {}
  })());
}

function capabilityFresh(e: Capability): boolean {
  return Date.now() - e.ts < (e.soft ? CAPABLE_ERROR_TTL_MS : CAPABLE_TTL_MS);
}

function resourceKey(serverUrl: string): string | undefined {
  try {
    return new URL(serverUrl).href;
  } catch {
    return undefined;
  }
}

function probeCapable(resource: string): Promise<boolean> {
  const running = capableInflight.get(resource);
  if (running) return running;
  const p = (async () => {
    await loadCapabilities();
    const hit = capableCache.get(resource);
    if (hit && capabilityFresh(hit)) return hit.capable;
    let capable = false;
    let soft = false;
    try {
      await discoverMcpOauth(resource);
      capable = true;
    } catch (error) {
      soft = !(error instanceof OauthDiscoveryError) || error.transient;
    }
    // Persist definitive negatives too; only transport/provider outages are soft.
    capableCache.set(resource, { capable, ts: Date.now(), soft });
    if (!soft) await persistCapabilities();
    return capable;
  })().finally(() => capableInflight.delete(resource));
  capableInflight.set(resource, p);
  return p;
}

function persistCapabilities(): Promise<void> {
  capabilityWrite = capabilityWrite
    .then(async () => {
      const out: Record<string, Capability> = {};
      for (const [url, e] of capableCache) if (!e.soft) out[url] = e;
      await writeFile(CAPABLE_PATH, JSON.stringify(out, null, 2) + "\n", {
        mode: 0o600,
      });
    })
    .catch(() => {});
  return capabilityWrite;
}

/** Last known answer for this exact resource, refreshed in the background.
 * Undefined means discovery (including loading the persisted cache) is pending. */
export function cachedOauthCapable(serverUrl: string): boolean | undefined {
  const resource = resourceKey(serverUrl);
  if (!resource) return false;
  const hit = capableCache.get(resource);
  if (!hit || !capabilityFresh(hit)) probeCapable(resource).catch(() => {});
  return hit?.capable;
}

export async function isOauthCapable(serverUrl: string): Promise<boolean> {
  const resource = resourceKey(serverUrl);
  if (!resource) return false;
  return probeCapable(resource);
}

/** Raw grant token (no "Bearer " prefix) — stdio env injection. */
export function mcpUserGrantToken(
  name: string,
  user?: string,
): string | undefined {
  const h = mcpUserGrantHeader(name, user);
  return h?.replace(/^Bearer\s+/i, "");
}

/** Any grant at all for this server (shared or any user's)? */
export function hasMcpOauthGrant(name: string, user?: string): boolean {
  if (user) return !!mcpAuthHeader(name, user);
  const auth = readStore()[name];
  return !!auth?.shared || Object.keys(auth?.users || {}).length > 0;
}

/** Drop a grant (Disconnect in the UI). */
export function removeMcpOauthGrant(name: string, forUser?: string): boolean {
  const store = readStore();
  const auth = store[name];
  if (!auth) return false;
  if (forUser) {
    const teamName = resolveTeammate(forUser)?.name;
    if (!teamName || !auth.users?.[teamName]) return false;
    delete auth.users[teamName];
  } else {
    if (!auth.shared) return false;
    delete auth.shared;
  }
  writeStore(store);
  return true;
}

// ── Manual token connect ──────────────────────────────────────────────────
// Some providers gate OAuth client registration (Vercel approves only its
// own list of AI clients), but every user can mint a personal API token.
// A validated pasted token is stored as a grant, so it rides the exact same
// per-run injection path as an OAuth grant — no separate plumbing.

/** Check a bearer key with an MCP initialize request to the server itself. */
function mcpInitializeValidator(
  url: string,
  provider: string,
  rejected: string,
): (token: string) => Promise<{ ok: true } | { ok: false; error: string }> {
  return async (token) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "Open Session", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    void res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: rejected };
    if (!res.ok)
      return {
        ok: false,
        error: `Could not check the key with ${provider} (HTTP ${res.status})`,
      };
    return { ok: true };
  };
}

const TOKEN_VALIDATORS: Record<
  string,
  (token: string) => Promise<{ ok: true } | { ok: false; error: string }>
> = {
  vercel: async (token) => {
    const res = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403)
      return {
        ok: false,
        error:
          "Vercel rejected that token. Create a new one at vercel.com/account/settings/tokens and paste it again.",
      };
    if (!res.ok)
      return {
        ok: false,
        error: `Could not check the token with Vercel (HTTP ${res.status})`,
      };
    return { ok: true };
  },
  vero: mcpInitializeValidator(
    "https://api.getvero.com/mcp",
    "Vero",
    "Vero rejected that key. Create a Campaigns API secret key in Vero and paste it again.",
  ),
  // Oneleet accepts OAuth only from clients it has approved; a workspace
  // admin's service key is its documented fallback for everyone else.
  oneleet: mcpInitializeValidator(
    "https://api.oneleet.com/mcp",
    "Oneleet",
    "Oneleet rejected that key. Create a service key in Oneleet's workspace settings and paste it again.",
  ),
};

/** Can this server be connected by pasting a personal API token? */
export function supportsManualToken(name: string): boolean {
  return !!TOKEN_VALIDATORS[name];
}

/** Validate a provider token without persisting it. */
export async function validateManualMcpToken(
  name: string,
  token: string,
): Promise<void> {
  const validate = TOKEN_VALIDATORS[name];
  if (!validate) throw new Error(`${name} has no token connect flow`);
  const checked = await validate(token);
  if (!checked.ok) throw new Error(checked.error);
}

/** Validate a pasted API token live, then store it as a grant. */
export async function saveManualMcpGrant(
  name: string,
  serverUrl: string,
  token: string,
  opts: { connectedBy?: string; forUser?: string } = {},
): Promise<void> {
  await validateManualMcpToken(name, token);
  const teamName = opts.forUser
    ? resolveTeammate(opts.forUser)?.name
    : undefined;
  if (opts.forUser && !teamName)
    throw new Error(
      `"${opts.forUser}" doesn't resolve to a configured teammate`,
    );
  const store = readStore();
  const entry = store[name] ?? {
    serverUrl,
    endpoints: { authorize: "", token: "" },
    clientInfo: { clientId: "manual-token" },
  };
  entry.serverUrl = serverUrl;
  store[name] = entry;
  writeGrant(entry, slotFor(teamName), {
    tokens: { accessToken: token },
    updatedAt: new Date().toISOString(),
    ...(opts.connectedBy ? { connectedBy: opts.connectedBy } : {}),
  });
  writeStore(store);
}
