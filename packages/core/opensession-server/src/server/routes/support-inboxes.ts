// /api/support/inboxes*: the Inboxes settings page (list, connect, edit,
// remove, test a connection) and /api/support/customers/forget. Signed-in
// people only (`verifiedPerson`); the actor for the inbox store's
// permission checks is built with `actorFor()`, so only the instance owner
// may let Sessions send right away, allow internal mail servers, remove an
// inbox or forget a customer. Responses never carry a password or a
// secret ref: inboxes leave as `inboxView()`.
//
// Reuses the sandbox connections' test-and-save flow (routes/sandboxes.ts):
// a test logs in once with what the form holds, or with the saved inbox's
// stored passwords. Tests are limited so the page can't hammer a provider:
// one at a time per inbox address, six a minute per person.
import { getProjectDocument } from "../projects/store";
import { configuredRepos } from "../config";
import { activeIntegrations } from "../integrations/load";
import type {
  InboxConfig,
  InboxHealth,
  InboxPatch,
  InboxProjectOption,
  InboxTestBody,
  InboxView,
  InboxesResponse,
  MailServerConfig,
} from "../../shared/support";
import {
  type Actor,
  ForbiddenError,
  actorFor,
  isOwnerActor,
} from "../support/actor";
import { channelAdapterFor } from "../support/channel";
import {
  type NewInbox,
  createInbox,
  deleteInbox,
  getInbox,
  inboxPassword,
  inboxView,
  listInboxes,
  updateInbox,
} from "../support/inboxes";
import { forgetCustomer } from "../support/retention";
import { testImapLogin } from "../../agents/email/imap-transport";
import { testSmtpLogin } from "../../agents/email/smtp-transport";
import { type RouteContext, verifiedPerson } from "./context";

const PREFIX = "/api/support/inboxes";
const FORGET_PATH = "/api/support/customers/forget";

type Which = "imap" | "smtp";
type ServerInput = NonNullable<InboxTestBody["imap"]>;

const json = (status: number, error: string) =>
  Response.json({ error }, { status });

// ── Seams ───────────────────────────────────────────────────────────────

let enabledOverride: boolean | undefined;

/** Pretend the email integration is (or isn't) on; undefined restores. */
export function __setEmailSupportEnabledForTest(
  enabled: boolean | undefined,
): void {
  enabledOverride = enabled;
}

function emailSupportEnabled(): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  try {
    return activeIntegrations().some((spec) => spec.id === "email");
  } catch {
    return false;
  }
}

// ── Test limits ─────────────────────────────────────────────────────────

const TESTS_PER_MINUTE = 6;
const MINUTE_MS = 60_000;
const testsByPerson = new Map<string, number[]>();
const testsRunning = new Set<string>();

export function __resetInboxTestLimitsForTest(): void {
  testsByPerson.clear();
  testsRunning.clear();
}

/** Counts a test for `person`; false when they are over the limit. */
function takeTestSlot(person: string, now: number): boolean {
  const key = person.toLowerCase();
  const recent = (testsByPerson.get(key) ?? []).filter(
    (at) => now - at < MINUTE_MS,
  );
  if (recent.length >= TESTS_PER_MINUTE) {
    testsByPerson.set(key, recent);
    return false;
  }
  recent.push(now);
  testsByPerson.set(key, recent);
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const OFF_HEALTH = (since: string): InboxHealth => ({
  state: "off",
  since,
  reason: null,
  retryAt: null,
  lastMessageAt: null,
});

function viewOf(inbox: InboxConfig): InboxView {
  const health =
    channelAdapterFor(inbox.id)?.health() ?? OFF_HEALTH(inbox.updatedAt);
  return inboxView(inbox, health);
}

async function supportConnectors(project: string): Promise<boolean> {
  try {
    const doc = await getProjectDocument(project);
    return doc.access.connections.some((row) => row.roles.includes("support"));
  } catch {
    return false;
  }
}

async function projectOptions(): Promise<InboxProjectOption[]> {
  let ids: string[];
  try {
    ids = Object.keys(configuredRepos()).sort();
  } catch {
    ids = [];
  }
  return Promise.all(
    ids.map(async (id) => ({
      id,
      supportConnectors: await supportConnectors(id),
    })),
  );
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const SERVER_NAMES: Record<Which, string> = { imap: "IMAP", smtp: "SMTP" };

const sameServer = (a: Omit<MailServerConfig, "passwordRef">, b: ServerInput) =>
  a.host === b.host &&
  a.port === b.port &&
  a.tls === b.tls &&
  a.user === b.user;

function serverFields(
  input: ServerInput,
): Omit<MailServerConfig, "passwordRef"> {
  return {
    host: typeof input.host === "string" ? input.host.trim() : input.host,
    port: input.port,
    tls: input.tls,
    user: typeof input.user === "string" ? input.user.trim() : input.user,
  };
}

/** What one test logs in with: the server as typed (else saved) and the
 *  typed password, else the stored one, but only for the server it was
 *  entered for. */
async function testTarget(
  which: Which,
  input: ServerInput | undefined,
  saved: InboxConfig | null,
): Promise<
  | {
      ok: true;
      server: Omit<MailServerConfig, "passwordRef">;
      password: string;
    }
  | { ok: false; error: string }
> {
  const name = SERVER_NAMES[which];
  if (input !== undefined && !isObject(input))
    return { ok: false, error: `${name} settings are missing` };
  if (!input && !saved)
    return { ok: false, error: `${name} settings are missing` };
  const server = input ? serverFields(input) : saved![which];
  const typed = typeof input?.password === "string" ? input.password : "";
  if (typed) return { ok: true, server, password: typed };
  if (!saved) return { ok: false, error: `${name} password is required` };
  if (input && !sameServer(saved[which], server))
    return {
      ok: false,
      error: `Enter the ${name} password to test a changed server`,
    };
  const stored = await inboxPassword(saved, which);
  if (!stored) return { ok: false, error: `${name} password is required` };
  return { ok: true, server: saved[which], password: stored };
}

function validServer(server: Omit<MailServerConfig, "passwordRef">): boolean {
  return (
    typeof server.host === "string" &&
    !!server.host &&
    Number.isInteger(server.port) &&
    server.port >= 1 &&
    server.port <= 65_535 &&
    (server.tls === "implicit" ||
      server.tls === "starttls" ||
      server.tls === "none") &&
    typeof server.user === "string"
  );
}

const OWNER_INTERNAL =
  "Only the instance owner can allow internal mail servers";

async function runTest(actor: Actor, raw: unknown): Promise<Response> {
  if (!isObject(raw)) return json(400, "Test settings are missing");
  const body = raw as InboxTestBody;
  let saved: InboxConfig | null = null;
  if (body.inboxId !== undefined) {
    saved =
      typeof body.inboxId === "string" ? await getInbox(body.inboxId) : null;
    if (!saved) return json(404, "That inbox doesn't exist");
  }
  let allowInternalHost = saved?.allowInternalHost ?? false;
  if (body.allowInternalHost === true && !allowInternalHost) {
    if (!isOwnerActor(actor)) return json(403, OWNER_INTERNAL);
    allowInternalHost = true;
  }
  const imap = await testTarget("imap", body.imap, saved);
  if (!imap.ok) return json(400, imap.error);
  const smtp = await testTarget("smtp", body.smtp, saved);
  if (!smtp.ok) return json(400, smtp.error);
  for (const [which, target] of [
    ["imap", imap],
    ["smtp", smtp],
  ] as const)
    if (!validServer(target.server))
      return json(400, `${SERVER_NAMES[which]} settings are incomplete`);

  const address = (
    saved?.address ??
    (typeof body.address === "string" && body.address.trim()
      ? body.address
      : `${imap.server.user}@${imap.server.host}`)
  )
    .trim()
    .toLowerCase();
  if (testsRunning.has(address))
    return json(429, "A test for this inbox is already running");
  testsRunning.add(address);
  try {
    const policy = { allowInternalHost };
    const [imapResult, smtpResult] = await Promise.all([
      testImapLogin(imap.server, imap.password, policy),
      testSmtpLogin(smtp.server, smtp.password, policy, address),
    ]);
    return Response.json({ imap: imapResult, smtp: smtpResult });
  } finally {
    testsRunning.delete(address);
  }
}

async function forget(actor: Actor, raw: unknown): Promise<Response> {
  const email = isObject(raw) && typeof raw.email === "string" ? raw.email : "";
  if (!isOwnerActor(actor))
    return json(403, "Only the instance owner can forget a customer");
  if (!/^[^\s@]+@[^\s@]+$/.test(email.trim()))
    return json(400, "Enter the customer's email address");
  try {
    return Response.json(await forgetCustomer(email, actor));
  } catch (error) {
    if (error instanceof ForbiddenError) return json(403, error.message);
    console.warn(
      "[support] forget failed:",
      error instanceof Error ? error.name : "error",
    );
    return json(500, "Couldn't forget this customer. Try again");
  }
}

// ── Handler ─────────────────────────────────────────────────────────────

export async function handleSupportInboxRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  const forgetting = path === FORGET_PATH;
  if (!forgetting && path !== PREFIX && !path.startsWith(`${PREFIX}/`))
    return undefined;
  const rest = forgetting
    ? []
    : path
        .slice(PREFIX.length + 1)
        .split("/")
        .filter(Boolean);
  if (rest.length > 1) return undefined;

  const person = verifiedPerson(ctx);
  if (!person) return json(401, "Sign in to change support inboxes");
  const actor = actorFor(person, true);

  if (forgetting) {
    if (req.method !== "POST") return undefined;
    return forget(actor, await readBody(req));
  }

  if (rest.length === 0) {
    if (req.method === "GET") {
      const [inboxes, projects] = await Promise.all([
        listInboxes(),
        projectOptions(),
      ]);
      const response: InboxesResponse = {
        enabled: emailSupportEnabled(),
        isInstanceOwner: isOwnerActor(actor),
        projects,
        inboxes: inboxes.map(viewOf),
      };
      return Response.json(response);
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!isObject(body)) return json(400, "Inbox settings are missing");
      const result = await createInbox(body as unknown as NewInbox, actor);
      if (!result.ok) return json(result.status, result.error);
      return Response.json({ inbox: viewOf(result.inbox) });
    }
    return undefined;
  }

  if (rest[0] === "test") {
    if (req.method !== "POST") return undefined;
    if (!takeTestSlot(person, Date.now()))
      return json(
        429,
        "Too many connection tests. Wait a minute and try again",
      );
    return runTest(actor, await readBody(req));
  }

  const id = segment(rest[0]!);
  if (id === null) return json(400, "Invalid path");
  if (req.method === "PATCH") {
    const body = await readBody(req);
    if (!isObject(body) || typeof body.expectedRevision !== "number")
      return json(400, "Send the inbox's revision as expectedRevision");
    const result = await updateInbox(id, body as unknown as InboxPatch, actor);
    if (!result.ok) return json(result.status, result.error);
    return Response.json({ inbox: viewOf(result.inbox) });
  }
  if (req.method === "DELETE") {
    const result = await deleteInbox(id, actor);
    if (!result.ok) return json(result.status, result.error);
    return Response.json({ ok: true });
  }
  return undefined;
}
