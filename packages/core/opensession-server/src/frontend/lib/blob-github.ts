// Blob's GitHub account in Settings, Members: the owner-only settings behind
// GET/PUT /api/blob/github and DELETE /api/blob/github/token
// (server/routes/blob-github.ts). The token is write-only: it goes up in a
// PUT and never comes back, only whether one is set. Pure apart from the
// fetches, so the section and its tests share one reading.

import { z } from "zod";
import { ApiError, request } from "./api/request";
import { BASE_PATH } from "./base";
import type { GetFetch } from "./blob-member";

/** Whose GitHub account Blob posts as: a machine user of its own, or the
 *  owner's own account with every post signed as Blob. */
export type BlobGithubAs = "own-account" | "owner";

export const BLOB_GITHUB_PURPOSE =
  "Blob can comment, review and label on GitHub under its own account. It never pushes or merges.";

/** The same, when Blob posts as the owner's account. */
export const BLOB_GITHUB_OWNER_PURPOSE =
  "Blob can comment, review and label on GitHub under your account. Each post ends with a line saying Blob wrote it. It never closes, approves, pushes or merges.";

/** The "Post as" choice: its two options and what each means. */
export const BLOB_GITHUB_AS_CHOICES: ReadonlyArray<{
  value: BlobGithubAs;
  label: string;
  description: string;
}> = [
  {
    value: "own-account",
    label: "Blob\u2019s account",
    description:
      "A GitHub account of its own, so its posts show under Blob\u2019s name.",
  },
  {
    value: "owner",
    label: "My account",
    description:
      "Posts show under your name, each signed \u201cWritten by Blob, your assistant\u201d. Your own comments stay yours.",
  },
];

/** The setup doc's section, for the full steps. */
export const BLOB_GITHUB_DOCS_URL =
  "https://github.com/perierhq/sessions/blob/main/docs/setup/github.md#blobs-github-account";

/** The setup doc's section for a token on the owner's own account. */
export const BLOB_GITHUB_OWNER_DOCS_URL =
  "https://github.com/perierhq/sessions/blob/main/docs/setup/github.md#posting-as-your-own-account";

/** The setup doc's steps, cut to what the owner does on GitHub. */
export const BLOB_GITHUB_STEPS = [
  "Sign up a GitHub account for Blob and add it to your organization",
  "Give it the Triage role on the repositories Blob may use",
  "As that account, create a fine-grained token for those repositories: Issues and Pull requests read and write, 90 days",
];

/** The same, for a token on the owner's own account. */
export const BLOB_GITHUB_OWNER_STEPS = [
  "On your GitHub account, create a fine-grained token limited to the repositories Blob may use",
  "Give it Issues and Pull requests read and write, with a 90 day expiry",
];

/** Under the token field, for a token on the owner's own account. */
export const BLOB_GITHUB_OWNER_TOKEN_HINT =
  "A fine-grained token on your account, limited to the chosen repositories, with Issues and Pull requests read and write.";

/** Under this many days left, the expiry warns. */
export const EXPIRY_WARN_DAYS = 14;

const DAY_MS = 86_400_000;

const viewSchema = z.object({
  /** Absent on a server without the choice: Blob's own account. */
  as: z.enum(["own-account", "owner"]).optional(),
  login: z.string().nullable(),
  expiresAt: z.string().nullable(),
  repos: z.array(z.string()),
  publicRepos: z.array(z.string()),
  enabled: z.boolean(),
  tokenSet: z.boolean(),
  /** The labels Blob may set; empty turns labelling off. Absent on a
   *  server without the allowlist, and the field then stays hidden. */
  labels: z.array(z.string()).optional(),
});
export type BlobGithub = z.infer<typeof viewSchema>;

const responseSchema = z.object({ blob: viewSchema });

/** What the section shows. `hidden` is the server saying this person may
 *  not see it (signed out, not the owner) or an old server without the
 *  route; the section then renders nothing. */
export type BlobGithubLoad =
  | { kind: "ready"; settings: BlobGithub }
  | { kind: "hidden" }
  | { kind: "error" };

const HIDDEN_STATUSES = new Set([401, 403, 404]);

export async function loadBlobGithub(
  fetchImpl: GetFetch = (input) => fetch(input),
): Promise<BlobGithubLoad> {
  try {
    const response = await fetchImpl(`${BASE_PATH}/api/blob/github`);
    if (HIDDEN_STATUSES.has(response.status)) return { kind: "hidden" };
    if (!response.ok) return { kind: "error" };
    const parsed = responseSchema.safeParse(await response.json());
    return parsed.success
      ? { kind: "ready", settings: parsed.data.blob }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export interface BlobGithubPatch {
  as?: BlobGithubAs;
  token?: string;
  repos?: string[];
  publicRepos?: string[];
  enabled?: boolean;
  labels?: string[];
}

/** The server answered, but not with the settings. */
export class UnexpectedAnswerError extends Error {
  constructor() {
    super("The server sent an unexpected answer.");
    this.name = "UnexpectedAnswerError";
  }
}

/** One request whose answer is the settings. A body that is not the
 *  settings is UnexpectedAnswerError, so it never reads as the network. */
async function requestView(
  path: string,
  opts: { method: string; body?: BlobGithubPatch; label: string },
): Promise<BlobGithub> {
  const parsed = responseSchema.safeParse(await request(path, opts));
  if (!parsed.success) throw new UnexpectedAnswerError();
  return parsed.data.blob;
}

export function saveBlobGithub(patch: BlobGithubPatch): Promise<BlobGithub> {
  return requestView("/blob/github", {
    method: "PUT",
    body: patch,
    label: "Couldn't save Blob's GitHub account",
  });
}

export function removeBlobGithubToken(): Promise<BlobGithub> {
  return requestView("/blob/github/token", {
    method: "DELETE",
    label: "Couldn't remove the token",
  });
}

/** A server or network error as a sentence for the person. The route's
 *  checks name the field (`token: ...`); the person only sees the reason. */
export function plainError(error: Error): string {
  if (error instanceof UnexpectedAnswerError) return error.message;
  if (!(error instanceof ApiError))
    return "Couldn't reach the server. Try again.";
  const message = error.message.trim();
  if (/^token: use a fine-grained/i.test(message))
    return "Use a fine-grained token. It starts with github_pat_.";
  if (/^token: not a GitHub token/i.test(message))
    return "That isn't a GitHub token. Copy it again, whole.";
  if (/^token: must be a non-empty/i.test(message)) return "Paste a token.";
  const field = /^[a-zA-Z]+: /.exec(message);
  const sentence = field
    ? message.charAt(field[0].length).toUpperCase() +
      message.slice(field[0].length + 1)
    : message;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export interface TokenExpiry {
  text: string;
  /** Under EXPIRY_WARN_DAYS left, or already past. */
  warn: boolean;
  expired: boolean;
}

/** Whose account Blob posts as; Blob's own on an older server. */
export function blobGithubAs(settings: Pick<BlobGithub, "as">): BlobGithubAs {
  return settings.as ?? "own-account";
}

/** Whether the owner may still choose whose account Blob posts as: not
 *  while a token is set, and not while Blob's own account is recorded,
 *  since its earlier posts are recognised by that login. */
export function canChooseBlobGithubAs(
  settings: Pick<BlobGithub, "as" | "login" | "tokenSet">,
): boolean {
  if (settings.tokenSet) return false;
  return !(blobGithubAs(settings) === "own-account" && settings.login);
}

/** The token's expiry, relative: "Expires in 42 days", "Expires tomorrow". */
export function tokenExpiry(
  expiresAt: string | null,
  now = Date.now(),
): TokenExpiry | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const left = at - now;
  if (left <= 0) return { text: "Expired", warn: true, expired: true };
  const days = Math.floor(left / DAY_MS);
  const warn = days < EXPIRY_WARN_DAYS;
  const expired = false;
  if (days === 0) return { text: "Expires today", warn, expired };
  if (days === 1) return { text: "Expires tomorrow", warn, expired };
  return { text: `Expires in ${days} days`, warn, expired };
}

/** The labels field's text as a list: comma separated, trimmed, each once. */
export function parseLabels(text: string): string[] {
  const labels = new Map<string, string>();
  for (const part of text.split(",")) {
    const label = part.trim();
    if (label && !labels.has(label.toLowerCase()))
      labels.set(label.toLowerCase(), label);
  }
  return [...labels.values()];
}

/** The registered repositories Blob can be given: those on GitHub. */
export function githubRepoNames(
  repos: ReadonlyArray<{ ghRepo?: string }>,
): string[] {
  const names = new Map<string, string>();
  for (const repo of repos) {
    const name = repo.ghRepo?.trim();
    if (name) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
}

/** Turn `name` on or off in Blob's repositories. Dropping one drops it from
 *  the public ones too, as the server does. */
export type BlobGithubRepos = Pick<BlobGithub, "repos" | "publicRepos">;

export function toggleRepo(
  settings: BlobGithubRepos,
  name: string,
  on: boolean,
): BlobGithubRepos {
  const repos = on
    ? [...settings.repos.filter((r) => r !== name), name]
    : settings.repos.filter((r) => r !== name);
  return {
    repos,
    publicRepos: settings.publicRepos.filter((r) => repos.includes(r)),
  };
}

export function togglePublicRepo(
  settings: Pick<BlobGithub, "publicRepos">,
  name: string,
  on: boolean,
): string[] {
  const rest = settings.publicRepos.filter((r) => r !== name);
  return on ? [...rest, name] : rest;
}
