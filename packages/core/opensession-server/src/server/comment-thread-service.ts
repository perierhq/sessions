/**
 * Everything that happens around a comment-thread mutation: the store write
 * (comment-threads.ts), the live frame to the people watching the session,
 * @-mentions, inbox notifications for the thread's participants, the
 * assignee's Desk todo (or, for Blob, the assigner's supervisor), and the
 * agent's side answer when someone asks for it.
 *
 * Routes, the agent's own MCP tools and the side answer all go through here,
 * so no surface can write a thread and forget to tell anyone.
 */

import {
  applyAddComment,
  applyCreateThread,
  applyDeleteComment,
  applyEditComment,
  applyUpdateThread,
  mutateThreads,
  sameUser,
  threadParticipants,
  type CommentThread,
  type TextAnchor,
  type ThreadComment,
  type ThreadFailure,
  type ThreadPatch,
} from "./comment-threads";
import { personaName } from "./config";
import { mentionPreview, notifyMentions, runBlobRoute } from "./mentions";
import { mentionedUsers } from "./people";
import { notifyUser, sessionSubject } from "./notifications";
import { BLOB_ACTOR, isBlobActor } from "./session-actors";
import { findSessionAsync } from "./session-cache";
import { removeStagedImages } from "./uploads";
import { broadcastToAll, broadcastToSession } from "./ws-hub";

export type ServiceResult =
  | { ok: true; thread: CommentThread }
  | { ok: false; reason: ThreadFailure };

/** The in-app link that opens a session with one thread focused. */
export function threadUrl(sessionId: string, threadId: string): string {
  return `/session/${encodeURIComponent(sessionId)}?thread=${encodeURIComponent(threadId)}`;
}

/** What the agent is called in a thread. */
export function agentName(): string {
  return personaName();
}

/**
 * Whether a comment asks the agent to answer: `@agent`, or the agent's own
 * name. The persona's first word is what the mention picker inserts.
 */
export function mentionsAgent(text: string): boolean {
  if (/(^|[^\w@])@agent\b/i.test(text)) return true;
  const first = agentName().split(/\s+/)[0];
  if (!first || !/^[A-Za-z][\w.-]*$/.test(first)) return false;
  return new RegExp(`(^|[^\\w@])@${first}\\b`, "i").test(text);
}

/**
 * Whether a new comment keeps a conversation with the agent going: the reply
 * comes straight after an agent answer and tags nobody else. Someone answering
 * the agent expects it to answer back, the way a person would.
 */
export function continuesAgentConversation(
  thread: CommentThread,
  added: ThreadComment,
): boolean {
  if (added.agent) return false;
  const index = thread.comments.findIndex((c) => c.id === added.id);
  const previous = index > 0 ? thread.comments[index - 1] : undefined;
  // Blob answers in threads too (supervisor reply_in_thread); a reply to
  // Blob is not a conversation with the session's agent.
  if (!previous?.agent || isBlobActor(previous.user)) return false;
  return mentionedUsers(added.text, added.user).length === 0;
}

function emit(thread: CommentThread): void {
  broadcastToSession(thread.sessionId, {
    type: "comment_thread",
    sessionId: thread.sessionId,
    thread,
  });
  // Clients that still read session notes (an older native build) see the
  // opening comment of a session-level thread as the note it used to be.
  if (!thread.anchor) {
    const root = thread.comments[0]!;
    broadcastToAll({
      type: "session_note",
      sessionId: thread.sessionId,
      note: {
        id: thread.id,
        user: root.user,
        text: root.text,
        ...(root.images ? { images: root.images } : {}),
        ts: root.ts,
        ...(root.editedAt ? { editedAt: root.editedAt } : {}),
      },
    });
  }
}

function emitDeleted(sessionId: string, threadId: string, anchored: boolean) {
  broadcastToSession(sessionId, {
    type: "comment_thread_deleted",
    sessionId,
    threadId,
  });
  if (!anchored)
    broadcastToAll({
      type: "session_note_deleted",
      sessionId,
      noteId: threadId,
    });
}

/** Lazy, so importing the service never drags the agent runner in. */
async function startAgentAnswer(
  thread: CommentThread,
  requestedBy: string,
): Promise<void> {
  const { answerThreadInBackground } = await import("./comment-thread-agent");
  answerThreadInBackground(thread.sessionId, thread.id, requestedBy);
}

async function notifyParticipants(
  thread: CommentThread,
  actor: string,
  reason: string,
  body: string,
  exclude: string[],
): Promise<void> {
  const people = threadParticipants(thread, [actor, BLOB_ACTOR, ...exclude]);
  if (!people.length) return;
  const session = await findSessionAsync(thread.sessionId).catch(
    () => undefined,
  );
  for (const person of people)
    void notifyUser(person, {
      kind: "comment",
      subject: sessionSubject(thread.sessionId, session),
      reason,
      body: mentionPreview(body),
      actor,
      url: threadUrl(thread.sessionId, thread.id),
    });
}

// ── Desk todo for the assignee ──────────────────────────────────────────────

type Todos = typeof import("./todos");
async function todos(): Promise<Todos> {
  return import("./todos");
}

/** Put the thread on the assignee's Desk; returns the todo id. */
async function addAssigneeTodo(
  thread: CommentThread,
  assignee: string,
  by: string,
): Promise<string | null> {
  try {
    const { addTodo } = await todos();
    const session = await findSessionAsync(thread.sessionId).catch(
      () => undefined,
    );
    const root = thread.comments[0]!;
    const item = addTodo({
      user: assignee,
      text: `Reply to ${root.user}'s comment: ${mentionPreview(root.text.replace(/\s+/g, " "))}`,
      note: `${session?.title || "Session"} ${threadUrl(thread.sessionId, thread.id)}`,
      source: { kind: "session", sessionId: thread.sessionId, by },
    });
    return item.id;
  } catch (error) {
    console.warn(
      "[comment-threads] could not add the assignee's todo:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function setTodoStatus(
  todoId: string | undefined,
  status: "open" | "done" | "dropped",
  by: string,
): Promise<void> {
  if (!todoId) return;
  try {
    const { getTodo, updateTodo } = await todos();
    const item = getTodo(todoId);
    if (item && item.status !== status) updateTodo(todoId, { status }, by);
  } catch (error) {
    console.warn(
      "[comment-threads] could not update the assignee's todo:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function assign(
  thread: CommentThread,
  assignee: string,
  by: string,
  verified = false,
): Promise<CommentThread> {
  // Blob has no Desk: the assignment goes to the assigner's supervisor,
  // which works it and answers in the thread (blob-mentions.ts).
  if (isBlobActor(assignee)) {
    if (thread.status === "open") routeAssignmentToBlob(thread, by, verified);
    return thread;
  }
  const todoId =
    thread.status === "open"
      ? await addAssigneeTodo(thread, assignee, by)
      : null;
  let current = thread;
  if (todoId) {
    const stored = await mutateThreads(thread.sessionId, (threads) =>
      applyUpdateThread(threads, thread.id, { assigneeTodoId: todoId }, by),
    );
    if (stored.ok) current = stored.thread;
  }
  if (!sameUser(assignee, by)) {
    const session = await findSessionAsync(thread.sessionId).catch(
      () => undefined,
    );
    void notifyUser(assignee, {
      kind: "comment",
      subject: sessionSubject(thread.sessionId, session),
      reason: `${by} assigned you a comment`,
      body: mentionPreview(thread.comments[0]!.text),
      actor: by,
      url: threadUrl(thread.sessionId, thread.id),
    });
  }
  return current;
}

// ── Assigning Blob ──────────────────────────────────────────────────────────────

/** "Ada assigned you <thread>" to the assigner's supervisor, in the
 *  background; only when the route verified the assigner is the signed-in
 *  person (blob-mentions.ts routeBlobAssignment). */
function routeAssignmentToBlob(
  thread: CommentThread,
  by: string,
  verified: boolean,
): void {
  void runBlobRoute("Blob assignment", async () => {
    const { routeBlobAssignment } = await import("./blob-mentions");
    await routeBlobAssignment({
      sessionId: thread.sessionId,
      threadId: thread.id,
      assigner: by,
      ...(verified ? { verifiedAssigner: by } : {}),
      assignedAt: thread.updatedAt,
      text: thread.comments[0]!.text,
      url: threadUrl(thread.sessionId, thread.id),
    });
  });
}

/** Blob was taken off the thread: its routing record allows no more
 *  replies there until it is assigned or mentioned again. Awaited, so a
 *  quick reassignment to Blob routes after the close, never before it. */
async function unassignBlob(previous: CommentThread): Promise<void> {
  const owner = previous.assignedBy;
  if (!owner) return;
  try {
    const { closeRoutedThread } = await import("./blob-mentions");
    await closeRoutedThread(owner, previous.sessionId, previous.id);
  } catch (error) {
    console.warn(
      "[comment-threads] could not record Blob's unassignment:",
      error instanceof Error ? error.message : error,
    );
  }
}

// ── Mutations ───────────────────────────────────────────────────────────────

export async function createThread(input: {
  sessionId: string;
  user: string;
  text: string;
  images?: string[];
  anchor?: TextAnchor | null;
  assignee?: string | null;
  /** `user` is the signed-in person, verified by the route
   *  (routes/context.ts verifiedPerson): only then does @Blob route. */
  verified?: boolean;
}): Promise<ServiceResult> {
  const result = await mutateThreads(input.sessionId, (threads) =>
    applyCreateThread(threads, input),
  );
  if (!result.ok) return result;
  let thread = result.thread;
  if (thread.assignee)
    thread = await assign(
      thread,
      thread.assignee,
      input.user,
      !!input.verified,
    );
  emit(thread);
  const url = threadUrl(thread.sessionId, thread.id);
  await notifyMentions(
    thread.comments[0]!.text,
    input.user,
    thread.sessionId,
    thread.anchor ? "comment" : "note",
    url,
    {
      threadId: thread.id,
      ref: thread.comments[0]!.id,
      ...(input.verified ? { verifiedSender: input.user } : {}),
    },
  );
  if (mentionsAgent(thread.comments[0]!.text))
    await startAgentAnswer(thread, input.user);
  return { ok: true, thread };
}

export async function addComment(
  sessionId: string,
  threadId: string,
  input: {
    user: string;
    text: string;
    images?: string[];
    agent?: boolean;
    /** As createThread's `verified`; never with `agent`. */
    verified?: boolean;
  },
): Promise<ServiceResult & { added?: ThreadComment }> {
  const result = await mutateThreads(sessionId, (threads) =>
    applyAddComment(threads, threadId, input),
  );
  if (!result.ok) return result;
  const { added, ...thread } = result.thread;
  emit(thread);
  const url = threadUrl(sessionId, threadId);
  const mentioned = await notifyMentions(
    added.text,
    input.user,
    sessionId,
    "comment",
    url,
    {
      threadId,
      ref: added.id,
      ...(input.verified && !input.agent ? { verifiedSender: input.user } : {}),
    },
  );
  await notifyParticipants(
    thread,
    input.user,
    input.agent
      ? `${input.user} answered in a comment`
      : `${input.user} replied to a comment`,
    added.text,
    mentioned,
  );
  if (
    !input.agent &&
    (mentionsAgent(added.text) || continuesAgentConversation(thread, added))
  )
    await startAgentAnswer(thread, input.user);
  return { ok: true, thread, added };
}

export async function editComment(
  sessionId: string,
  threadId: string,
  commentId: string,
  text: string,
  user: string,
): Promise<ServiceResult> {
  const result = await mutateThreads(sessionId, (threads) =>
    applyEditComment(threads, threadId, commentId, text, user),
  );
  if (!result.ok) return result;
  emit(result.thread);
  return { ok: true, thread: result.thread };
}

export async function deleteComment(
  sessionId: string,
  threadId: string,
  commentId: string,
  user: string,
): Promise<
  | { ok: true; thread: CommentThread | null }
  | { ok: false; reason: ThreadFailure }
> {
  let anchored = false;
  let todoId: string | undefined;
  const result = await mutateThreads(sessionId, (threads) => {
    const before = threads.find((t) => t.id === threadId);
    anchored = !!before?.anchor;
    todoId = before?.assigneeTodoId;
    return applyDeleteComment(threads, threadId, commentId, user);
  });
  if (!result.ok) return result;
  for (const comment of result.removed) removeStagedImages(comment.images);
  if (result.thread) emit(result.thread);
  else {
    emitDeleted(sessionId, threadId, anchored);
    await setTodoStatus(todoId, "dropped", user);
  }
  return { ok: true, thread: result.thread };
}

/** Resolve, reopen, assign or unassign. `verified`: `user` is the
 *  signed-in person, verified by the route (as createThread's); only then
 *  does assigning Blob reach Blob. */
export async function updateThread(
  sessionId: string,
  threadId: string,
  patch: Pick<ThreadPatch, "status" | "assignee" | "agentPending">,
  user: string,
  options: { verified?: boolean } = {},
): Promise<ServiceResult> {
  let before: CommentThread | undefined;
  const result = await mutateThreads(sessionId, (threads) => {
    before = threads.find((t) => t.id === threadId);
    return applyUpdateThread(threads, threadId, patch, user);
  });
  if (!result.ok) return result;
  let thread = result.thread;
  const previous = before!;

  const assigneeChanged =
    patch.assignee !== undefined &&
    !sameUser(previous.assignee ?? "", thread.assignee ?? "");
  if (assigneeChanged) {
    await setTodoStatus(previous.assigneeTodoId, "dropped", user);
    const cleared = await mutateThreads(sessionId, (threads) =>
      applyUpdateThread(threads, threadId, { assigneeTodoId: null }, user),
    );
    if (cleared.ok) thread = cleared.thread;
    if (isBlobActor(previous.assignee)) await unassignBlob(previous);
    if (thread.assignee)
      thread = await assign(thread, thread.assignee, user, !!options.verified);
  } else if (patch.status && patch.status !== previous.status) {
    await setTodoStatus(
      thread.assigneeTodoId,
      patch.status === "resolved" ? "done" : "open",
      user,
    );
  }

  emit(thread);
  if (patch.status && patch.status !== previous.status) {
    const root = thread.comments[0]!;
    if (patch.status === "resolved" && !sameUser(thread.createdBy, user)) {
      const session = await findSessionAsync(sessionId).catch(() => undefined);
      void notifyUser(thread.createdBy, {
        kind: "comment",
        subject: sessionSubject(sessionId, session),
        reason: `${user} resolved your comment`,
        body: mentionPreview(root.text),
        actor: user,
        url: threadUrl(sessionId, threadId),
      });
    }
  }
  return { ok: true, thread };
}

/** Pending marker for the agent's side answer; broadcasts, never notifies. */
export async function setAgentPending(
  sessionId: string,
  threadId: string,
  pending: boolean,
): Promise<CommentThread | null> {
  const result = await mutateThreads(sessionId, (threads) =>
    applyUpdateThread(
      threads,
      threadId,
      { agentPending: pending },
      agentName(),
    ),
  );
  if (!result.ok) return null;
  emit(result.thread);
  return result.thread;
}
