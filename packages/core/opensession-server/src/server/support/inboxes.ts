// Support inbox configuration on the application catalog (`support-inboxes`),
// the sandbox connections' pattern: a normalized record whose passwords are
// opaque refs into workspace-secrets.ts. The IMAP and SMTP passwords never
// sit in the catalog, an API response or a log line; inboxPassword() is the
// only way back to them, for the transports.
//
// Updates are compare-and-swap on the record's revision; change listeners
// hear every committed create, update and delete (the transports reconnect
// from them). Nothing runs at import.
import { randomUUIDv7 } from "bun";
import { isIP } from "node:net";
import { AUTONOMY_LEVELS } from "../../shared/incident-response";
import {
  BUG_HANDLING,
  type InboxConfig,
  type InboxHealth,
  type InboxPatch,
  type InboxView,
  MAILBOX_BEHAVIOURS,
  type MailServerConfig,
  SUPPORT_TOPICS,
  defaultInboxConfig,
} from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";
import { configuredRepos } from "../config";
import { instanceOwner, personOwner, resolveOwner } from "../incidents/owner";
import {
  deleteWorkspaceSecretAsync,
  putWorkspaceSecretAsync,
  resolveWorkspaceSecretAsync,
} from "../workspace-secrets";

type ServerInput = Omit<MailServerConfig, "passwordRef"> & {
  password: string;
};

export type NewInbox = Pick<InboxConfig, "label" | "address" | "project"> &
  Partial<Pick<InboxConfig, "owner">> & {
    imap: ServerInput;
    smtp: ServerInput;
  };

type Which = "imap" | "smtp";
const SERVERS: Which[] = ["imap", "smtp"];
const SERVER_NAMES: Record<Which, string> = { imap: "IMAP", smtp: "SMTP" };

const VETO_MIN_MS = 60_000;
const VETO_MAX_MS = 86_400_000;
const SEND_LIMIT_MAX = 120;
const LABEL_MAX = 120;
const PASSWORD_MAX = 1024;

// Bound on first use, never at import: the catalog client is a live effect.
let inboxDocs: ReturnType<typeof catalogDocuments> | undefined;
const inboxes = () => (inboxDocs ??= catalogDocuments("support-inboxes"));

let projectCheck: ((id: string) => boolean) | undefined;

/** Replace the project registry check (tests); undefined restores it. */
export function __setInboxProjectCheckForTest(
  check: ((id: string) => boolean) | undefined,
): void {
  projectCheck = check;
}

function projectExists(id: string): boolean {
  return projectCheck ? projectCheck(id) : Object.hasOwn(configuredRepos(), id);
}

export type InboxListener = (
  next: InboxConfig | null,
  previous: InboxConfig | null,
) => void;

const listeners = new Set<InboxListener>();

export function onInboxChange(listener: InboxListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What a failed secret write or delete logs: the error's code or name only,
 *  since a parse error's message can quote the store. */
function warnSecret(action: string, ref: string, error: unknown): void {
  const e = error as NodeJS.ErrnoException | null;
  console.warn(
    `[support] couldn't ${action} inbox secret ${ref}:`,
    e?.code ?? e?.name ?? "error",
  );
}

/** Each listener on its own microtask, as the conversation store does. */
function notify(next: InboxConfig | null, previous: InboxConfig | null): void {
  for (const listener of [...listeners])
    void Promise.resolve()
      .then(() => listener(next, previous))
      .catch((error: unknown) => {
        console.warn(
          "[support] inbox listener failed:",
          error instanceof Error ? error.message : error,
        );
      });
}

function isInboxId(id: unknown): id is string {
  return (
    typeof id === "string" && id.length <= 256 && /^inb_[0-9a-f-]+$/i.test(id)
  );
}

function isInboxRecord(value: unknown): value is InboxConfig {
  const v = value as InboxConfig | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    typeof v.revision === "number" &&
    !!v.imap &&
    !!v.smtp
  );
}

const secretPurpose = (id: string, which: Which) =>
  `support-inbox:${id}:${which}`;

// ── Validation (pure) ───────────────────────────────────────────────────

const isInt = (value: unknown, min: number, max: number) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

// One RFC 1123 label; a host name is up to 253 characters of them.
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// Exactly one address: one `@`, no whitespace, and none of the characters
// that would make a header carry a second address or a display name.
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A host name or an IP literal (IPv6 without brackets). */
function hostError(host: unknown, name: string): string | null {
  if (typeof host === "string" && isIP(host)) return null;
  if (typeof host === "string" && /^[^:]+:\d+$/.test(host))
    return `${name} host can't include a port. Put it in the port field`;
  const labels = typeof host === "string" ? host.split(".") : [];
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    !labels.every((label) => HOST_LABEL.test(label)) ||
    // An all-numeric last label is a malformed IP address, not a name.
    /^\d+$/.test(labels.at(-1)!)
  )
    return `${name} host must be a host name or IP address`;
  return null;
}

function passwordError(password: unknown, which: Which): string | null {
  const name = SERVER_NAMES[which];
  if (typeof password !== "string" || !password)
    return `${name} password is required`;
  if (password.length > PASSWORD_MAX || /[\r\n\0]/.test(password))
    return `${name} password must be up to ${PASSWORD_MAX} characters, without line breaks`;
  return null;
}

function serverError(server: MailServerConfig, which: Which): string | null {
  const name = SERVER_NAMES[which];
  if (!server || typeof server !== "object")
    return `${name} settings are missing`;
  const host = hostError(server.host, name);
  if (host) return host;
  if (!isInt(server.port, 1, 65_535))
    return `${name} port must be a whole number from 1 to 65535`;
  if (typeof server.secure !== "boolean")
    return `${name} TLS setting must be on or off`;
  if (
    typeof server.user !== "string" ||
    !server.user.trim() ||
    CONTROL.test(server.user)
  )
    return `${name} user name is required`;
  return null;
}

function folderError(name: unknown, label: string): string | null {
  if (typeof name !== "string" || !name.trim())
    return `${label} folder is required`;
  if (/[*%]/.test(name) || CONTROL.test(name) || name.length > 200)
    return `${label} folder can't contain *, % or control characters`;
  return null;
}

/** Why `config` can't be stored, or null. Pure; messages are sentence case
 *  and name the field. */
export function validateInbox(
  config: InboxConfig,
  projectExists: (id: string) => boolean,
): string | null {
  if (
    typeof config.label !== "string" ||
    !config.label.trim() ||
    config.label.length > LABEL_MAX ||
    CONTROL.test(config.label)
  )
    return `Label is required, up to ${LABEL_MAX} characters on one line`;
  if (
    typeof config.address !== "string" ||
    !ADDRESS.test(config.address) ||
    CONTROL.test(config.address)
  )
    return "Address must be an email address like help@example.test";
  if (config.channel !== "email") return "Channel must be email";
  if (typeof config.project !== "string" || !projectExists(config.project))
    return `Project ${JSON.stringify(config.project)} doesn't exist`;
  if (typeof config.enabled !== "boolean") return "Enabled must be on or off";
  if (config.moveLock !== "agent" && config.moveLock !== "people")
    return "Move lock must be agent or people";
  if (!AUTONOMY_LEVELS.includes(config.autonomy))
    return "Autonomy must be one of the four levels";
  if (!isInt(config.vetoMs, VETO_MIN_MS, VETO_MAX_MS))
    return "Veto window must be from 1 minute to 24 hours";
  if (
    !Array.isArray(config.neverWithoutAPerson) ||
    config.neverWithoutAPerson.some((topic) => !SUPPORT_TOPICS.includes(topic))
  )
    return `Never without a person topics must be from: ${SUPPORT_TOPICS.join(", ")}`;
  if (!BUG_HANDLING.includes(config.bugHandling))
    return "Bug handling must be off, issue, or issue and agent";
  if (!MAILBOX_BEHAVIOURS.includes(config.mailbox))
    return "Mailbox behaviour must be untouched, mark read, or move";
  const done = folderError(config.folders?.done, "Done");
  if (done) return done;
  const spam = folderError(config.folders?.spam, "Spam");
  if (spam) return spam;
  if (typeof config.copyToSent !== "boolean")
    return "Copy to Sent must be on or off";
  const retention = config.retention;
  if (!retention || !isInt(retention.conversationDays, 1, 36_500))
    return "Conversation retention must be a whole number of days";
  if (!isInt(retention.attachmentDays, 1, 36_500))
    return "Attachment retention must be a whole number of days";
  if (retention.attachmentDays > retention.conversationDays)
    return "Attachment retention can't be longer than conversation retention";
  if (typeof config.owner !== "string") return "Owner must be a person";
  if (!isInt(config.sendLimitPerMinute, 1, SEND_LIMIT_MAX))
    return `Send limit must be from 1 to ${SEND_LIMIT_MAX} a minute`;
  for (const which of SERVERS) {
    const error = serverError(config[which], which);
    if (error) return error;
  }
  return null;
}

// ── Views (pure) ────────────────────────────────────────────────────────

function serverView({ passwordRef, ...rest }: MailServerConfig) {
  return { ...rest, hasPassword: Boolean(passwordRef) };
}

/** What the API shows: no secret refs, whether each password is set. */
export function inboxView(config: InboxConfig, health: InboxHealth): InboxView {
  return {
    ...config,
    imap: serverView(config.imap),
    smtp: serverView(config.smtp),
    health,
  };
}

// ── Store ───────────────────────────────────────────────────────────────

export async function listInboxes(): Promise<InboxConfig[]> {
  const out: InboxConfig[] = [];
  for (const { value } of await inboxes().list())
    if (isInboxRecord(value)) out.push(value);
  return out.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export async function getInbox(id: string): Promise<InboxConfig | null> {
  if (!isInboxId(id)) return null;
  const value = await inboxes().get(id);
  return isInboxRecord(value) ? value : null;
}

export async function inboxPassword(
  inbox: InboxConfig,
  which: Which,
): Promise<string | undefined> {
  const ref = inbox[which].passwordRef;
  return ref ? resolveWorkspaceSecretAsync(ref) : undefined;
}

/** Null when `input` isn't an object; field types are left to serverError. */
const trimServer = (input: ServerInput): MailServerConfig | null =>
  input && typeof input === "object"
    ? {
        host: typeof input.host === "string" ? input.host.trim() : input.host,
        port: input.port,
        secure: input.secure,
        user: typeof input.user === "string" ? input.user.trim() : input.user,
        passwordRef: null,
      }
    : null;

export async function createInbox(
  input: NewInbox,
  by: string,
): Promise<{ ok: true; inbox: InboxConfig } | { ok: false; error: string }> {
  if (!input || typeof input !== "object")
    return { ok: false, error: "Inbox settings are missing" };
  // Server settings first: defaultInboxConfig reads the SMTP host.
  const servers = {
    imap: trimServer(input.imap),
    smtp: trimServer(input.smtp),
  };
  for (const which of SERVERS) {
    const error = serverError(servers[which]!, which);
    if (error) return { ok: false, error };
  }
  let owner: string;
  if (input.owner !== undefined) {
    const resolved = resolveOwner(input.owner);
    if (typeof resolved !== "string")
      return { ok: false, error: resolved.error };
    owner = resolved;
  } else owner = personOwner(by) ?? instanceOwner();

  const now = new Date().toISOString();
  const draft = defaultInboxConfig({
    id: `inb_${randomUUIDv7()}`,
    label: typeof input.label === "string" ? input.label.trim() : input.label,
    address:
      typeof input.address === "string"
        ? input.address.trim().toLowerCase()
        : input.address,
    project: input.project,
    owner,
    createdBy: by,
    now,
    imap: servers.imap!,
    smtp: servers.smtp!,
  });
  const invalid = validateInbox(draft, projectExists);
  if (invalid) return { ok: false, error: invalid };
  for (const which of SERVERS) {
    const error = passwordError(input[which].password, which);
    if (error) return { ok: false, error };
  }

  const refs: string[] = [];
  try {
    for (const which of SERVERS) {
      const ref = await putWorkspaceSecretAsync(
        secretPurpose(draft.id, which),
        input[which].password,
      );
      refs.push(ref);
      draft[which].passwordRef = ref;
    }
    await inboxes().set(draft.id, draft);
  } catch (error) {
    // No orphaned secret outlives a failed create.
    await Promise.allSettled(refs.map(deleteWorkspaceSecretAsync));
    throw error;
  }
  notify(draft, null);
  return { ok: true, inbox: draft };
}

type UpdateResult =
  | { ok: true; inbox: InboxConfig }
  | { ok: false; status: 400 | 404 | 409; error: string };

const STALE: UpdateResult = {
  ok: false,
  status: 409,
  error: "Someone else changed this inbox. Reload and try again",
};

/** Fields a patch may set; anything else in the request is ignored. */
const PATCHABLE = [
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
] as const satisfies ReadonlyArray<keyof InboxConfig>;

function applyPatch(
  current: InboxConfig,
  patch: InboxPatch,
  by: string,
  now: string,
): InboxConfig {
  const next: InboxConfig = structuredClone(current);
  const target = next as unknown as Record<string, unknown>;
  for (const key of PATCHABLE)
    if (patch[key] !== undefined) target[key] = structuredClone(patch[key]);
  if (typeof next.label === "string") next.label = next.label.trim();
  if (typeof next.address === "string")
    next.address = next.address.trim().toLowerCase();
  for (const which of SERVERS) {
    const server = patch[which];
    if (!server) continue;
    const { host, port, secure, user } = server;
    if (host !== undefined)
      next[which].host = typeof host === "string" ? host.trim() : host;
    if (port !== undefined) next[which].port = port;
    if (secure !== undefined) next[which].secure = secure;
    if (user !== undefined)
      next[which].user = typeof user === "string" ? user.trim() : user;
  }
  next.updatedAt = now;
  next.updatedBy = by;
  return next;
}

const SERVER_CHANGED = "Enter the password again when the server changes";

/** Whether `next` would send the password somewhere `current` didn't. */
const serverChanged = (current: MailServerConfig, next: MailServerConfig) =>
  current.host !== next.host ||
  current.port !== next.port ||
  current.secure !== next.secure ||
  current.user !== next.user;

/** A new password (non-empty `password` in the patch) replaces the secret;
 *  no password keeps the old one, unless the server's host, port, TLS or
 *  user changes: then the password must come again, so a stored password
 *  is never sent to a server it wasn't entered for. */
export async function updateInbox(
  id: string,
  patch: InboxPatch,
  by: string,
): Promise<UpdateResult> {
  const current = await getInbox(id);
  if (!current)
    return { ok: false, status: 404, error: "That inbox doesn't exist" };
  if (patch.expectedRevision !== current.revision) return STALE;

  const next = applyPatch(current, patch, by, new Date().toISOString());
  if (patch.owner !== undefined && patch.owner !== current.owner) {
    const resolved = resolveOwner(patch.owner);
    if (typeof resolved !== "string")
      return { ok: false, status: 400, error: resolved.error };
    next.owner = resolved;
  }
  const invalid = validateInbox(next, projectExists);
  if (invalid) return { ok: false, status: 400, error: invalid };

  const passwords: Partial<Record<Which, string>> = {};
  for (const which of SERVERS) {
    const password = patch[which]?.password;
    if (password === undefined || password === "") {
      if (serverChanged(current[which], next[which]))
        return { ok: false, status: 400, error: SERVER_CHANGED };
      continue;
    }
    const error = passwordError(password, which);
    if (error) return { ok: false, status: 400, error };
    passwords[which] = password;
  }

  // A password for a changed server, or one with no ref yet, goes under a
  // new ref before the commit: the record never points at a missing secret,
  // nor pairs a new server with the old password. The old ref is deleted
  // after the commit. A password for an unchanged server replaces the
  // secret under its ref after the commit, so a conflict never changes it.
  const before: string[] = [];
  const retired: string[] = [];
  const after: Array<[Which, string, string]> = [];
  try {
    for (const which of SERVERS) {
      const password = passwords[which];
      if (password === undefined) continue;
      const existing = next[which].passwordRef;
      if (existing && !serverChanged(current[which], next[which]))
        after.push([which, existing, password]);
      else {
        const ref = await putWorkspaceSecretAsync(
          secretPurpose(id, which),
          password,
        );
        before.push(ref);
        if (existing) retired.push(existing);
        next[which].passwordRef = ref;
      }
    }
  } catch (error) {
    await Promise.allSettled(before.map(deleteWorkspaceSecretAsync));
    throw error;
  }

  let stale = false;
  let previous: InboxConfig | null = null;
  let committed: InboxConfig | null;
  try {
    committed = await inboxes().update<InboxConfig>(id, (value) => {
      stale = false;
      previous = null;
      // Deleted meanwhile: leave it deleted.
      if (value === null) return null;
      if (!isInboxRecord(value))
        throw new Error(`Support inbox ${id} record is malformed`);
      if (value.revision !== current.revision) {
        stale = true;
        return value;
      }
      previous = value;
      return { ...next, revision: value.revision + 1 };
    });
  } catch (error) {
    await Promise.allSettled(before.map(deleteWorkspaceSecretAsync));
    throw error;
  }
  if (stale || !isInboxRecord(committed) || previous === null) {
    await Promise.allSettled(before.map(deleteWorkspaceSecretAsync));
    if (!isInboxRecord(committed))
      return { ok: false, status: 404, error: "That inbox doesn't exist" };
    return STALE;
  }
  // Committed: listeners hear it even if a secret write below fails.
  const saved = committed;
  try {
    for (const [which, ref, password] of after)
      await putWorkspaceSecretAsync(secretPurpose(id, which), password, ref);
  } finally {
    notify(saved, previous);
    const results = await Promise.allSettled(
      retired.map(deleteWorkspaceSecretAsync),
    );
    results.forEach((result, i) => {
      if (result.status === "rejected")
        warnSecret("delete", retired[i]!, result.reason);
    });
  }
  return { ok: true, inbox: saved };
}

/** Deletes the config and both secrets. Conversations stay. */
export async function deleteInbox(id: string, _by: string): Promise<boolean> {
  const current = await getInbox(id);
  if (!current) return false;
  let previous: InboxConfig | null = null;
  await inboxes().update(id, (value) => {
    previous = isInboxRecord(value) ? value : null;
    return null;
  });
  const removed = previous as InboxConfig | null;
  if (!removed) return false;
  // The inbox is gone: listeners hear it whatever happens to the secrets.
  try {
    const refs = SERVERS.map((which) => removed[which].passwordRef).filter(
      (ref): ref is string => Boolean(ref),
    );
    const results = await Promise.allSettled(
      refs.map(deleteWorkspaceSecretAsync),
    );
    results.forEach((result, i) => {
      if (result.status === "rejected")
        warnSecret("delete", refs[i]!, result.reason);
    });
  } finally {
    notify(null, removed);
  }
  return true;
}
