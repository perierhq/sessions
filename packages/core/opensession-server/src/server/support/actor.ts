// Who is changing support settings, for the permission checks in the
// inbox store and "Forget this customer". Any signed-in person may create
// and edit inboxes; the instance owner (incidents/owner.ts
// `instanceOwner()`: the configured notify user, else the first directory
// member) alone may let Sessions send right away, allow internal mail
// servers, remove inboxes and forget a customer.
//
// Routes build the actor with `actorFor(verifiedPerson(ctx), ...)`: a
// claimed name or the automation principal is never verified, so it can
// never act as the owner. Nothing runs at import.
import { instanceOwner, personOwner } from "../incidents/owner";

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

/** The actor for `name`; only a verified person can be the instance
 *  owner, and only when the instance has one. */
export function actorFor(name: string, verified: boolean): Actor {
  const person = verified ? personOwner(name) : null;
  const owner = instanceOwner();
  return {
    name,
    verified: verified && Boolean(name.trim()),
    isInstanceOwner: person !== null && owner !== "" && person === owner,
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
