// Who is changing support settings, for the permission checks in the
// inbox store and "Forget this customer". Any signed-in person may create
// and edit inboxes; the instance owner (incidents/owner.ts
// `instanceOwner()`: the configured notify user, else the first directory
// member) alone may let Sessions send right away, allow internal mail
// servers, remove inboxes and forget a customer.
//
// Routes build the actor with `actorFor(verifiedPerson(ctx), true,
// ctx.authUser?.login)`: a claimed name or the automation principal is never
// verified, so it can never act as the owner. The owner is matched by the
// signed-in GitHub login against the owner's roster entry, never by first
// name, which two people can share. Nothing runs at import.
import { instanceOwnerMember } from "../incidents/owner";

export interface Actor {
  name: string;
  /** Signed in as this person (routes: `verifiedPerson(ctx)`). */
  verified: boolean;
  isInstanceOwner: boolean;
}

/** A refused action: the route answers 403 with the message. */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The actor for `name`, signed in as GitHub `login`. Only a verified
 *  person whose login is the instance owner's roster login is the owner. */
export function actorFor(
  name: string,
  verified: boolean,
  login?: string | null,
): Actor {
  const isVerified = verified && Boolean(name.trim());
  const ownerLogin = instanceOwnerMember()?.github?.trim().toLowerCase();
  const signedIn = login?.trim().toLowerCase();
  return {
    name,
    verified: isVerified,
    isInstanceOwner:
      isVerified && !!ownerLogin && !!signedIn && signedIn === ownerLogin,
  };
}

/** Whether `actor` may do owner-only things. */
export function isOwnerActor(actor: Actor): boolean {
  return actor.verified === true && actor.isInstanceOwner === true;
}

/** Throws ForbiddenError unless `actor` is the verified instance owner. */
export function requireInstanceOwner(actor: Actor, message: string): void {
  if (!isOwnerActor(actor)) throw new ForbiddenError(message);
}
