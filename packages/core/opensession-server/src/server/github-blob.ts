/**
 * Blob's GitHub account: the account Blob (the supervisor and the project
 * leads) posts as on issues and pull requests. See
 * docs/github-authority.md ("Current policy") and docs/setup/github.md
 * ("Blob's GitHub account").
 *
 * The settings are instance configuration, next to the GitHub App's, in
 * config.json under `integrations.github.blob`:
 *
 *   { as, login, tokenRef, repos[], publicRepos[], labels[], enabled, expiresAt }
 *
 * `as` says whose account it is. `own-account` (the default) is a machine
 * user of Blob's own. `owner` is the instance owner's own account, through a
 * fine-grained token of theirs: the token's login must be the owner's
 * GitHub login on the roster, the same one they are signed in with. That
 * login is a person's, so it is never added to `githubBotLogins` nor
 * reserved (config.ts `blobGithubLogin` is "" then); Blob's posts are told
 * apart by the `<!-- os:blob -->` marker alone, and each is signed
 * "Written by Blob, <owner>'s assistant". Only the owner's own supervisor
 * and leads may post through it.
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
 * listed by name. `labels` is the owner's allowlist for blob_label: empty
 * (the default) turns labelling off.
 *
 * With Blob's own account, removing the token keeps the login, so Blob's
 * earlier posts still count as ours (config.ts `githubBotLogins`) and nobody
 * can take the name (session-actors.ts `isReservedTeamName`). For the same
 * reason a token for a different account than the recorded login is
 * refused, and so is a switch to the owner's account: switching means
 * forgetting Blob's account first (`forgetBlobGithubAccount`, which clears
 * `integrations.github.blob` once no token is stored). With the owner's
 * account nothing hangs on the login, so removing the token drops it too.
 *
 * Never resolve the token anywhere else. Any other module that reads
 * `integrations.github.blob` and calls `resolveWorkspaceSecret*` fails
 * github-blob-boundary.test.ts; add what it needs here instead.
 *
 * Every config write runs under the shared config mutation lock with async
 * I/O. Nothing runs at import.
 */
import { auditAsync } from "./audit";
import { privateTermIn } from "./command-policy";
import {
  configuredIdentity,
  configuredRepos,
  configuredServer,
  getConfigAsync,
  type BlobGithubAs,
} from "./config";
import {
  persistRawConfigAsync,
  rawConfigAsync,
  withConfigMutationLock,
} from "./config-mutation";
import {
  BLOB_MARKER,
  LABEL_ISSUE,
  TRIGGER_LABELS,
} from "../agents/github/constants";
import { catalogDocuments } from "./catalog-documents";
import { repoIsPrivate } from "./repo-visibility";
import { BLOB_ACTOR } from "./session-actors";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import { githubLoginFor } from "./shared/user-mappings";
import { canonicalName } from "./shared/user-store-key";
import {
  deleteWorkspaceSecretAsync,
  putWorkspaceSecretAsync,
  resolveWorkspaceSecretAsync,
} from "./workspace-secrets";

/** The workspace secret's purpose. */
export const BLOB_GITHUB_SECRET_PURPOSE = "github.blob";

const USER_URL = "https://api.github.com/user";
const EXPIRY_HEADER = "github-authentication-token-expiration";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 255;
const MAX_REPOS = 100;
const MAX_LABELS = 50;
const MAX_LABEL_LENGTH = 100;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const LABEL_TRIGGERS: readonly string[] = TRIGGER_LABELS;
/** How old the App's word on a repository's visibility may be for a post:
 *  a repository made public is noticed within this time. */
export const BLOB_VISIBILITY_MAX_AGE_MS = 10 * 60_000;

interface BlobGithubRecord {
  as: BlobGithubAs;
  login?: string;
  tokenRef?: string;
  repos: string[];
  publicRepos: string[];
  labels: string[];
  enabled: boolean;
  expiresAt?: string;
}

/** What the settings route returns: never the token, only whether one is
 *  set. */
export interface BlobGithubView {
  as: BlobGithubAs;
  login: string | null;
  expiresAt: string | null;
  repos: string[];
  publicRepos: string[];
  labels: string[];
  enabled: boolean;
  tokenSet: boolean;
}

/** A checked change. Absent fields stay as they are. */
export interface BlobGithubPatch {
  /** Whose account Blob posts as. Changing it needs a token for that
   *  account in the same patch. */
  as?: BlobGithubAs;
  token?: string;
  repos?: string[];
  publicRepos?: string[];
  labels?: string[];
  enabled?: boolean;
}

export type BlobGithubResult =
  | { ok: true; settings: BlobGithubView }
  | { ok: false; status: number; error: string };

interface Deps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  /** The App's word on a repository: true private, false public, null
   *  unknown (repo-visibility.ts). */
  repoIsPrivate(ghRepo: string): Promise<boolean | null>;
  audit(event: Record<string, unknown>): void;
  /** Raise a needs-you item to the instance owner, at most once per
   *  `dedupeKey`. */
  raise(item: {
    title: string;
    body: string;
    dedupeKey: string;
    /** `now` when it can't wait for the owner's morning brief. */
    urgency?: "now";
  }): Promise<unknown>;
  /** This instance's web link for a session (run-instructions.ts). */
  sessionLink(sessionId: string): Promise<string>;
  /** The instance owner on the roster: their name and GitHub login
   *  (incidents/owner.ts), or null without one. */
  instanceOwner(): Promise<{ name: string; github?: string } | null>;
}

const defaultDeps: Deps = {
  fetch: (url, init) => fetchWithTimeout(url, init, FETCH_TIMEOUT_MS),
  now: Date.now,
  repoIsPrivate: (ghRepo) =>
    repoIsPrivate(ghRepo, { maxAgeMs: BLOB_VISIBILITY_MAX_AGE_MS }),
  audit: auditAsync,
  raise: async (item) => {
    const [{ instanceOwner }, { postSupervisorItem }] = await Promise.all([
      import("./incidents/owner"),
      import("./supervisor-inbox"),
    ]);
    const user = instanceOwner();
    if (!user) return;
    await postSupervisorItem({
      user,
      source: SOURCE,
      kind: "needs-you",
      once: true,
      ...item,
    });
  },
  sessionLink: async (sessionId) =>
    (await import("./run-instructions")).sessionLink(sessionId),
  instanceOwner: async () =>
    (await import("./incidents/owner")).instanceOwnerMember(),
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
    as: o.as === "owner" ? "owner" : "own-account",
    login: login && GITHUB_LOGIN.test(login) ? login : undefined,
    tokenRef: str("tokenRef"),
    repos: strings(o.repos),
    publicRepos: strings(o.publicRepos),
    labels: strings(o.labels).map((l) => l.trim()),
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
    as: record.as,
    login: record.login ?? null,
    expiresAt: record.expiresAt ?? null,
    repos: record.repos,
    publicRepos: record.publicRepos,
    labels: record.labels,
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
    if (
      !["as", "token", "repos", "publicRepos", "labels", "enabled"].includes(
        key,
      )
    )
      return { error: `unknown field: ${key}` };
  }
  if ("as" in o) {
    if (o.as !== "own-account" && o.as !== "owner")
      return { error: 'as: must be "own-account" or "owner"' };
    patch.as = o.as;
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
  if ("labels" in o) {
    const value = o.labels;
    if (
      !Array.isArray(value) ||
      value.length > MAX_LABELS ||
      value.some(
        (v) =>
          typeof v !== "string" ||
          !v.trim() ||
          v.trim().length > MAX_LABEL_LENGTH,
      )
    )
      return {
        error: `labels: must be a list of at most ${MAX_LABELS} label names`,
      };
    const labels = [...new Set((value as string[]).map((l) => l.trim()))];
    const trigger = labels.find((l) =>
      LABEL_TRIGGERS.includes(l.toLowerCase()),
    );
    if (trigger)
      return {
        error: `labels: ${trigger} starts an agent loop, so Blob never uses it`,
      };
    patch.labels = labels;
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

/** Why a verified token's account can't be Blob's under `as`, or null.
 *  Blob's own account must be nobody's on the roster; the owner's must be
 *  the instance owner's roster login and the one they signed in with. */
function accountRefusal(
  as: BlobGithubAs,
  login: string,
  owner: { github?: string } | null,
  signedInLogin: string | undefined,
): string | null {
  if (as === "own-account")
    return isRosterLogin(login)
      ? `@${login} is a teammate on the roster. Blob needs an account of its own.`
      : null;
  const ownerLogin = owner?.github?.trim();
  if (!ownerLogin)
    return "The instance owner has no GitHub login on the roster, so Blob can't post as their account.";
  if (login.toLowerCase() !== ownerLogin.toLowerCase())
    return `This token belongs to @${login}, but your GitHub account is @${ownerLogin}. To post as you, Blob needs a token from your own account.`;
  if (signedInLogin?.trim().toLowerCase() !== ownerLogin.toLowerCase())
    return `Sign in with GitHub as @${ownerLogin} to save a token for your account.`;
  return null;
}

/**
 * Apply a checked patch. A new token is verified with GitHub, then stored
 * under a new secret ref before the config points at it; the ref it
 * replaced is deleted after the commit, and a failed commit deletes the new
 * one. `signedInLogin` is the GitHub login the request was signed in with
 * (routes/blob-github.ts), which a token for the owner's account must match.
 */
export async function setBlobGithubSettings(
  patch: BlobGithubPatch,
  actor: string,
  opts: { signedInLogin?: string } = {},
): Promise<BlobGithubResult> {
  let verified: Extract<Verified, { ok: true }> | undefined;
  if (patch.token) {
    const result = await verifyBlobGithubToken(patch.token);
    if (!result.ok) return result;
    verified = result;
  }
  const owner = verified ? await deps.instanceOwner() : null;

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
      const as = patch.as ?? record.as;
      if (as !== record.as) {
        // Blob's own account's earlier posts are recognised by its recorded
        // login, which the owner's account would drop.
        if (record.as === "own-account" && record.login)
          return {
            ok: false,
            status: 400,
            error: `Blob's own account @${record.login} is still recorded, so its earlier posts count as Blob's. Forget Blob's account first.`,
          } as const;
        if (!verified)
          return {
            ok: false,
            status: 400,
            error: "Paste a token for the account Blob will post as.",
          } as const;
      }
      if (verified) {
        const refusal = accountRefusal(
          as,
          verified.login,
          owner,
          opts.signedInLogin,
        );
        if (refusal) return { ok: false, status: 400, error: refusal } as const;
      }
      // Blob's earlier posts are recognised by the recorded login, so the
      // account can only change by removing it first.
      if (
        verified &&
        as === "own-account" &&
        record.as === "own-account" &&
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
        as,
        ...(verified
          ? { login: verified.login, expiresAt: verified.expiresAt }
          : {}),
        tokenRef,
        repos,
        publicRepos,
        labels: patch.labels ?? record.labels,
        enabled,
      };
      const kept = { ...obj(github.blob) };
      delete kept.as;
      github.blob = {
        ...kept,
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
    ...(patch.as ? { as: patch.as } : {}),
  });
  return outcome;
}

/** Remove the token and turn posting off. The login of Blob's own account
 *  stays; the owner's account's goes with the token (see the header). */
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
    if (record.as === "owner") delete blob.login;
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

/** Forget Blob's account: clear `integrations.github.blob` (login, repos,
 *  labels, all of it), so its earlier posts stop counting as Blob's and the
 *  owner can choose whose account Blob posts as again. Refused while a token
 *  is stored: remove the token first. */
export async function forgetBlobGithubAccount(
  actor: string,
): Promise<
  | { ok: true; settings: BlobGithubView }
  | { ok: false; status: number; error: string }
> {
  const outcome = await withConfigMutationLock(async () => {
    const config = await rawConfigAsync();
    const github = githubSection(config);
    const record = parseRecord(github.blob);
    if ((await view(record)).tokenSet)
      return {
        ok: false,
        status: 409,
        error: "Remove the token before forgetting Blob's account",
      } as const;
    delete github.blob;
    await persistRawConfigAsync(config);
    return {
      ok: true,
      settings: await view(parseRecord(undefined)),
      forgotten: record.login,
      retired: record.tokenRef,
    } as const;
  });
  if (!outcome.ok) return outcome;
  // A ref whose secret is already gone; drop the record of it too.
  if (outcome.retired)
    await deleteWorkspaceSecretAsync(outcome.retired).catch(() => {});
  auditAsync({
    kind: "blob_github_update",
    actor,
    accountForgotten: true,
    ...(outcome.forgotten ? { login: outcome.forgotten } : {}),
  });
  return { ok: true, settings: outcome.settings };
}

/** The record as stored: no undefined fields, and `as` only when it is
 *  the owner's account, so a config without it stays as it was. */
function withoutUndefined(record: BlobGithubRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        value !== undefined && !(key === "as" && value === "own-account"),
    ),
  );
}

// ── Posting as Blob ─────────────────────────────────────────────────────
//
// blob_comment, blob_review, blob_label and blob_open_issue
// (blob-github-tools.ts) post through the functions below; they are the
// only callers of the token. Every call fails closed, in this order:
// posting is on, a token is set and not expired, with the owner's account
// its login is still the instance owner's and Blob posts for the instance
// owner, the repository is registered and on Blob's list, a lead's call is
// for its own project, the repository is private per the App's metadata
// (repo-visibility.ts, at most BLOB_VISIBILITY_MAX_AGE_MS old) or named in
// `publicRepos` (a lead's, and a supervisor's for anyone but the instance
// owner, must be private; unknown visibility refuses), the owner has a
// GitHub login for the footer, the text carries no trigger command, trigger
// label, hidden marker, slash command or @mention of anyone but a teammate,
// on a public repository no private term or internal hostname, a label is on
// the owner's allowlist, and the write fits BLOB_WRITES_PER_HOUR for the
// owner, BLOB_WRITES_PER_THREAD_HOUR on that issue or pull request and
// BLOB_WRITES_PER_INSTANCE_HOUR across owners. Every attempt that reaches
// GitHub is audited as Blob, for the owner, with the text as a digest.
// Only the calls `blobRequestRefusal` allows ever leave: a comment, a
// review with event COMMENT, a label read, add or removal, and a new
// issue. Nothing closes, approves, edits, pushes or merges.
//
// A 401 turns posting off and raises one needs-you item to the instance
// owner. `checkBlobGithubExpiry` (run by the supervisor inbox sweep) raises
// one when the token expires within BLOB_EXPIRY_WARN_DAYS.

const API = "https://api.github.com";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Writes Blob makes for one owner an hour. */
export const BLOB_WRITES_PER_HOUR = 30;
/** Writes Blob makes on one issue or pull request for one owner an hour. */
export const BLOB_WRITES_PER_THREAD_HOUR = 5;
/** Writes Blob makes an hour across every owner. */
export const BLOB_WRITES_PER_INSTANCE_HOUR = 60;
/** Inline comments in a review that count as one more write. */
const REVIEW_COMMENTS_PER_WRITE = 5;
/** The one catalog document holding every write of the last hour. */
const WRITES_KEY = "all";
/** Days before the token expires that the owner is told. */
export const BLOB_EXPIRY_WARN_DAYS = 14;
const SOURCE = "blob-github";
const writes = catalogDocuments("blob-github-writes");

/** Who Blob posts for. */
export interface BlobPoster {
  /** The person Blob acts for: the footer's login, the audit's user and the
   *  rate limit's key. */
  owner: string;
  /** The session Blob works from, linked in the footer on private
   *  repositories only. */
  sessionId?: string;
  /** A project lead: only this project's repositories, and only private
   *  ones, unless `recordedStep`. */
  lead?: {
    project: string;
    repos: string[];
    /** A step of a recorded proposal that lead_apply runs (the owner
     *  approved it, or set the lead's rules to let it run). It may also
     *  post on a public repository listed in `publicRepos`, for an
     *  owner who may post there (`privateOnly` unset). */
    recordedStep?: boolean;
  };
  /** Private repositories only: a teammate's supervisor, since nothing on
   *  the instance says which public repositories they may speak on
   *  (blobSupervisorPoster). */
  privateOnly?: boolean;
}

/** Who a supervisor's Blob posts for. Anyone but the instance owner (by
 *  GitHub login, since a first name can be shared) posts on private
 *  repositories only: neither the roster nor the App's installation says
 *  which repositories a teammate can reach, and every teammate may see a
 *  private registered repository's sessions anyway. */
export async function blobSupervisorPoster(
  user: string,
  sessionId?: string,
): Promise<BlobPoster> {
  const { instanceOwnerMember } = await import("./incidents/owner");
  const login = githubLoginFor(user)?.toLowerCase();
  const ownerLogin = instanceOwnerMember()?.github?.trim().toLowerCase();
  return {
    owner: user,
    ...(sessionId ? { sessionId } : {}),
    ...(login && ownerLogin && login === ownerLogin
      ? {}
      : { privateOnly: true }),
  };
}

export type BlobWriteResult =
  | { ok: true; message: string; url?: string }
  | { ok: false; message: string };

export interface BlobReviewComment {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  start_line?: number;
  body: string;
}

/** A slash command for one of our loops (`/os-auto-fix`, `/os review`). */
const TRIGGER_COMMAND = /(^|[^\w/.~-])\/os(?:-[a-z-]+)?(?![\w/])/im;
/** A hidden marker, which would pass the text off as one of our loops'. */
const HIDDEN_MARKER = /<!--/;
/** A line that starts with a slash command, for any bot or Action
 *  (`/deploy`, `/lgtm`). */
const SLASH_COMMAND = /^\s*\/\w/m;
/** A GitHub @mention: a login, or `org/team` with the slash, anywhere but
 *  right after an ASCII letter or digit, so emails don't count but
 *  `_@bot_` and `` `x`@bot `` do. */
const MENTION = /(?<![A-Za-z0-9])@([A-Za-z0-9][A-Za-z0-9-]*)(\/[\w.-]+)?/g;
/** An HTML entity for `@`, which GitHub renders as one. */
const AT_ENTITY = /&(?:#0*64|#x0*40|commat);?/gi;
/** Markdown emphasis markers, which can sit between `@` and a login. */
const EMPHASIS = /[*_~]/g;

/** The ways `text` can read once rendered: entities decoded, then with
 *  emphasis markers kept and stripped. */
function mentionForms(text: string): string[] {
  const decoded = text.replace(AT_ENTITY, "@");
  return [decoded, decoded.replace(EMPHASIS, "")];
}

/** The roster's GitHub logins, lowercase. */
function rosterLogins(): string[] {
  return configuredIdentity()
    .team.map((member) => member.github?.trim().toLowerCase())
    .filter((login): login is string => !!login);
}

/**
 * Why `text` may not go out as Blob, or null. Blob's posts count as our own
 * bot's (OWN_MARKERS), so a body must never carry what starts or steers a
 * loop: a `/os…` command, a trigger label's name, or a hidden marker. Nor
 * may it drive anyone else's: a line starting with a slash command, or an
 * @mention of anyone but a teammate on the roster (other bots such as
 * dependabot answer to theirs), or of a team.
 */
export function blobTextRefusal(
  text: string,
  teammates: readonly string[] = rosterLogins(),
): string | null {
  if (TRIGGER_COMMAND.test(text))
    return "The text contains a /os command. Blob never posts commands for the review or fix loops; quote the text without it.";
  if (SLASH_COMMAND.test(text))
    return "A line of the text starts with a slash command, which bots on GitHub may run. Reword it so no line starts with /.";
  for (const [, login, team] of mentionForms(text).flatMap((form) => [
    ...form.matchAll(MENTION),
  ])) {
    if (team)
      return `The text mentions the team @${login}${team}. Blob never mentions teams; write the name without @.`;
    if (!teammates.includes(login!.toLowerCase()))
      return `The text mentions @${login}, who isn't a teammate on the roster. Blob only mentions teammates; write the name without @.`;
  }
  const lower = text.toLowerCase();
  const label = LABEL_TRIGGERS.find(
    (name) =>
      name !== LABEL_ISSUE &&
      new RegExp(`(^|[^\\w.-])${name}(?![\\w-]|\\.\\w)`).test(lower),
  );
  if (label)
    return `The text names the ${label} label, which starts an agent loop. Leave it out.`;
  if (HIDDEN_MARKER.test(text))
    return "The text contains an HTML comment. Blob's posts carry only its own marker.";
  return null;
}

/** The line every post by Blob ends with: who it is for, the session on a
 *  private repository, and the marker. From the owner's account it says
 *  Blob wrote it, so nobody reads it as the owner's own words. */
export function blobFooter(
  ownerLogin: string,
  sessionUrl: string | undefined,
  as: BlobGithubAs = "own-account",
  ownerName = "",
): string {
  const link = sessionUrl ? ` · [session](${sessionUrl})` : "";
  const signature =
    as === "owner"
      ? `Written by Blob, ${ownerName.trim() ? `${ownerName.trim()}'s` : "the owner's"} assistant`
      : `Blob, for @${ownerLogin}`;
  return `\n\n<sub>${signature}${link}</sub>${BLOB_MARKER}`;
}

/** The only GitHub calls Blob makes: a comment, a review with event
 *  COMMENT, reading a label, adding or removing labels, and opening an
 *  issue. Why a call is refused, or null. Every write path is checked
 *  here before the token leaves, so nothing approves, requests changes,
 *  edits, pushes or merges, whatever account it posts as. A close is
 *  allowed only with `close`, which only blobClose passes: the owner
 *  approved that close as a lead step (leads/apply.ts), and the body may
 *  carry nothing but the close itself. */
export function blobRequestRefusal(
  method: string,
  path: string,
  body?: unknown,
  opts: { close?: boolean } = {},
): string | null {
  const route = path.match(/^\/repos\/[^/]+\/[^/]+(\/.*)$/)?.[1] ?? "";
  const fields = obj(body) ?? {};
  const keys = Object.keys(fields).sort().join(",");
  const closing =
    opts.close === true &&
    ((method === "GET" && /^\/(issues|pulls)\/\d+$/.test(route)) ||
      (method === "PATCH" &&
        /^\/pulls\/\d+$/.test(route) &&
        keys === "state" &&
        fields.state === "closed") ||
      (method === "PATCH" &&
        /^\/issues\/\d+$/.test(route) &&
        keys === "state,state_reason" &&
        fields.state === "closed" &&
        (fields.state_reason === "completed" ||
          fields.state_reason === "not_planned")));
  const allowed =
    closing ||
    (method === "POST" && /^\/issues\/\d+\/comments$/.test(route)) ||
    (method === "POST" &&
      /^\/pulls\/\d+\/reviews$/.test(route) &&
      fields.event === "COMMENT") ||
    (method === "GET" && /^\/labels\/[^/]+$/.test(route)) ||
    (method === "POST" && /^\/issues\/\d+\/labels$/.test(route)) ||
    (method === "DELETE" && /^\/issues\/\d+\/labels\/[^/]+$/.test(route)) ||
    (method === "POST" &&
      route === "/issues" &&
      !("state" in fields) &&
      !("assignees" in fields));
  return allowed
    ? null
    : "Blob only comments, leaves comment reviews, sets labels and opens issues, and closes only what the owner approved. It never approves, edits, pushes or merges.";
}

/** Never written about the private network: the instance's own hostnames
 *  come from its config, and these shapes name hosts that only exist
 *  inside a network. */
const INTERNAL_HOST =
  /\b(?:[a-z0-9-]+\.)+(?:internal|local|lan|corp|intranet|home\.arpa|ts\.net)\b/i;
const PRIVATE_ADDRESS =
  /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

/** The instance's own hostnames: where its UI, webhooks and previews are. */
function instanceHosts(): string[] {
  const server = configuredServer();
  const hosts = [server.publicBaseUrl, server.webhookBaseUrl].map((url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  });
  return [...new Set([...hosts, server.previewHost])]
    .map((host) => host.trim().toLowerCase())
    .filter((host) => !LOOPBACK.has(host));
}

/** Why `text` may not go on a public repository, or null: a private
 *  organization term (policy.privateTerms, matched as
 *  privateTermsDenyReason does), the instance's hostname, or an internal
 *  hostname or address. */
export function blobPublicTextRefusal(
  text: string,
  terms: string[],
): string | null {
  const term = privateTermIn(text, { terms });
  if (term !== undefined)
    return `The repository is public and the text contains the private term "${term}" (policy.privateTerms). Rewrite it without private organization information.`;
  const lower = text.toLowerCase();
  const host = instanceHosts().find((h) => lower.includes(h));
  if (host)
    return `The repository is public and the text names this instance's host ${host}. Leave it out.`;
  if (INTERNAL_HOST.test(text) || PRIVATE_ADDRESS.test(text))
    return "The repository is public and the text names an internal host or address. Leave it out.";
  return null;
}

interface Prepared {
  token: string;
  ghRepo: string;
  /** The owner's GitHub login, as the footer names them. */
  ownerLogin: string;
  footer: string;
  isPrivate: boolean;
  record: BlobGithubRecord;
}

type Guard = { ok: true; value: Prepared } | { ok: false; message: string };

const refuse = (message: string) => ({ ok: false as const, message });

/** The registered GitHub repository `name` names, in its configured
 *  spelling, with its `public` override. */
function registeredRepo(
  name: string,
): { ghRepo: string; public?: boolean } | undefined {
  const key = name.trim().toLowerCase();
  for (const [id, repo] of Object.entries(configuredRepos())) {
    if (repo.host === "codestorage" || !repo.ghRepo) continue;
    if (repo.ghRepo.toLowerCase() === key || id.toLowerCase() === key)
      return { ghRepo: repo.ghRepo, public: repo.public };
  }
  return undefined;
}

/** Every check before a write, in the order of the section's header. */
async function prepare(
  poster: BlobPoster,
  repoName: string,
  texts: string[],
): Promise<Guard> {
  const config = await getConfigAsync();
  const record = parseRecord(obj(config.integrations?.github)?.blob);
  if (!record.enabled)
    return refuse(
      "Blob's GitHub account is off. The owner turns it on in Settings, Members, Blob.",
    );
  const token = record.tokenRef
    ? await resolveWorkspaceSecretAsync(record.tokenRef)
    : undefined;
  if (!token || !record.login)
    return refuse(
      "Blob's GitHub account has no token. Ask the owner to set one.",
    );
  const expires = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
  if (!Number.isFinite(expires) || expires <= deps.now())
    return refuse(
      "Blob's GitHub token has expired. Ask the owner to save a new one.",
    );
  // The owner's account speaks for the owner alone: never for a teammate,
  // and never once the roster names someone else's login as the owner's.
  let ownerName = "";
  if (record.as === "owner") {
    const owner = await deps.instanceOwner();
    const ownerLogin = owner?.github?.trim().toLowerCase();
    if (!ownerLogin || ownerLogin !== record.login.toLowerCase())
      return refuse(
        `Blob posts as the owner's GitHub account, but @${record.login} is no longer the owner's login on the roster. The owner saves a new token in Settings, Members, Blob.`,
      );
    if (
      poster.privateOnly ||
      githubLoginFor(poster.owner)?.toLowerCase() !== ownerLogin
    )
      return refuse(
        "Blob posts on GitHub as the instance owner's own account, so it posts only for the owner.",
      );
    ownerName = owner!.name.trim().split(/\s+/)[0] ?? "";
  }
  const repo = registeredRepo(repoName);
  if (
    !repo ||
    !record.repos.some((r) => r.toLowerCase() === repo.ghRepo.toLowerCase())
  )
    return refuse(
      `${repoName} is not one of Blob's repositories. The owner picks them in Settings, Members, Blob.`,
    );
  if (
    poster.lead &&
    !poster.lead.repos.some(
      (r) => r.toLowerCase() === repo.ghRepo.toLowerCase(),
    )
  )
    return refuse(
      `${repo.ghRepo} is not one of ${poster.lead.project}'s repositories.`,
    );
  const looked =
    repo.public === true ? false : await deps.repoIsPrivate(repo.ghRepo);
  const isPrivate = looked === true;
  if (!isPrivate) {
    if (poster.lead && !poster.lead.recordedStep)
      return refuse(
        `${repo.ghRepo} is public or its visibility is unknown. A lead posts on private repositories only.`,
      );
    if (poster.privateOnly)
      return refuse(
        `${repo.ghRepo} is public or its visibility is unknown. Blob posts on public repositories only for the instance owner.`,
      );
    const listed = record.publicRepos.some(
      (r) => r.toLowerCase() === repo.ghRepo.toLowerCase(),
    );
    if (!listed)
      return refuse(
        looked === null
          ? `Couldn't confirm ${repo.ghRepo} is private, so Blob doesn't post there.`
          : `${repo.ghRepo} is public and not on Blob's list of public repositories.`,
      );
  }
  const ownerLogin = githubLoginFor(poster.owner);
  if (!ownerLogin)
    return refuse(
      "The owner has no GitHub login on the team roster, so the post couldn't say who it is for.",
    );
  const teammates = rosterLogins();
  const terms = config.policy?.privateTerms ?? [];
  for (const text of texts) {
    const refusal =
      blobTextRefusal(text, teammates) ??
      (isPrivate ? null : blobPublicTextRefusal(text, terms));
    if (refusal) return refuse(refusal);
  }
  const footer = blobFooter(
    ownerLogin,
    isPrivate && poster.sessionId
      ? await deps.sessionLink(poster.sessionId)
      : undefined,
    record.as,
    ownerName,
  );
  return {
    ok: true,
    value: {
      token,
      ghRepo: repo.ghRepo,
      ownerLogin,
      footer,
      isPrivate,
      record,
    },
  };
}

interface WriteEntry {
  id: string;
  ts: number;
  thread: string;
  /** canonicalName of the owner. */
  owner: string;
  /** How many writes it counts as: 1, more for a review with many inline
   *  comments. */
  weight: number;
}

function writeEntries(value: unknown): WriteEntry[] {
  const raw = obj(value)?.writes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is WriteEntry =>
      !!obj(e) &&
      typeof e.id === "string" &&
      typeof e.ts === "number" &&
      typeof e.thread === "string" &&
      typeof e.owner === "string" &&
      typeof e.weight === "number",
  );
}

const weightOf = (entries: WriteEntry[]) =>
  entries.reduce((sum, e) => sum + e.weight, 0);

/** Count a write against the owner's and the instance's limits under the
 *  catalog's compare-and-set, all in one document so one check covers
 *  both; null when it fits, else why not. */
async function claimWrite(entry: WriteEntry): Promise<string | null> {
  let refusal: string | null = null;
  await writes.update(WRITES_KEY, (value) => {
    const kept = writeEntries(value).filter((e) => entry.ts - e.ts < HOUR_MS);
    const mine = kept.filter((e) => e.owner === entry.owner);
    refusal = null;
    if (weightOf(mine) + entry.weight > BLOB_WRITES_PER_HOUR)
      refusal = `Blob already wrote ${BLOB_WRITES_PER_HOUR} times on GitHub for you this hour. Try again later.`;
    else if (weightOf(kept) + entry.weight > BLOB_WRITES_PER_INSTANCE_HOUR)
      refusal = `Blob already wrote ${BLOB_WRITES_PER_INSTANCE_HOUR} times on GitHub for the team this hour. Try again later.`;
    else if (
      mine.filter((e) => e.thread === entry.thread).length >=
      BLOB_WRITES_PER_THREAD_HOUR
    )
      refusal = `Blob already wrote ${BLOB_WRITES_PER_THREAD_HOUR} times on ${entry.thread} this hour. Try again later.`;
    return { writes: refusal ? kept : [...kept, entry] };
  });
  return refusal;
}

async function releaseWrite(id: string): Promise<void> {
  await writes
    .update(WRITES_KEY, (value) => ({
      writes: writeEntries(value).filter((e) => e.id !== id),
    }))
    .catch(() => {});
}

const digest = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** GitHub's status and body; status 0 when it couldn't be reached.
 *  `applied` marks a failure after an earlier call of the same write went
 *  through, so it still counts against the limits. */
interface GithubAnswer {
  status: number;
  json: unknown;
  applied?: boolean;
  /** Refused before reaching GitHub, and why. */
  refused?: string;
}

/** One call to GitHub's REST API with Blob's token. Never redirects, so
 *  the token reaches api.github.com alone. */
async function githubCall(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts: { close?: boolean } = {},
): Promise<GithubAnswer> {
  const refused = blobRequestRefusal(method, path, body, opts);
  if (refused) return { status: 0, json: null, refused };
  try {
    const res = await deps.fetch(`${API}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opensession",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

const repoPath = (ghRepo: string) =>
  ghRepo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

/** GitHub refused the token: turn posting off and tell the instance owner,
 *  once per token (the call that turned it off raises the item). */
async function onUnauthorized(record: BlobGithubRecord): Promise<void> {
  const turnedOff = await withConfigMutationLock(async () => {
    const config = await rawConfigAsync();
    const github = githubSection(config);
    const current = obj(github.blob);
    if (!current || current.enabled !== true) return false;
    github.blob = { ...current, enabled: false };
    await persistRawConfigAsync(config);
    return true;
  });
  if (!turnedOff) return;
  deps.audit({
    kind: "blob_github_update",
    actor: BLOB_ACTOR,
    turnedOff: "unauthorized",
  });
  await deps
    .raise({
      title: "GitHub refused Blob's token",
      body: "GitHub answered 401 to Blob's token, so Blob stopped posting on GitHub. Save a new token in Settings, Members, Blob, then turn posting on again.",
      dedupeKey: `blob-github-401:${record.expiresAt ?? "unknown"}`,
      // Posting stopped: it can't wait for the brief.
      urgency: "now",
    })
    .catch(() => {});
}

interface WriteSpec {
  action: "comment" | "review" | "label" | "issue" | "close";
  repo: string;
  /** The issue or pull request; absent for a new issue. */
  number?: number;
  texts: string[];
  /** How many writes it counts as; 1 by default. */
  weight?: number;
  /** A refusal that needs the settings, before the write is counted. */
  check?(p: Prepared): string | null;
  run(p: Prepared): Promise<GithubAnswer>;
  ok(json: unknown, p: Prepared): string;
}

async function write(
  poster: BlobPoster,
  spec: WriteSpec,
): Promise<BlobWriteResult> {
  const guard = await prepare(poster, spec.repo, spec.texts);
  if (!guard.ok) return guard;
  const p = guard.value;
  const checked = spec.check?.(p);
  if (checked) return refuse(checked);
  const thread = `${p.ghRepo}#${spec.number ?? "new"}`;
  const entry: WriteEntry = {
    id: crypto.randomUUID(),
    ts: deps.now(),
    thread,
    owner: canonicalName(poster.owner),
    weight: spec.weight ?? 1,
  };
  const limited = await claimWrite(entry);
  if (limited) return refuse(limited);
  const result = await spec.run(p);
  // A definite failure doesn't count against the limits; an unanswered
  // call may have posted, and a partly applied one did, so they do.
  if (
    (result.refused !== undefined && !result.applied) ||
    (result.status >= 300 && !result.applied)
  )
    await releaseWrite(entry.id);
  if (result.refused === undefined || result.applied)
    deps.audit({
      kind: "blob_github_write",
      action: spec.action,
      repo: p.ghRepo,
      ...(spec.number ? { number: spec.number } : {}),
      text_sha256: digest(spec.texts.join("\n\u0000\n")),
      status: result.status,
      user: poster.owner,
      actor: BLOB_ACTOR,
    });
  if (result.refused !== undefined) return refuse(result.refused);
  if (result.status === 401) {
    await onUnauthorized(p.record);
    return refuse(
      "GitHub refused Blob's token, so posting is off now. The owner has been asked for a new one.",
    );
  }
  if (result.status === 0)
    return refuse(
      "Couldn't reach GitHub. It may still have gone through: check before trying again.",
    );
  if (result.status === 403 || result.status === 404)
    return refuse(
      `GitHub answered ${result.status}: Blob's account can't do that on ${thread}, or it doesn't exist.`,
    );
  if (result.status === 422)
    return refuse(`GitHub answered 422: it refused the request as written.`);
  if (result.status < 200 || result.status >= 300)
    return refuse(`GitHub answered ${result.status}.`);
  const url = obj(result.json)?.html_url;
  return {
    ok: true,
    message: spec.ok(result.json, p),
    ...(typeof url === "string" ? { url } : {}),
  };
}

const where = (json: unknown) => {
  const url = obj(json)?.html_url;
  return typeof url === "string" ? `: ${url}` : "";
};

/** Comment on an issue or pull request as Blob. */
export function blobComment(
  poster: BlobPoster,
  input: { repo: string; number: number; body: string },
): Promise<BlobWriteResult> {
  return write(poster, {
    action: "comment",
    repo: input.repo,
    number: input.number,
    texts: [input.body],
    run: (p) =>
      githubCall(
        p.token,
        "POST",
        `/repos/${repoPath(p.ghRepo)}/issues/${input.number}/comments`,
        {
          body: input.body.trim() + p.footer,
        },
      ),
    ok: (json) => `Commented${where(json)}`,
  });
}

/** A review with comments as Blob. Always event COMMENT: Blob never
 *  approves or requests changes. */
export function blobReview(
  poster: BlobPoster,
  input: {
    repo: string;
    pr: number;
    body: string;
    comments: BlobReviewComment[];
  },
): Promise<BlobWriteResult> {
  return write(poster, {
    action: "review",
    repo: input.repo,
    number: input.pr,
    texts: [input.body, ...input.comments.map((c) => c.body)],
    weight: 1 + input.comments.length / REVIEW_COMMENTS_PER_WRITE,
    run: (p) =>
      githubCall(
        p.token,
        "POST",
        `/repos/${repoPath(p.ghRepo)}/pulls/${input.pr}/reviews`,
        {
          event: "COMMENT",
          body: input.body.trim() + p.footer,
          comments: input.comments.map((c) => ({
            path: c.path,
            line: c.line,
            ...(c.side ? { side: c.side } : {}),
            ...(c.start_line ? { start_line: c.start_line } : {}),
            body: c.body.trim() + p.footer,
          })),
        },
      ),
    ok: (json) => `Reviewed with comments${where(json)}`,
  });
}

/** Add and remove labels as Blob. Only labels on the owner's allowlist
 *  (`labels`, empty turns labelling off) that the repository already has;
 *  never a trigger label, even if listed. */
export function blobLabel(
  poster: BlobPoster,
  input: { repo: string; number: number; add: string[]; remove: string[] },
): Promise<BlobWriteResult> {
  const add = [...new Set(input.add.map((l) => l.trim()).filter(Boolean))];
  const remove = [
    ...new Set(input.remove.map((l) => l.trim()).filter(Boolean)),
  ];
  if (!add.length && !remove.length)
    return Promise.resolve(refuse("Name a label to add or remove."));
  const trigger = [...add, ...remove].find((l) =>
    LABEL_TRIGGERS.includes(l.toLowerCase()),
  );
  if (trigger)
    return Promise.resolve(
      refuse(
        `${trigger} starts an agent loop, so Blob never adds or removes it. Hand that work over with ask_pat instead.`,
      ),
    );
  return write(poster, {
    action: "label",
    repo: input.repo,
    number: input.number,
    texts: [],
    check: (p) => {
      if (!p.record.labels.length)
        return "Labelling is off: the instance owner hasn't listed any labels for Blob (integrations.github.blob.labels).";
      const allowed = new Set(p.record.labels.map((l) => l.toLowerCase()));
      const outside = [...add, ...remove].find(
        (l) => !allowed.has(l.toLowerCase()),
      );
      return outside
        ? `${outside} is not on the owner's list of labels Blob may use.`
        : null;
    },
    run: async (p) => {
      const base = `/repos/${repoPath(p.ghRepo)}`;
      for (const label of add) {
        const found = await githubCall(
          p.token,
          "GET",
          `${base}/labels/${encodeURIComponent(label)}`,
        );
        if (found.status === 404)
          return {
            status: 0,
            json: null,
            refused: `${p.ghRepo} has no label named ${label}. Blob only uses existing labels.`,
          };
        if (found.status !== 200) return found;
      }
      let last: GithubAnswer = {
        status: 200,
        json: null,
      };
      let applied = false;
      if (add.length) {
        last = await githubCall(
          p.token,
          "POST",
          `${base}/issues/${input.number}/labels`,
          { labels: add },
        );
        if (last.status === 0 || last.status >= 300) return last;
        applied = true;
      }
      for (const label of remove) {
        last = await githubCall(
          p.token,
          "DELETE",
          `${base}/issues/${input.number}/labels/${encodeURIComponent(label)}`,
        );
        // Not on the issue: nothing to remove.
        if (last.status === 404) last = { status: 200, json: null };
        if (last.status === 0 || last.status >= 300)
          return { ...last, applied };
        applied = true;
      }
      return last;
    },
    ok: () =>
      [
        add.length ? `Added ${add.join(", ")}` : "",
        remove.length ? `removed ${remove.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ") + ".",
  });
}

/** The fixed note a close posts, before Blob's footer: `note` is the
 *  reason line the owner approved. */
export function blobCloseNote(ownerLogin: string, note: string): string {
  return `Closed by Blob for @${ownerLogin}: ${note}`;
}

/** What a close checks right before it closes, refusing when it moved. */
export interface BlobCloseExpect {
  /** The issue's `updated_at` and state when the close was proposed. */
  issue?: { updatedAt: string; state: "open" | "closed" };
  /** The pull request's head when the close was proposed. */
  headSha?: string;
}

/** Close an issue (`completed` or `not_planned`) or a pull request as
 *  Blob. An issue that turns out to be a pull request, or the other way
 *  round, is refused; one already closed counts as done, unless `expect`
 *  pins it open. With `expect`, the issue or the pull request's head is
 *  read right before closing and a change refuses. With `note`, the fixed
 *  note (blobCloseNote) is posted first, after every check, so a refused
 *  close posts nothing. */
export function blobClose(
  poster: BlobPoster,
  input: {
    repo: string;
    number: number;
    pullRequest: boolean;
    reason?: "completed" | "not_planned";
    note?: string;
    expect?: BlobCloseExpect;
  },
): Promise<BlobWriteResult> {
  const what = input.pullRequest ? "pull request" : "issue";
  const note = input.note?.trim();
  return write(poster, {
    action: "close",
    repo: input.repo,
    number: input.number,
    texts: note ? [note] : [],
    weight: note ? 2 : 1,
    run: async (p) => {
      const base = `/repos/${repoPath(p.ghRepo)}`;
      const name = `#${input.number} in ${p.ghRepo}`;
      const found = await githubCall(
        p.token,
        "GET",
        `${base}/issues/${input.number}`,
        undefined,
        { close: true },
      );
      if (found.status !== 200) return found;
      const issue = obj(found.json);
      if (!!issue?.pull_request !== input.pullRequest)
        return {
          status: 0,
          json: null,
          refused: `${name} is ${input.pullRequest ? "an issue" : "a pull request"}, not ${input.pullRequest ? "a pull request" : "an issue"}.`,
        };
      const pinned = input.expect?.issue;
      if (
        pinned &&
        (issue?.updated_at !== pinned.updatedAt ||
          issue?.state !== pinned.state)
      )
        return {
          status: 0,
          json: null,
          refused: `${name} changed since this was proposed, so Blob didn't close it.`,
        };
      if (issue?.state === "closed") return { status: 200, json: issue };
      if (input.expect?.headSha) {
        const pr = await githubCall(
          p.token,
          "GET",
          `${base}/pulls/${input.number}`,
          undefined,
          { close: true },
        );
        if (pr.status !== 200) return pr;
        if (obj(obj(pr.json)?.head)?.sha !== input.expect.headSha)
          return {
            status: 0,
            json: null,
            refused: `${name} has new commits since ${input.expect.headSha.slice(0, 7)} was proposed, so Blob didn't close it.`,
          };
      }
      if (note) {
        const posted = await githubCall(
          p.token,
          "POST",
          `${base}/issues/${input.number}/comments`,
          { body: blobCloseNote(p.ownerLogin, note) + p.footer },
        );
        if (posted.status < 200 || posted.status >= 300) return posted;
      }
      const closed = input.pullRequest
        ? await githubCall(
            p.token,
            "PATCH",
            `${base}/pulls/${input.number}`,
            { state: "closed" },
            { close: true },
          )
        : await githubCall(
            p.token,
            "PATCH",
            `${base}/issues/${input.number}`,
            { state: "closed", state_reason: input.reason ?? "completed" },
            { close: true },
          );
      // The note went out: a failed close still wrote.
      return note ? { ...closed, applied: true } : closed;
    },
    ok: (json) => `Closed the ${what}${where(json)}`,
  });
}

/** Open an issue as Blob. */
export function blobOpenIssue(
  poster: BlobPoster,
  input: { repo: string; title: string; body: string },
): Promise<BlobWriteResult> {
  return write(poster, {
    action: "issue",
    repo: input.repo,
    texts: [input.title, input.body],
    run: (p) =>
      githubCall(p.token, "POST", `/repos/${repoPath(p.ghRepo)}/issues`, {
        title: input.title.trim(),
        body: input.body.trim() + p.footer,
      }),
    ok: (json) => {
      const number = obj(json)?.number;
      return `Opened${typeof number === "number" ? ` #${number}` : ""}${where(json)}`;
    },
  });
}

/**
 * Tell the instance owner, once per token, that Blob's token expires within
 * BLOB_EXPIRY_WARN_DAYS. Run by the supervisor inbox sweep
 * (supervisor-inbox.ts); reads the config only.
 */
export async function checkBlobGithubExpiry(): Promise<boolean> {
  const config = await getConfigAsync();
  const record = parseRecord(obj(config.integrations?.github)?.blob);
  if (!record.enabled || !record.tokenRef || !record.expiresAt) return false;
  const left = Date.parse(record.expiresAt) - deps.now();
  if (!Number.isFinite(left) || left > BLOB_EXPIRY_WARN_DAYS * DAY_MS)
    return false;
  await deps.raise({
    title: "Blob's GitHub token expires soon",
    body: `Blob's GitHub token expires on ${record.expiresAt.slice(0, 10)}. After that Blob can't post on GitHub. Create a new token for Blob's account and save it in Settings, Members, Blob.`,
    dedupeKey: `blob-github-expiry:${record.expiresAt}`,
  });
  return true;
}
