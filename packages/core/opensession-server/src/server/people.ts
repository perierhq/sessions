/**
 * Team directory for the frontend — the single roster the UI should use for
 * people pickers, avatars, @-mention completion and the sidebar People band.
 * Derived from the same identity config as commit attribution
 * (configuredIdentity() → ~/.backstage/config.json identity.team), so adding a
 * teammate to the config updates every people surface at once instead of the
 * historical trio of hardcoded arrays (UserPicker TEAM, UserAvatar login map,
 * a mention roster of its own).
 */

import { codeRanges } from "../shared/code-ranges";
import { configuredIdentity, type ReviewTeam } from "./config";
import { BLOB_ACTOR, BLOB_ICON_PATH, isBlobActor } from "./session-actors";
import { profileImagesByMemberName } from "./user-profiles";

export interface DirectoryPerson {
  /** A teammate, or a first-party bot (Blob). Bots are drawn with their
   *  picture and a bot badge, and never offered where a person is picked. */
  kind: "person" | "bot";
  /** Picker/display first name — the value presence viewers,
   *  push-subscription keys and `startedBy` use. */
  name: string;
  /** Full display name from the identity roster. */
  fullName: string;
  /** GitHub login (avatar source), when known. */
  github?: string;
  /** IANA timezone, when configured. */
  timezone?: string;
  /** Uploaded profile picture as a `/media` URL, when they set one. Takes
   *  precedence over the GitHub avatar in every client (user-profiles.ts). */
  image?: string;
}

/** The mentionable/pickable team, in config order. Members flagged
 *  `directory: false` (attribution-only identities) are excluded. */
export function teamDirectory(): DirectoryPerson[] {
  // One pass over the picture store for the whole roster rather than a file
  // read per member per caller: this runs on every GET /api/people.
  const images = profileImagesByMemberName();
  return configuredIdentity()
    .team.filter((m) => m.directory !== false)
    .map((m) => ({
      kind: "person" as const,
      name: m.name.split(" ")[0],
      fullName: m.name,
      ...(m.github ? { github: m.github } : {}),
      ...(m.timezone ? { timezone: m.timezone } : {}),
      ...(images[m.name] ? { image: images[m.name] } : {}),
    }));
}

/**
 * The first-party bots that work alongside the team: Blob, the supervisor.
 * Listed apart from `teamDirectory()` on GET /api/people (`bots`), so every
 * people picker, reviewer list, mention roster and push key, on clients old
 * and new, keeps offering only people.
 */
export function botDirectory(): DirectoryPerson[] {
  return [
    {
      kind: "bot",
      name: BLOB_ACTOR,
      fullName: BLOB_ACTOR,
      image: BLOB_ICON_PATH,
    },
  ];
}

/** Picker first names — the mention-matching + push-key roster. */
export function teamFirstNames(): string[] {
  return teamDirectory().map((p) => p.name);
}

/** Review groups offered alongside individual people in reviewer pickers. */
export function reviewTeamDirectory(): ReviewTeam[] {
  const identity = configuredIdentity();
  return identity.reviewTeams.flatMap((team) => {
    const members = [
      ...new Set(
        team.members.flatMap((ref) => {
          const key = ref.trim().toLowerCase();
          const member = identity.team.find((candidate) => {
            const aliases = candidate.aliases?.length
              ? candidate.aliases
              : [candidate.name.split(" ")[0] || ""];
            return (
              candidate.name.toLowerCase() === key ||
              aliases.some((alias) => alias.toLowerCase() === key)
            );
          });
          return member ? [member.name.split(" ")[0]!] : [];
        }),
      ),
    ];
    return members.length ? [{ ...team, members }] : [];
  });
}

/** Resolve either a group's display name or its GitHub reviewer spec. */
export function reviewTeamFor(ref?: string | null): ReviewTeam | null {
  if (!ref) return null;
  const key = ref.trim().toLowerCase();
  return (
    reviewTeamDirectory().find(
      (team) =>
        team.name.toLowerCase() === key || team.github.toLowerCase() === key,
    ) || null
  );
}

/**
 * Distinct teammates `@`-mentioned in `text` — never the sender themself.
 * Matched against the picker first names, which are also the keys push
 * subscriptions are stored under (push.ts matches exact names).
 * `@session:<id>` tags don't collide: "session" is not a teammate name.
 */
export function mentionedUsers(text: string, sender: string): string[] {
  const team = teamFirstNames();
  const found = new Set<string>();
  for (const m of text.matchAll(/@([A-Za-z][\w.-]*)/g)) {
    const name = team.find((n) => n.toLowerCase() === m[1].toLowerCase());
    if (name && name.toLowerCase() !== sender.trim().toLowerCase())
      found.add(name);
  }
  return [...found];
}

/** `text` with its code blanked out, by the rule the composer uses to keep
 *  pills out of code (shared/code-ranges.ts). */
function withoutCode(text: string): string {
  let out = "";
  let at = 0;
  for (const range of codeRanges(text)) {
    out += `${text.slice(at, range.start)} `;
    at = range.end;
  }
  return out + text.slice(at);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `text` mentions Blob: `@Blob`, any case, as a whole word outside
 * code, or `@<blobLogin>` once a GitHub account is set for Blob. An `@`
 * inside a word (an email like `blob@example.test`) is not a mention, nor is
 * a longer name (`@Blobby`). Blob mentioning itself never counts, so its own
 * replies cannot route back to it.
 */
export function mentionsBlob(
  text: string,
  sender: string,
  blobLogin?: string | null,
): boolean {
  const login = blobLogin?.trim();
  const from = sender.trim().toLowerCase();
  if (isBlobActor(sender) || (login && from === login.toLowerCase()))
    return false;
  const names = [BLOB_ACTOR, ...(login ? [login] : [])].map(escapeRegExp);
  // Before: not part of a word in any script, address or path. After: the
  // name ends here; a sentence's full stop may follow, a domain's dot may not.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_.@/+-])@(?:${names.join("|")})(?![\\p{L}\\p{M}\\p{N}_-]|\\.[\\p{L}\\p{N}_])`,
    "iu",
  );
  return pattern.test(withoutCode(text));
}
