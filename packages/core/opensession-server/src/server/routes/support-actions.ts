// /api/support/conversations/:id/{move,owner,close,reopen,not-spam,
// issue/approve,issue/dismiss}: what a person does to a conversation
// besides replying (support/actions.ts, support/bugs.ts). Signed-in people
// only (`verifiedPerson`): the automation principal and claimed names are
// never a person here; the person is an actor built with actorFor(), so
// only the instance owner approves an issue for a public repository.
// issue/approve needs `expectedRevision`, the conversation revision the
// person saw. Each answers with the conversation as GET
// /api/support/conversations/:id does. "Forget this customer" is
// POST /api/support/customers/forget in support-inboxes.ts.
import type { SupportActor } from "../../shared/support";
import {
  closeConversation,
  markNotSpam,
  moveConversation,
  reopenConversation,
  setOwner,
} from "../support/actions";
import { actorFor } from "../support/actor";
import { approvePendingIssue, dismissPendingIssue } from "../support/bugs";
import { getConversation } from "../support/store";
import { type RouteContext, verifiedPerson } from "./context";
import { conversationId, conversationViewResponse } from "./support-replies";

const PREFIX = "/api/support/conversations/";
const SIGN_IN = "Sign in to change support conversations";
const ACTIONS = new Set([
  "move",
  "owner",
  "close",
  "reopen",
  "not-spam",
  "issue/approve",
  "issue/dismiss",
]);

const json = (status: number, error: string) =>
  Response.json({ error }, { status });

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

export async function handleSupportActionRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (req.method !== "POST" || !path.startsWith(PREFIX)) return undefined;
  const rest = path.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const action = rest.slice(slash + 1);
  if (!ACTIONS.has(action)) return undefined;

  const person = verifiedPerson(ctx);
  if (!person) return json(401, SIGN_IN);
  let ref: string;
  try {
    ref = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return json(400, "Invalid path");
  }
  const id = conversationId(ref);
  if (!(await getConversation(id))) return json(404, "Conversation not found");
  const actor = actorFor(person, true, ctx.authUser?.login);
  const by: SupportActor = {
    kind: "person",
    name: person,
    ...(ctx.authUser?.login ? { login: ctx.authUser.login } : {}),
  };
  const body = await readBody(req);

  switch (action) {
    case "move": {
      const result = await moveConversation(
        id,
        text(body.project),
        by,
        text(body.reason),
      );
      if (!result.ok) return json(400, result.error);
      break;
    }
    case "owner": {
      const result = await setOwner(id, text(body.owner), person);
      if (!result.ok) return json(400, result.error ?? "Choose a person");
      break;
    }
    case "close":
      if (!(await closeConversation(id, by)).ok)
        return json(409, "Only an open conversation can be closed");
      break;
    case "reopen":
      if (!(await reopenConversation(id, by)).ok)
        return json(409, "Only a closed conversation can be reopened");
      break;
    case "not-spam":
      if (!(await markNotSpam(id, person)).ok)
        return json(409, "This conversation isn't spam");
      break;
    case "issue/approve": {
      const expected = body.expectedRevision;
      if (typeof expected !== "number" || !Number.isInteger(expected))
        return json(400, "Say which revision of the issue you approve");
      const result = await approvePendingIssue(id, actor, expected);
      if (!result.ok) return json(result.status, result.error);
      break;
    }
    case "issue/dismiss":
      if (!(await dismissPendingIssue(id, actor)).ok)
        return json(409, "No issue is waiting for approval");
      break;
  }
  return conversationViewResponse(id);
}
