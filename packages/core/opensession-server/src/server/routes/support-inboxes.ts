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
// stored passwords. Typed servers are checked with the store's own rules
// (serverError, passwordError, ADDRESS) before anything is dialled. Tests
// are limited so the page can't hammer a provider or map a network: one at
// a time per person and server, six a minute per person; a teammate who
// isn't the instance owner may only test the usual mail ports, never move
// an inbox that allows internal servers, and sees one message for every
// failure before the server answered.
//
// Creates, updates and removals are audited (support_inbox_*: the inbox id,
// who, and the names of the fields a change named; never a value). A store
// or secret failure answers 500 with a generic message and logs the error's
// code or name only.
import { getProjectDocument } from "../projects/store";
import { configuredRepos } from "../config";
import { activeIntegrations } from "../integrations/load";
import type {
  InboxConfig,
  InboxHealth,
  InboxPatch,
  InboxProjectOption,
  InboxTestBody,
  InboxTestResult,
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
import { supportAudit } from "../support/audit-sink";
import {
  type SupportChannelAdapter,
  channelAdapterFor,
} from "../support/channel";
import {
  ADDRESS,
  type NewInbox,
  createInbox,
  deleteInbox,
  getInbox,
  inboxPassword,
  inboxView,
  listInboxes,
  passwordError,
  serverError,
  updateInbox,
} from "../support/inboxes";
import { forgetCustomer } from "../support/retention";
import { testImapLogin } from "../../agents/email/imap-transport";
import {
  SMTP_SEND_AS_REFUSED,
  testSmtpLogin,
} from "../../agents/email/smtp-transport";
import { type RouteContext, verifiedPerson } from "./context";

const PREFIX = "/api/support/inboxes";
const FORGET_PATH = "/api/support/customers/forget";

type Which = "imap" | "smtp";
type ServerInput = NonNullable<InboxTestBody["imap"]>;
type Server = Omit<MailServerConfig, "passwordRef">;

const SERVERS: Which[] = ["imap", "smtp"];

const json = (status: number, error: string) =>
  Response.json({ error }, { status });

/** A store or secret call that threw: 500 with `message`, and a log line
 *  with the error's code or name only (a parse error's message can quote
 *  the secrets file). */
function failed(action: string, error: unknown, message: string): Response {
  const e = error as { code?: unknown; name?: unknown } | null;
  console.warn(
    `[support] inbox ${action} failed:`,
    String(e?.code ?? e?.name ?? "error"),
  );
  return json(500, message);
}

const SAVE_FAILED = "Couldn't save the inbox. Try again";

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
/** `person \n host:port` of every server a test is dialling now. */
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

/** The ports a teammate who isn't the instance owner may test: IMAP 143
 *  and 993, SMTP 25, 465, 587 and 2525. Anything else could be used to
 *  probe other services. */
const USUAL_MAIL_PORTS = [143, 993, 25, 465, 587, 2525];

/** What a teammate sees for any failure before the server answered: the
 *  difference between refused, closed, unreachable and not TLS would map
 *  the network. */
export const TEST_CONNECT_FAILED = "Couldn't connect to this mail server";

/** IMAP failures that only a mail server that greeted can give. */
const IMAP_ANSWERED = new Set([
  "auth",
  "throttled",
  "too-many-connections",
  "alert",
]);
/** SMTP failures that only a mail server that greeted can give. */
const SMTP_ANSWERED =
  /^The mail server (refused the login|refused the message|deferred the message)/;

function forTeammate(result: InboxTestResult): InboxTestResult {
  const imap: InboxTestResult["imap"] =
    result.imap.ok || IMAP_ANSWERED.has(result.imap.kind)
      ? result.imap
      : { ok: false, kind: "network", error: TEST_CONNECT_FAILED };
  const smtp: InboxTestResult["smtp"] =
    result.smtp.ok ||
    result.smtp.error === SMTP_SEND_AS_REFUSED ||
    SMTP_ANSWERED.test(result.smtp.error)
      ? result.smtp
      : { ok: false, permanent: false, error: TEST_CONNECT_FAILED };
  return { imap, smtp };
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

/** Whether the project's Support role reaches outside: a connector, web
 *  search or a website (the form warns before a send level then). */
async function supportReachesOut(project: string): Promise<boolean> {
  try {
    const { access } = await getProjectDocument(project);
    return (
      access.connections.some((row) => row.roles.includes("support")) ||
      access.websites.some((row) => row.roles.includes("support")) ||
      access.webSearch.includes("support")
    );
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
      supportConnectors: await supportReachesOut(id),
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

/** As the store cleans a host: trimmed, without a trailing dot. */
const cleanHost = (host: unknown) =>
  typeof host === "string" ? host.trim().replace(/\.+$/, "") : host;

function serverFields(input: ServerInput): Server {
  return {
    host: cleanHost(input.host) as string,
    port: input.port,
    tls: input.tls,
    user: typeof input.user === "string" ? input.user.trim() : input.user,
  };
}

const savedServer = ({ passwordRef: _ref, ...server }: MailServerConfig) =>
  server;

const sameServer = (a: Server, b: Server) =>
  a.host === b.host &&
  a.port === b.port &&
  a.tls === b.tls &&
  a.user === b.user;

const samePlace = (a: Server, b: Server) =>
  a.host === b.host && a.port === b.port;

const OWNER_INTERNAL =
  "Only the instance owner can allow internal mail servers";
const OWNER_INTERNAL_SERVERS =
  "Only the instance owner can change the mail servers of an inbox that allows internal servers";

/** One server to test: as typed, else as saved. */
type Planned = { which: Which; server: Server; typed: string; saved: boolean };

/** The servers a test would dial, or the refusal. Nothing is dialled and
 *  no password is read here. */
function planTest(
  actor: Actor,
  body: InboxTestBody,
  saved: InboxConfig | null,
  allowInternalHost: boolean,
): Planned[] | Response {
  const owner = isOwnerActor(actor);
  const plans: Planned[] = [];
  for (const which of SERVERS) {
    const name = SERVER_NAMES[which];
    const input = body[which];
    if (input !== undefined && !isObject(input))
      return json(400, `${name} settings are missing`);
    if (!input && !saved) return json(400, `${name} settings are missing`);
    const server = input ? serverFields(input) : savedServer(saved![which]);
    const moved = !saved || !samePlace(savedServer(saved[which]), server);
    // An inbox allowed to reach internal servers is only pointed somewhere
    // else by the owner, or its test would reach the private network.
    if (saved?.allowInternalHost && !owner && moved)
      return json(403, OWNER_INTERNAL_SERVERS);
    const invalid = serverError(server, which, allowInternalHost);
    if (invalid) return json(400, invalid);
    if (!owner && moved && !USUAL_MAIL_PORTS.includes(server.port))
      return json(
        400,
        `${name} port must be a usual mail port: 143, 993, 25, 465, 587 or 2525`,
      );
    const typed = input?.password;
    if (typed !== undefined && typed !== "") {
      const bad = passwordError(typed, which);
      if (bad) return json(400, bad);
    }
    plans.push({
      which,
      server,
      typed: typeof typed === "string" ? typed : "",
      saved: !!saved && sameServer(savedServer(saved[which]), server),
    });
  }
  return plans;
}

/** The password one planned server logs in with: the typed one, else the
 *  stored one, but only for the server it was entered for. */
async function passwordFor(
  plan: Planned,
  saved: InboxConfig | null,
  input: ServerInput | undefined,
): Promise<{ ok: true; password: string } | { ok: false; error: string }> {
  const name = SERVER_NAMES[plan.which];
  if (plan.typed) return { ok: true, password: plan.typed };
  if (!saved) return { ok: false, error: `${name} password is required` };
  if (input && !plan.saved)
    return {
      ok: false,
      error: `Enter the ${name} password to test a changed server`,
    };
  const stored = await inboxPassword(saved, plan.which);
  if (!stored) return { ok: false, error: `${name} password is required` };
  return { ok: true, password: stored };
}

/** An adapter that can connect a paused inbox again (optional). */
type Resumable = SupportChannelAdapter & {
  resume?: () => Promise<void> | void;
};

/** A saved inbox paused (a refused login, an unreachable server) whose
 *  test just passed with what is stored connects again. The adapter's
 *  `resume()` is optional: until the email adapter has one this is a
 *  no-op, and the inbox resumes on its next save. */
function resumeAfterTest(inboxId: string): void {
  const adapter: Resumable | undefined = channelAdapterFor(inboxId);
  const resume = adapter?.resume?.bind(adapter);
  if (!adapter || !resume || adapter.health().state !== "paused") return;
  void Promise.resolve()
    .then(resume)
    .catch((error: unknown) => {
      const e = error as { code?: unknown; name?: unknown } | null;
      console.warn(
        "[support] inbox resume failed:",
        String(e?.code ?? e?.name ?? "error"),
      );
    });
}

async function runTest(
  actor: Actor,
  person: string,
  raw: unknown,
): Promise<Response> {
  if (!isObject(raw)) return json(400, "Test settings are missing");
  const body = raw as InboxTestBody;
  const owner = isOwnerActor(actor);
  let saved: InboxConfig | null = null;
  if (body.inboxId !== undefined) {
    try {
      saved =
        typeof body.inboxId === "string" ? await getInbox(body.inboxId) : null;
    } catch (error) {
      return failed("test", error, "Couldn't test the connection. Try again");
    }
    if (!saved) return json(404, "That inbox doesn't exist");
  }
  let allowInternalHost = saved?.allowInternalHost ?? false;
  if (body.allowInternalHost === true && !allowInternalHost) {
    if (!owner) return json(403, OWNER_INTERNAL);
    allowInternalHost = true;
  }
  let address: string;
  if (saved) address = saved.address;
  else if (body.address === undefined || body.address === "") address = "";
  else if (
    typeof body.address === "string" &&
    ADDRESS.test(body.address.trim())
  )
    address = body.address.trim().toLowerCase();
  else
    return json(400, "Address must be an email address like help@example.test");

  const plans = planTest(actor, body, saved, allowInternalHost);
  if (plans instanceof Response) return plans;
  const passwords: string[] = [];
  for (const plan of plans) {
    let result: Awaited<ReturnType<typeof passwordFor>>;
    try {
      result = await passwordFor(plan, saved, body[plan.which]);
    } catch (error) {
      return failed("test", error, "Couldn't test the connection. Try again");
    }
    if (!result.ok) return json(400, result.error);
    passwords.push(result.password);
  }
  const [imap, smtp] = plans as [Planned, Planned];

  const keys = plans.map(
    ({ server }) =>
      `${person.toLowerCase()}\n${server.host.toLowerCase()}:${server.port}`,
  );
  if (keys.some((key) => testsRunning.has(key)))
    return json(429, "A test of this mail server is already running");
  for (const key of keys) testsRunning.add(key);
  try {
    const policy = { allowInternalHost };
    const [imapResult, smtpResult] = await Promise.all([
      testImapLogin(imap.server, passwords[0]!, policy),
      testSmtpLogin(
        smtp.server,
        passwords[1]!,
        policy,
        address || `${imap.server.user}@${imap.server.host}`,
      ),
    ]);
    const result: InboxTestResult = { imap: imapResult, smtp: smtpResult };
    if (
      saved &&
      imap.saved &&
      smtp.saved &&
      !imap.typed &&
      !smtp.typed &&
      imapResult.ok &&
      smtpResult.ok
    )
      resumeAfterTest(saved.id);
    return Response.json(owner ? result : forTeammate(result));
  } finally {
    for (const key of keys) testsRunning.delete(key);
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

// ── Audit ───────────────────────────────────────────────────────────────

/** Fields an update may name, in the order the audit lists them. */
const AUDITED_FIELDS = [
  "label",
  "address",
  "enabled",
  "project",
  "moveLock",
  "autonomy",
  "vetoMs",
  "neverWithoutAPerson",
  "bugHandling",
  "mailbox",
  "folders",
  "copyToSent",
  "retention",
  "owner",
  "sendLimitPerMinute",
  "allowInternalHost",
] as const;
const AUDITED_SERVER_FIELDS = ["host", "port", "tls", "user", "password"];

/** The names of the fields `patch` sets; never a value. */
function patchedFields(patch: Record<string, unknown>): string[] {
  const fields: string[] = AUDITED_FIELDS.filter(
    (key) => patch[key] !== undefined,
  );
  for (const which of SERVERS) {
    const server = patch[which];
    if (!isObject(server)) continue;
    for (const key of AUDITED_SERVER_FIELDS)
      if (server[key] !== undefined && server[key] !== "")
        fields.push(`${which}.${key}`);
  }
  return fields;
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
  const actor = actorFor(person, true, ctx.authUser?.login);

  if (forgetting) {
    if (req.method !== "POST") return undefined;
    return forget(actor, await readBody(req));
  }

  if (rest.length === 0) {
    if (req.method === "GET") {
      let inboxes: InboxConfig[];
      try {
        inboxes = await listInboxes();
      } catch (error) {
        return failed("list", error, "Couldn't load the inboxes. Try again");
      }
      const response: InboxesResponse = {
        enabled: emailSupportEnabled(),
        isInstanceOwner: isOwnerActor(actor),
        projects: await projectOptions(),
        inboxes: inboxes.map(viewOf),
      };
      return Response.json(response);
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!isObject(body)) return json(400, "Inbox settings are missing");
      let result: Awaited<ReturnType<typeof createInbox>>;
      try {
        result = await createInbox(body as unknown as NewInbox, actor);
      } catch (error) {
        return failed("create", error, SAVE_FAILED);
      }
      if (!result.ok) return json(result.status, result.error);
      await supportAudit({
        type: "support_inbox_created",
        inboxId: result.inbox.id,
        by: person,
      });
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
    return runTest(actor, person, await readBody(req));
  }

  const id = segment(rest[0]!);
  if (id === null) return json(400, "Invalid path");
  if (req.method === "PATCH") {
    const body = await readBody(req);
    if (!isObject(body) || typeof body.expectedRevision !== "number")
      return json(400, "Send the inbox's revision as expectedRevision");
    let result: Awaited<ReturnType<typeof updateInbox>>;
    try {
      result = await updateInbox(id, body as unknown as InboxPatch, actor);
    } catch (error) {
      return failed("update", error, SAVE_FAILED);
    }
    if (!result.ok) return json(result.status, result.error);
    await supportAudit({
      type: "support_inbox_updated",
      inboxId: result.inbox.id,
      by: person,
      fields: patchedFields(body),
    });
    return Response.json({ inbox: viewOf(result.inbox) });
  }
  if (req.method === "DELETE") {
    let result: Awaited<ReturnType<typeof deleteInbox>>;
    try {
      result = await deleteInbox(id, actor);
    } catch (error) {
      return failed("remove", error, "Couldn't remove the inbox. Try again");
    }
    if (!result.ok) return json(result.status, result.error);
    await supportAudit({
      type: "support_inbox_removed",
      inboxId: id,
      by: person,
    });
    return Response.json({ ok: true });
  }
  return undefined;
}
