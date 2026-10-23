// Who owns a signal and the incidents it opens: always a person, never a
// machine principal (the Automation web identity, an automation's own
// runs, the agent). A person is named the way the inbox and push key
// people: the roster member's first name, the same value `requestUser`
// gives a signed-in person. With a roster, a name nobody on it goes by is
// no owner; without one, a person's name stays as given.
//
// When nobody is left, the instance owner (the first directory member on
// the roster) owns the signal and is told about its incidents.
//
// Reads the in-memory config snapshot only; nothing runs at import.
import type { Signal } from "../../shared/incidents";
import { configuredIdentity, type TeamMember } from "../config";
import { humanPrompter } from "../session-actors";

let rosterOverride: TeamMember[] | undefined;

/** Replace the roster (tests); undefined restores the configured one. */
export function __setOwnerRosterForTest(team: TeamMember[] | undefined): void {
  rosterOverride = team;
}

function roster(): TeamMember[] {
  if (rosterOverride) return rosterOverride;
  try {
    return configuredIdentity().team;
  } catch {
    return [];
  }
}

function firstName(member: TeamMember): string {
  return member.name.trim().split(" ")[0] ?? "";
}

/** The directory member `name` refers to: full name, first name, alias or
 *  GitHub login, in any case. Attribution-only identities (`directory:
 *  false`) are left out, as they are from the push-key roster (people.ts):
 *  nobody reads their inbox. */
function memberFor(name: string, team: TeamMember[]): TeamMember | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return team.find(
    (m) =>
      m.directory !== false &&
      (m.name.trim().toLowerCase() === key ||
        firstName(m).toLowerCase() === key ||
        m.github?.trim().toLowerCase() === key ||
        (m.aliases ?? []).some((alias) => alias.trim().toLowerCase() === key)),
  );
}

/** Whether `name` could be a person at all: not blank, not the
 *  "Anonymous" placeholder of an instance without sign-in, not a machine
 *  principal (as `humanPrompter` in session-actors.ts). */
export function isPersonName(name: string | null | undefined): name is string {
  return humanPrompter(name) !== null;
}

/** `name` as an owner (the roster's first name for a member, the name as
 *  given on an instance without a roster), or null when it is not a
 *  person: a machine principal, or a name nobody on the roster goes by. */
export function personOwner(name: string | null | undefined): string | null {
  const owner = resolveOwner(name);
  return typeof owner === "string" ? owner : null;
}

/** `name` as an owner, or why it cannot be one. */
export function resolveOwner(
  name: string | null | undefined,
): string | { error: string } {
  if (!isPersonName(name)) return { error: "The owner must be a person" };
  const team = roster();
  if (team.length === 0) return name.trim();
  const member = memberFor(name, team);
  if (!member)
    return {
      error: `Nobody on the team is called ${JSON.stringify(name.trim())}`,
    };
  return firstName(member) || name.trim();
}

/** The instance owner: the first directory member on the roster, or "" on
 *  an instance without one. */
export function instanceOwner(): string {
  const member = roster().find((m) => m.directory !== false && firstName(m));
  return member ? firstName(member) : "";
}

/** Who owns `signal` now: its owner, else a person who created it, else
 *  the instance owner; "" when there is nobody. */
export function signalOwner(
  signal: Pick<Signal, "owner" | "createdBy">,
): string {
  return (
    personOwner(signal.owner) ??
    personOwner(signal.createdBy) ??
    instanceOwner()
  );
}
