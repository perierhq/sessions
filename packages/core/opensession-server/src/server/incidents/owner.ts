// Who owns a signal and the incidents it opens: always a person, never a
// machine principal (the Automation web identity, an automation's own
// runs, the agent). A person is named the way the inbox and push key
// people: the roster member's first name, the same value `requestUser`
// gives a signed-in person. Without a roster, a person's name stays as
// given.
//
// When nobody is left, the instance owner (the first directory member on
// the roster) owns the signal and is told about its incidents.
//
// Reads the in-memory config snapshot only; nothing runs at import.
import type { Signal } from "../../shared/incidents";
import { configuredIdentity, type TeamMember } from "../config";
import { isMachineActor } from "../session-actors";

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

/** The roster member `name` refers to: full name, first name, alias or
 *  GitHub login, in any case. */
function memberFor(name: string, team: TeamMember[]): TeamMember | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return team.find(
    (m) =>
      m.name.trim().toLowerCase() === key ||
      firstName(m).toLowerCase() === key ||
      m.github?.trim().toLowerCase() === key ||
      (m.aliases ?? []).some((alias) => alias.trim().toLowerCase() === key),
  );
}

/** Whether `name` could be a person at all: not blank, not a machine
 *  principal. */
export function isPersonName(name: string | null | undefined): name is string {
  const trimmed = (name ?? "").trim();
  return trimmed !== "" && !isMachineActor(trimmed);
}

/** `name` as an owner (the roster's first name for a member, the name as
 *  given off the roster), or null when it is not a person. */
export function personOwner(name: string | null | undefined): string | null {
  if (!isPersonName(name)) return null;
  const member = memberFor(name, roster());
  return member ? firstName(member) || name.trim() : name.trim();
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
