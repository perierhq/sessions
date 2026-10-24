/**
 * Who opened a pull request or issue, relative to this instance's team: a
 * roster member (or the instance's own agent account), a bot, or someone
 * outside the team. The Pull requests and Issues pages read it to list and
 * mark work that came from the public.
 *
 * Classified when a row is served rather than stored with it, so cached rows
 * and the on-disk PR snapshot follow the roster in force, not the one they
 * were fetched under.
 */
import { githubBotLogins } from "./config";
import { githubLoginToPersonKey } from "./shared/user-mappings";

export type AuthorKind = "team" | "outside" | "bot";

// Automation accounts GitHub does not name with the `[bot]` suffix everywhere:
// Copilot's coding agent authors as "Copilot", and Renovate's self-hosted
// account is a plain user.
const KNOWN_BOTS = new Set([
  "dependabot",
  "dependabot-preview",
  "renovate",
  "renovate-bot",
  "github-actions",
  "copilot",
  "copilot-swe-agent",
]);

/** `@Login`, `app/slug` (gh) and `slug[bot]` (REST) to one lowercase form. */
function normalize(login: string): { login: string; app: boolean } {
  const lower = login.trim().replace(/^@/, "").toLowerCase();
  if (lower.startsWith("app/"))
    return { login: `${lower.slice(4)}[bot]`, app: true };
  return { login: lower, app: lower.endsWith("[bot]") };
}

export function classifyGithubAuthor(
  login: string | null | undefined,
  roster: {
    isTeamLogin: (login: string) => boolean;
    /** Lowercase logins of the instance's own agent accounts. */
    ownBotLogins: readonly string[];
  },
): AuthorKind {
  if (!login?.trim()) return "outside";
  const { login: key, app } = normalize(login);
  if (roster.isTeamLogin(key)) return "team";
  if (roster.ownBotLogins.includes(key)) return "team";
  if (app || KNOWN_BOTS.has(key.replace(/\[bot\]$/, ""))) return "bot";
  return "outside";
}

/** The same, against the configured roster and agent accounts. */
export function githubAuthorKind(login: string | null | undefined): AuthorKind {
  return classifyGithubAuthor(login, {
    isTeamLogin: (key) => !!githubLoginToPersonKey(key),
    ownBotLogins: githubBotLogins(),
  });
}
