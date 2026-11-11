/**
 * Blob's GitHub machine user: the account Blob (the supervisor and the
 * project leads) will post as on issues and pull requests. See
 * docs/github-authority.md ("Current policy") and docs/setup/github.md
 * ("Blob's GitHub account").
 *
 * The settings are instance configuration, next to the GitHub App's, in
 * config.json under `integrations.github.blob`:
 *
 *   { login, tokenRef, repos[], publicRepos[], enabled, expiresAt }
 *
 * The token is a workspace secret (workspace-secrets.ts, purpose
 * `github.blob`): the config holds only its ref. This module is the only
 * one that reads that ref or resolves the secret
 * (github-blob-boundary.test.ts). The token is never returned, logged, put
 * in a shell, `GH_CONFIG_DIR` or an agent's environment.
 *
 * Saving a token checks it first with `GET https://api.github.com/user`:
 * GitHub answers with the account's login, recorded here, and the token's
 * expiry in the `github-authentication-token-expiration` header. A token
 * GitHub refuses, or one without an expiry, is not stored. `repos` lists the
 * registered GitHub repositories Blob may write on; `publicRepos` names the
 * public ones among them, since a public repository is refused unless it is
 * listed by name.
 *
 * Removing the token keeps the login, so Blob's earlier posts still count as
 * ours (config.ts `githubBotLogins`) and nobody can take the name
 * (session-actors.ts `isReservedTeamName`). For the same reason a token for
 * a different account than the recorded login is refused: switching
 * accounts means removing Blob's account (`integrations.github.blob`) first.
 *
 * Never resolve the token anywhere else. Any other module that reads
 * `integrations.github.blob` and calls `resolveWorkspaceSecret*` fails
 * github-blob-boundary.test.ts; add what it needs here instead.
 *
 * Every config write runs under the shared config mutation lock with async
 * I/O. Nothing runs at import.
 */
import { auditAsync } from "./audit";
import { configuredIdentity, configuredRepos, getConfigAsync } from "./config";
import {
  persistRawConfigAsync,
  rawConfigAsync,
  withConfigMutationLock,
} from "./config-mutation";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import {
  deleteWorkspaceSecretAsync,
  putWorkspaceSecretAsync,
  resolveWorkspaceSecretAsync,
} from "./workspace-secrets";

/** The workspace secret's purpose. */
export const BLOB_GITHUB_SECRET_PURPOSE = "github.blob";

const USER_URL = "https://api.github.com/user";
const EXPIRY_HEADER = "github-authentication-token-expiration";
const VERIFY_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 255;
const MAX_REPOS = 100;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

interface BlobGithubRecord {
  login?: string;
  tokenRef?: string;
  repos: string[];
  publicRepos: string[];
  enabled: boolean;
  expiresAt?: string;
}

/** What the settings route returns: never the token, only whether one is
 *  set. */
export interface BlobGithubView {
  login: string | null;
  expiresAt: string | null;
  repos: string[];
  publicRepos: string[];
  enabled: boolean;
  tokenSet: boolean;
}

/** A checked change. Absent fields stay as they are. */
export interface BlobGithubPatch {
  token?: string;
  repos?: string[];
  publicRepos?: string[];
  enabled?: boolean;
}

export type BlobGithubResult =
  | { ok: true; settings: BlobGithubView }
  | { ok: false; status: number; error: string };

interface Deps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
}

const defaultDeps: Deps = {
  fetch: (url, init) => fetchWithTimeout(url, init, VERIFY_TIMEOUT_MS),
  now: Date.now,
};

let deps: Deps = defaultDeps;

/** Swap the network and clock in tests. Returns a restore function. */
export function __setBlobGithubDepsForTest(
  overrides: Partial<Deps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

const obj = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && !!v.trim())
    : [];

function parseRecord(raw: unknown): BlobGithubRecord {
  const o = obj(raw) ?? {};
  const str = (key: string) =>
    typeof o[key] === "string" && (o[key] as string).trim()
      ? (o[key] as string).trim()
      : undefined;
  const login = str("login");
  return {
    login: login && GITHUB_LOGIN.test(login) ? login : undefined,
    tokenRef: str("tokenRef"),
    repos: strings(o.repos),
    publicRepos: strings(o.publicRepos),
    enabled: o.enabled === true,
    expiresAt: str("expiresAt"),
  };
}

/** The raw `integrations.github` section of `config`, created if missing. */
function githubSection(config: Record<string, unknown>) {
  const integrations = obj(config.integrations) ?? {};
  config.integrations = integrations;
  const github = obj(integrations.github) ?? {};
  integrations.github = github;
  return github;
}

async function view(record: BlobGithubRecord): Promise<BlobGithubView> {
  const tokenSet = record.tokenRef
    ? (await resolveWorkspaceSecretAsync(record.tokenRef)) !== undefined
    : false;
  return {
    login: record.login ?? null,
    expiresAt: record.expiresAt ?? null,
    repos: record.repos,
    publicRepos: record.publicRepos,
    enabled: record.enabled,
    tokenSet,
  };
}

/** The current settings, read fresh from disk. */
export async function getBlobGithubSettings(): Promise<BlobGithubView> {
  const config = await getConfigAsync();
  return view(parseRecord(obj(config.integrations?.github)?.blob));
}

// ── Validation ──────────────────────────────────────────────────────────

/** Check a request body. Returns the patch or an error for a 400. */
export function validateBlobGithubPatch(
  body: unknown,
): BlobGithubPatch | { error: string } {
  const o = obj(body);
  if (!o) return { error: "Invalid JSON body" };
  const patch: BlobGithubPatch = {};
  for (const key of Object.keys(o)) {
    if (!["token", "repos", "publicRepos", "enabled"].includes(key))
      return { error: `unknown field: ${key}` };
  }
  if ("token" in o) {
    const token = typeof o.token === "string" ? o.token.trim() : "";
    if (!token) return { error: "token: must be a non-empty string" };
    if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token))
      return { error: "token: not a GitHub token" };
    // A classic token reaches every repository the account can; Blob's
    // must be fine-grained, limited to the repositories picked for it.
    if (!token.startsWith("github_pat_"))
      return {
        error:
          "token: use a fine-grained personal access token (it starts with github_pat_)",
      };
    patch.token = token;
  }
  for (const key of ["repos", "publicRepos"] as const) {
    if (!(key in o)) continue;
    const value = o[key];
    if (
      !Array.isArray(value) ||
      value.some((v) => typeof v !== "string") ||
      value.length > MAX_REPOS
    )
      return {
        error: `${key}: must be a list of at most ${MAX_REPOS} owner/name strings`,
      };
    patch[key] = value as string[];
  }
  if ("enabled" in o) {
    if (typeof o.enabled !== "boolean")
      return { error: "enabled: must be a boolean" };
    patch.enabled = o.enabled;
  }
  return patch;
}

/** The registered GitHub repositories, keyed lowercase, in their configured
 *  spelling. */
function registeredGithubRepos(): Map<string, string> {
  const repos = new Map<string, string>();
  for (const repo of Object.values(configuredRepos())) {
    if (repo.host === "codestorage" || !repo.ghRepo) continue;
    repos.set(repo.ghRepo.toLowerCase(), repo.ghRepo);
  }
  return repos;
}

/** Each of `names` as a registered repository, or the first one that isn't. */
function resolveRepos(
  names: string[],
  registered: Map<string, string>,
): { repos: string[] } | { unknown: string } {
  const repos: string[] = [];
  for (const name of names) {
    const found = registered.get(name.trim().toLowerCase());
    if (!found) return { unknown: name };
    if (!repos.includes(found)) repos.push(found);
  }
  return { repos };
}

// ── Verification ────────────────────────────────────────────────────────

/** GitHub's expiry header, `2026-02-09 12:00:00 UTC` (or with a numeric
 *  offset), as an ISO time; undefined when it doesn't parse. */
export function parseTokenExpiry(header: string): string | undefined {
  const match = header
    .trim()
    .match(
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})$/i,
    );
  if (!match) return undefined;
  const [, day, time, zone] = match;
  const offset = /^(UTC|Z)$/i.test(zone!)
    ? "Z"
    : `${zone!.slice(0, 3)}:${zone!.slice(-2)}`;
  const at = new Date(`${day}T${time}${offset}`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

type Verified =
  | { ok: true; login: string; expiresAt: string }
  | { ok: false; status: number; error: string };

/** Ask GitHub who `token` belongs to and when it expires. */
export async function verifyBlobGithubToken(token: string): Promise<Verified> {
  let res: Response;
  try {
    res = await deps.fetch(USER_URL, {
      // A redirect would carry the token to another host; GET /user never
      // redirects, so anything but a direct answer is refused below.
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opensession",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "Could not reach GitHub" };
  }
  if (res.status === 401)
    return {
      ok: false,
      status: 400,
      error: "GitHub refused the token. Check it was copied whole and is live.",
    };
  if (!res.ok)
    return {
      ok: false,
      status: 502,
      error: `GitHub answered ${res.status} when checking the token`,
    };
  const body = obj(await res.json().catch(() => null));
  const login = typeof body?.login === "string" ? body.login.trim() : "";
  if (!GITHUB_LOGIN.test(login))
    return {
      ok: false,
      status: 502,
      error: "GitHub did not say which account owns the token",
    };
  const header = res.headers.get(EXPIRY_HEADER);
  if (!header)
    return {
      ok: false,
      status: 400,
      error:
        "The token has no expiry. Create one with an expiration date (90 days).",
    };
  const expiresAt = parseTokenExpiry(header);
  if (!expiresAt)
    return {
      ok: false,
      status: 502,
      error: "GitHub sent an expiry that could not be read",
    };
  if (Date.parse(expiresAt) <= deps.now())
    return { ok: false, status: 400, error: "The token has expired" };
  return { ok: true, login, expiresAt };
}

/** Whether `login` is a teammate's on the roster: Blob's account must be
 *  its own. */
function isRosterLogin(login: string): boolean {
  const key = login.toLowerCase();
  return configuredIdentity().team.some(
    (member) => member.github?.trim().toLowerCase() === key,
  );
}

// ── Writes ──────────────────────────────────────────────────────────────

/**
 * Apply a checked patch. A new token is verified with GitHub, then stored
 * under a new secret ref before the config points at it; the ref it
 * replaced is deleted after the commit, and a failed commit deletes the new
 * one.
 */
export async function setBlobGithubSettings(
  patch: BlobGithubPatch,
  actor: string,
): Promise<BlobGithubResult> {
  let verified: Extract<Verified, { ok: true }> | undefined;
  if (patch.token) {
    const result = await verifyBlobGithubToken(patch.token);
    if (!result.ok) return result;
    if (isRosterLogin(result.login))
      return {
        ok: false,
        status: 400,
        error: `@${result.login} is a teammate on the roster. Blob needs an account of its own.`,
      };
    verified = result;
  }

  const newRef = patch.token
    ? await putWorkspaceSecretAsync(BLOB_GITHUB_SECRET_PURPOSE, patch.token)
    : undefined;
  let retired: string | undefined;
  let outcome: BlobGithubResult;
  try {
    outcome = await withConfigMutationLock(async () => {
      const config = await rawConfigAsync();
      const github = githubSection(config);
      const record = parseRecord(github.blob);
      // Blob's earlier posts are recognised by the recorded login, so the
      // account can only change by removing it first.
      if (
        verified &&
        record.login &&
        record.login.toLowerCase() !== verified.login.toLowerCase()
      )
        return {
          ok: false,
          status: 400,
          error: `This token belongs to @${verified.login}, but Blob's account is @${record.login}; remove Blob's account first.`,
        } as const;
      const registered = registeredGithubRepos();

      let repos = record.repos;
      if (patch.repos) {
        const resolved = resolveRepos(patch.repos, registered);
        if ("unknown" in resolved)
          return {
            ok: false,
            status: 400,
            error: `${resolved.unknown} is not a registered GitHub repository`,
          } as const;
        repos = resolved.repos;
      }
      let publicRepos = patch.publicRepos ?? record.publicRepos;
      if (patch.publicRepos) {
        const resolved = resolveRepos(patch.publicRepos, registered);
        if ("unknown" in resolved)
          return {
            ok: false,
            status: 400,
            error: `${resolved.unknown} is not a registered GitHub repository`,
          } as const;
        publicRepos = resolved.repos;
      }
      // A repository dropped from `repos` leaves `publicRepos` with it.
      const outside = publicRepos.find((r) => !repos.includes(r));
      if (outside && patch.publicRepos)
        return {
          ok: false,
          status: 400,
          error: `${outside} is not one of Blob's repositories`,
        } as const;
      publicRepos = publicRepos.filter((r) => repos.includes(r));

      const tokenRef = newRef ?? record.tokenRef;
      const enabled = patch.enabled ?? record.enabled;
      if (enabled && !tokenRef)
        return {
          ok: false,
          status: 400,
          error: "Save a token before turning Blob's account on",
        } as const;

      const next: BlobGithubRecord = {
        ...record,
        ...(verified
          ? { login: verified.login, expiresAt: verified.expiresAt }
          : {}),
        tokenRef,
        repos,
        publicRepos,
        enabled,
      };
      github.blob = {
        ...obj(github.blob),
        ...withoutUndefined(next),
      };
      await persistRawConfigAsync(config);
      if (newRef && record.tokenRef && record.tokenRef !== newRef)
        retired = record.tokenRef;
      return { ok: true, settings: await view(next) } as const;
    });
  } catch (error) {
    if (newRef) await deleteWorkspaceSecretAsync(newRef).catch(() => {});
    throw error;
  }
  if (!outcome.ok) {
    if (newRef) await deleteWorkspaceSecretAsync(newRef).catch(() => {});
    return outcome;
  }
  if (retired) await deleteWorkspaceSecretAsync(retired).catch(() => {});
  auditAsync({
    kind: "blob_github_update",
    actor,
    tokenRotated: Boolean(newRef),
    ...(verified
      ? { login: verified.login, expiresAt: verified.expiresAt }
      : {}),
    fields: Object.keys(patch).filter((key) => key !== "token"),
  });
  return outcome;
}

/** Remove the token and turn posting off. The login stays (see the header). */
export async function deleteBlobGithubToken(
  actor: string,
): Promise<BlobGithubView> {
  const { settings, retired } = await withConfigMutationLock(async () => {
    const config = await rawConfigAsync();
    const github = githubSection(config);
    const record = parseRecord(github.blob);
    const blob = { ...obj(github.blob) };
    delete blob.tokenRef;
    delete blob.expiresAt;
    blob.enabled = false;
    github.blob = blob;
    await persistRawConfigAsync(config);
    return {
      settings: await view(parseRecord(blob)),
      retired: record.tokenRef,
    };
  });
  if (retired) await deleteWorkspaceSecretAsync(retired).catch(() => {});
  auditAsync({ kind: "blob_github_update", actor, tokenRemoved: true });
  return settings;
}

function withoutUndefined(record: BlobGithubRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}
