// One settings document per project on the `projects` application catalog
// namespace: the project's sandbox, a model per role, the incident policy,
// production Runners and actions, and the role-by-capability access table.
// Written only through `updateProjectDocument` (revisioned, validated
// against the committed value, one audit line per write with dotted field
// paths) and `patchProjectDocumentAsServer` (releases, pairing,
// `automationId`). A project without a stored document reads as what its
// legacy settings compose to, without writing; its first write stores it.
import { randomBytes } from "node:crypto";
import {
  ACCESS_MODES,
  type AccessMode,
  CREDENTIAL_GRANT_MODES,
  type CredentialGrantMode,
  grantModeWithin,
  isIncidentAgentRole,
} from "../../shared/incident-access";
import {
  ANY_WEBSITE_HOST,
  type AccessCellChange,
  type AccessRowKey,
  defaultProjectDocument,
  type IncidentRole,
  isProjectRole,
  isUnattendedRole,
  type ProjectAccess,
  type ProjectCredentialRow,
  type ProjectHostRow,
  type ProjectSettingsDocument,
  type ProjectSettingsPatch,
  PROJECT_ROLES,
  UNATTENDED_ROLES,
  type UnattendedRole,
} from "../../shared/project-settings";
import { catalogDocuments } from "../catalog-documents";
import { configuredRepos } from "../config";
import { incidentAudit } from "../incidents/audit-sink";
import {
  type AccessCredentialInfo,
  type AccessEnvironment,
  loadAccessEnvironment,
  type OwnerRoster,
} from "../incidents/access/environment";
import { roleLockProblem } from "../incidents/access/fields";
import { canonicalModelId, sameModel } from "../incidents/response/models";
import { resolveModel } from "../models";
import { parseAutomationEgressDomain } from "../sandbox/automation-egress";
import { RUNNABLE_SANDBOX_PROVIDERS } from "../sandbox/config";
import {
  applyPolicyPatch,
  documentInvariantProblem,
  failed,
  isRecord,
  loosenedFields,
  productionRunnerProblem,
  validateActionList,
  validatePolicyFields,
  validateProductionRunners,
} from "./validate";

export const PROJECTS_NAMESPACE = "projects";
/** The key the bulk migration records itself under; never a project. */
export const MIGRATION_MARKER_KEY = "__migration";

const MAX_ROWS = 50;
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const STALE_REVISION_ERROR = "Settings changed since you loaded them";
const PERSON_ONLY_ERROR =
  "Only a signed-in person can change actions or production Runners";
const LOOSEN_ERROR = "Only a signed-in person can loosen the incident policy";
const SIGN_IN = "Sign in to grant credentials to incident agents";
const OWNER_NOT_ON_ROSTER =
  "The owner needs a team roster entry with a GitHub login to lend this credential";
const INCIDENT_ONLY = "Only incident agents have this enforced";
const VERIFIER_NO_SEARCH = "The verifier never searches the web";

export interface ProjectActor {
  name: string;
  /** A GitHub web sign-in that is not an automation, never a claimed name. */
  verified: boolean;
  /** The verified sign-in's GitHub login; lending a personal credential is
   *  checked against it. */
  login?: string;
}

export type ProjectWriteError = {
  error: string;
  status: 400 | 403 | 404 | 409;
};

export interface ProjectStoreContext {
  projectExists(id: string): boolean;
  /** Why a Runner can't be one of the project's production Runners. */
  runnerProblem(runnerId: string, project: string): string | null;
  modelProblem(id: string): string | null;
  /** A configured, non-built-in MCP server (people-restricted ones too: the
   *  access table warns about those instead of refusing them). */
  connectionExists(name: string): boolean;
  credential(id: string): AccessCredentialInfo | null;
  isOwner(login: string, owner: string): boolean;
  ownerRoster(owner: string): OwnerRoster;
  /** Why incident agents can't reach a host through this Runner. */
  hostProblem(runner: string): string | null;
}

// Bound on first use, never at import: the catalog client is a live effect.
let documents: ReturnType<typeof catalogDocuments> | undefined;
export function projectDocuments(): ReturnType<typeof catalogDocuments> {
  return (documents ??= catalogDocuments(PROJECTS_NAMESPACE));
}

let contextOverride: Partial<ProjectStoreContext> | undefined;

/** Replace parts of the validation context (undefined restores production). */
export function __setProjectStoreContextForTest(
  ctx?: Partial<ProjectStoreContext>,
): void {
  contextOverride = ctx;
}

const ENV_KEYS = [
  "connectionExists",
  "credential",
  "isOwner",
  "ownerRoster",
  "hostProblem",
] as const;

function hostProblemIn(env: AccessEnvironment, ref: string): string | null {
  const info = env.runner(ref);
  if (!info) return `Unknown Runner "${ref}"`;
  if (!info.commands) return `Runner ${info.name} does not accept commands`;
  if (info.userRestricted && !info.reserved)
    return `Runner ${info.name} only accepts named people; incident agents act as nobody`;
  if (info.platform !== "linux" && info.platform !== "darwin")
    return `Runner ${info.name} runs on ${info.platform === "win32" ? "Windows" : info.platform}; host commands need a Linux or macOS Runner`;
  return null;
}

/** The validation context. The access environment (connections, Runners,
 *  keychain) is loaded only when the write touches the access table. */
async function context(needEnv = true): Promise<ProjectStoreContext> {
  const o = contextOverride ?? {};
  const env =
    !needEnv || ENV_KEYS.every((k) => o[k])
      ? undefined
      : await loadAccessEnvironment();
  const noEnv = (): never => {
    throw new Error("The access environment was not loaded");
  };
  return {
    projectExists:
      o.projectExists ?? ((id) => Object.hasOwn(configuredRepos(), id)),
    runnerProblem: o.runnerProblem ?? productionRunnerProblem,
    modelProblem:
      o.modelProblem ??
      ((id) => (resolveModel(id) ? null : `Unknown model ${id}`)),
    connectionExists:
      o.connectionExists ??
      ((name) => {
        const status = (env ?? noEnv()).connection(name);
        return status === "ok" || status === "user-gated";
      }),
    credential: o.credential ?? ((id) => (env ?? noEnv()).credential(id)),
    isOwner:
      o.isOwner ?? ((login, owner) => (env ?? noEnv()).isOwner(login, owner)),
    ownerRoster:
      o.ownerRoster ?? ((owner) => (env ?? noEnv()).ownerRoster(owner)),
    hostProblem:
      o.hostProblem ?? ((runner) => hostProblemIn(env ?? noEnv(), runner)),
  };
}

/** Whether `project` is a registered project (the test context may say
 *  otherwise). */
export function projectExists(project: string): boolean {
  return (
    contextOverride?.projectExists ??
    ((id: string) => Object.hasOwn(configuredRepos(), id))
  )(project);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** What a project without a stored document reads as: its legacy
 *  settings, composed (legacy.ts imports this module, so it loads late). */
async function composeFallback(
  project: string,
  now: string,
): Promise<ProjectSettingsDocument> {
  return (await import("./legacy")).composeProjectFromLegacy(project, now);
}

function list<T>(v: unknown, fallback: T[]): T[] {
  return Array.isArray(v) ? (v as T[]) : fallback;
}

/** A stored document merged over the defaults, so a document from an older
 *  build still reads whole. */
export function withDocumentDefaults(
  project: string,
  raw: unknown,
): ProjectSettingsDocument {
  const stored = isRecord(raw) ? raw : {};
  const base = defaultProjectDocument(
    project,
    typeof stored.updatedAt === "string" ? stored.updatedAt : "",
  );
  const incidents = isRecord(stored.incidents) ? stored.incidents : {};
  const production = isRecord(stored.production) ? stored.production : {};
  const access = isRecord(stored.access) ? stored.access : {};
  const record = <T extends object>(v: unknown, fallback: T): T =>
    ({ ...fallback, ...(isRecord(v) ? v : {}) }) as T;
  return {
    ...base,
    ...(stored as Partial<ProjectSettingsDocument>),
    schema: 1,
    project,
    revision:
      typeof stored.revision === "number" && Number.isInteger(stored.revision)
        ? stored.revision
        : 0,
    sandbox: typeof stored.sandbox === "string" ? stored.sandbox : "default",
    models: record(stored.models, {}),
    incidents: {
      ...base.incidents,
      ...(incidents as Partial<ProjectSettingsDocument["incidents"]>),
      budget: record(incidents.budget, base.incidents.budget),
      neverWithoutYou: list(
        incidents.neverWithoutYou,
        base.incidents.neverWithoutYou,
      ),
    },
    production: {
      runners: list(production.runners, []),
      actions: list(production.actions, []),
      releases: list(production.releases, []),
    },
    access: {
      modes: record(access.modes, base.access.modes),
      connections: list(access.connections, []),
      credentials: list(access.credentials, []),
      hosts: list(access.hosts, []),
      websites: list(access.websites, []),
      webSearch: list<ProjectAccess["webSearch"][number]>(
        access.webSearch,
        base.access.webSearch,
      ).filter((r) => (r as string) !== "verifier"),
      routes: record(access.routes, base.access.routes),
      deniedTools: record(access.deniedTools, base.access.deniedTools),
      signalExceptions: list(access.signalExceptions, []),
    },
  };
}

const cache = new Map<string, ProjectSettingsDocument>();
function remember(d: ProjectSettingsDocument): ProjectSettingsDocument {
  cache.set(d.project, d);
  return d;
}

/** Forget every cached document (tests start from a fresh kernel). */
export function __clearProjectDocumentCacheForTest(): void {
  cache.clear();
}

/** The last document this process read or wrote for the project. */
export function peekProjectDocument(
  project: string,
): ProjectSettingsDocument | undefined {
  return cache.get(project);
}

/** The stored document, else what the legacy settings compose to (nothing
 *  is written). */
export async function getProjectDocument(
  project: string,
): Promise<ProjectSettingsDocument> {
  const stored = await projectDocuments().get(project);
  if (stored !== null) return remember(withDocumentDefaults(project, stored));
  return remember(await composeFallback(project, new Date().toISOString()));
}

/** Whether the project has a stored document of its own. */
export async function hasStoredProjectDocument(
  project: string,
): Promise<boolean> {
  return (await projectDocuments().get(project)) !== null;
}

/** Every stored document (projects still on their legacy settings are not
 *  listed). */
export async function listProjectDocuments(): Promise<
  ProjectSettingsDocument[]
> {
  const rows = await projectDocuments().list();
  return rows
    .filter((row) => row.key !== MIGRATION_MARKER_KEY)
    .map((row) => remember(withDocumentDefaults(row.key, row.value)));
}

// ── Change listeners ────────────────────────────────────────────────────────

const listeners = new Set<(project: string) => void>();

/** Subscribe to committed writes, the caller's and the server's own;
 *  returns the unsubscribe function. */
export function onProjectDocumentChange(
  listener: (project: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Each listener on its own microtask, so none can fail or hold the write. */
function notify(project: string): void {
  for (const listener of [...listeners])
    void Promise.resolve()
      .then(() => listener(project))
      .catch((error: unknown) => {
        console.warn(
          "[project-settings] change listener failed:",
          error instanceof Error ? error.message : error,
        );
      });
}

/** A document the bulk migration committed: cached and announced like any
 *  other write. */
export function noteMigratedDocument(
  project: string,
  raw: unknown,
): ProjectSettingsDocument {
  const doc = remember(withDocumentDefaults(project, raw));
  notify(project);
  return doc;
}

function newHookSecret(): string {
  return randomBytes(24).toString("hex");
}

// ── Applying a patch (pure apart from the context) ──────────────────────────

class Refused {
  constructor(
    readonly error: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly fields: string[] = [],
  ) {}
}

function refuse(error: string, status: 400 | 403 = 400): never {
  throw new Refused(error, status);
}

function hostKey(h: { runner: string; ssh?: string }): string {
  return h.ssh ? `${h.runner}>${h.ssh}` : h.runner;
}

function websiteHost(host: unknown): string {
  if (typeof host !== "string" || !host.trim())
    refuse("Each website needs a host name");
  if (host.trim() === ANY_WEBSITE_HOST)
    refuse("Unattended runs need a list of websites, not any website");
  try {
    return parseAutomationEgressDomain(host);
  } catch (error) {
    refuse(
      error instanceof Error
        ? `Not a website: ${host.trim()}`
        : "Not a website",
    );
  }
}

function name(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim() || v.length > 256)
    refuse(`Each ${what} needs a name`);
  return v.trim();
}

/** The row a key names, in a mutable copy of the access table. */
type RowRef =
  | { kind: "connection"; row: ProjectAccess["connections"][number] }
  | { kind: "credential"; row: ProjectCredentialRow }
  | { kind: "host"; row: ProjectHostRow }
  | { kind: "website"; row: ProjectAccess["websites"][number] };

interface PatchState {
  project: string;
  access: ProjectAccess;
  ctx: ProjectStoreContext;
  actor: ProjectActor;
  now: string;
  /** Credentials lent wider than before, for the audit. */
  lent: Array<{ credential: string; role: IncidentRole; mode: string }>;
}

function checkRowKey(key: unknown): AccessRowKey {
  if (!isRecord(key)) refuse("Each access row needs a kind");
  switch (key.kind) {
    case "mode":
    case "webSearch":
      return { kind: key.kind };
    case "connection":
      return { kind: "connection", server: name(key.server, "connector") };
    case "credential":
      return {
        kind: "credential",
        credential: name(key.credential, "credential"),
      };
    case "host": {
      const runner = name(key.runner, "host");
      if (key.ssh === undefined || key.ssh === null || key.ssh === "")
        return { kind: "host", runner };
      if (typeof key.ssh !== "string" || !SSH_ALIAS.test(key.ssh))
        refuse(`Invalid SSH alias "${String(key.ssh)}"`);
      return { kind: "host", runner, ssh: key.ssh };
    }
    case "website":
      return { kind: "website", host: websiteHost(key.host) };
    default:
      refuse(`Unknown access row "${String(key.kind)}"`);
  }
}

function findRow(s: PatchState, key: AccessRowKey): RowRef | undefined {
  const a = s.access;
  switch (key.kind) {
    case "connection": {
      const row = a.connections.find((r) => r.server === key.server);
      return row && { kind: "connection", row };
    }
    case "credential": {
      const row = a.credentials.find((r) => r.credential === key.credential);
      return row && { kind: "credential", row };
    }
    case "host": {
      const row = a.hosts.find((r) => hostKey(r) === hostKey(key));
      return row && { kind: "host", row };
    }
    case "website": {
      const row = a.websites.find((r) => r.host === key.host);
      return row && { kind: "website", row };
    }
    default:
      return undefined;
  }
}

function credentialInfo(
  s: PatchState,
  id: string,
): AccessCredentialInfo & { id: string } {
  const info = s.ctx.credential(id);
  if (!info) refuse(`Unknown credential "${id}"`);
  if (info.kind === "login")
    refuse(
      `${info.service} is a login; logins are never lent to incident agents`,
    );
  return info;
}

function addRow(s: PatchState, key: AccessRowKey): RowRef {
  const existing = findRow(s, key);
  if (existing) return existing;
  const a = s.access;
  const full = (rows: unknown[]) => {
    if (rows.length >= MAX_ROWS) refuse(`Too many rows (max ${MAX_ROWS})`);
  };
  switch (key.kind) {
    case "connection": {
      if (!s.ctx.connectionExists(key.server))
        refuse(`Unknown connection "${key.server}"`);
      full(a.connections);
      const row = { server: key.server, roles: [] as UnattendedRole[] };
      a.connections.push(row);
      return { kind: "connection", row };
    }
    case "credential": {
      const info = credentialInfo(s, key.credential);
      full(a.credentials);
      const row: ProjectCredentialRow = {
        credential: info.id,
        roles: {},
        grantedBy: s.actor.name || "Anonymous",
        ...(s.actor.verified && s.actor.login
          ? { grantedByLogin: s.actor.login }
          : {}),
        grantedAt: s.now,
      };
      a.credentials.push(row);
      return { kind: "credential", row };
    }
    case "host": {
      const problem = s.ctx.hostProblem(key.runner);
      if (problem) refuse(problem);
      full(a.hosts);
      const row: ProjectHostRow = {
        runner: key.runner,
        ...(key.ssh ? { ssh: key.ssh } : {}),
        access: "read-only",
        roles: [],
      };
      a.hosts.push(row);
      return { kind: "host", row };
    }
    case "website": {
      full(a.websites);
      const row = { host: key.host, roles: [] as UnattendedRole[] };
      a.websites.push(row);
      return { kind: "website", row };
    }
    default:
      refuse("That row can't be added or removed");
  }
}

function removeRow(s: PatchState, key: AccessRowKey): void {
  const a = s.access;
  switch (key.kind) {
    case "connection":
      a.connections = a.connections.filter((r) => r.server !== key.server);
      return;
    case "credential":
      a.credentials = a.credentials.filter(
        (r) => r.credential !== key.credential,
      );
      return;
    case "host":
      a.hosts = a.hosts.filter((r) => hostKey(r) !== hostKey(key));
      return;
    case "website":
      a.websites = a.websites.filter((r) => r.host !== key.host);
      return;
    default:
      refuse("That row can't be added or removed");
  }
}

function toggle<T extends string>(roles: T[], role: T, on: boolean): T[] {
  const without = roles.filter((r) => r !== role);
  return on ? [...without, role] : without;
}

function boolValue(v: unknown): boolean {
  if (typeof v !== "boolean") refuse("This cell takes yes or no");
  return v;
}

function incidentRole(role: UnattendedRole): IncidentRole {
  if (!isIncidentAgentRole(role)) refuse(INCIDENT_ONLY);
  return role;
}

function lendCredential(
  s: PatchState,
  row: ProjectCredentialRow,
  role: IncidentRole,
  mode: CredentialGrantMode,
): void {
  const previous = row.roles[role];
  if (previous && grantModeWithin(mode, previous)) {
    row.roles = { ...row.roles, [role]: mode };
    return;
  }
  // Wider than before: today's lending rules (grants.ts).
  const login = s.actor.verified ? s.actor.login?.trim() : undefined;
  if (!s.actor.verified) refuse(SIGN_IN, 403);
  if (!login) refuse(SIGN_IN);
  const info = credentialInfo(s, row.credential);
  if (info.scope === "personal" && !s.ctx.isOwner(login, info.owner))
    refuse(
      s.ctx.ownerRoster(info.owner) === "none"
        ? OWNER_NOT_ON_ROSTER
        : `Only ${info.owner} can grant ${info.service} to incident agents`,
    );
  row.roles = { ...row.roles, [role]: mode };
  row.grantedBy = s.actor.name || "Anonymous";
  row.grantedByLogin = login;
  row.grantedAt = s.now;
  s.lent.push({ credential: row.credential, role, mode });
}

function applyCell(s: PatchState, change: unknown): void {
  if (!isRecord(change)) refuse("Each cell change must be an object");
  const role = change.role;
  if (!isUnattendedRole(role)) refuse(`Unknown role "${String(role)}"`);
  const key = checkRowKey(change.row);
  const value = change.value as AccessCellChange["value"];
  const a = s.access;
  switch (key.kind) {
    case "mode": {
      if (!(ACCESS_MODES as readonly unknown[]).includes(value))
        refuse("Mode must be ask or code");
      const mode = value as AccessMode;
      if (isIncidentAgentRole(role)) {
        const lock = roleLockProblem(role, { mode });
        if (lock) refuse(lock);
      }
      a.modes = { ...a.modes, [role]: mode };
      return;
    }
    case "webSearch": {
      const on = boolValue(value);
      if (role === "verifier") refuse(VERIFIER_NO_SEARCH);
      a.webSearch = toggle(a.webSearch, role, on);
      return;
    }
    case "credential": {
      const r = incidentRole(role);
      if (
        value !== null &&
        !(CREDENTIAL_GRANT_MODES as readonly unknown[]).includes(value)
      )
        refuse("Credential mode must be once, standing or off");
      const existing = findRow(s, key);
      if (value === null) {
        if (existing?.kind === "credential") {
          const { [r]: _dropped, ...rest } = existing.row.roles;
          existing.row.roles = rest;
        }
        return;
      }
      const ref = existing ?? addRow(s, key);
      if (ref.kind !== "credential") return;
      lendCredential(s, ref.row, r, value as CredentialGrantMode);
      return;
    }
    case "host": {
      const r = incidentRole(role);
      const on = boolValue(value);
      const existing = findRow(s, key);
      if (!on && !existing) return;
      const ref = existing ?? addRow(s, key);
      if (ref.kind === "host") ref.row.roles = toggle(ref.row.roles, r, on);
      return;
    }
    case "connection":
    case "website": {
      const on = boolValue(value);
      const existing = findRow(s, key);
      if (!on && !existing) return;
      const ref = existing ?? addRow(s, key);
      if (ref.kind === "connection" || ref.kind === "website")
        ref.row.roles = toggle(ref.row.roles, role, on);
      return;
    }
  }
}

/** A deep copy of the access table, so a refused patch changes nothing. */
function copyAccess(a: ProjectAccess): ProjectAccess {
  return structuredClone(a);
}

function applyAccessPatch(s: PatchState, input: unknown): void {
  if (!isRecord(input)) refuse("Access changes must be an object");
  const rowsOf = (v: unknown, what: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) refuse(`${what} must be a list`);
    return v;
  };
  for (const key of rowsOf(input.addRows, "Rows to add"))
    addRow(s, checkRowKey(key));
  for (const change of rowsOf(input.cells, "Cell changes"))
    applyCell(s, change);
  for (const key of rowsOf(input.removeRows, "Rows to remove"))
    removeRow(s, checkRowKey(key));
  for (const item of rowsOf(
    input.removeSignalExceptions,
    "Signal exceptions to remove",
  )) {
    if (
      !isRecord(item) ||
      typeof item.signalId !== "string" ||
      !isIncidentAgentRole(item.role)
    )
      refuse("Each signal exception needs a signal and a role");
    s.access.signalExceptions = s.access.signalExceptions.filter(
      (e) => !(e.signalId === item.signalId && e.role === item.role),
    );
  }
}

function applyModels(
  current: ProjectSettingsDocument["models"],
  input: unknown,
  ctx: ProjectStoreContext,
): ProjectSettingsDocument["models"] {
  if (!isRecord(input)) refuse("Models must be an object");
  const models = { ...current };
  for (const [role, v] of Object.entries(input)) {
    if (!isProjectRole(role)) refuse(`Unknown role "${role}"`);
    if (v === undefined || v === null || v === "") {
      delete models[role];
      continue;
    }
    if (typeof v !== "string") refuse(`The ${role} model must be a model id`);
    const problem = ctx.modelProblem(v);
    if (problem) refuse(problem);
    models[role] = canonicalModelId(v);
  }
  if (
    models.investigator &&
    models.verifier &&
    sameModel(models.investigator, models.verifier)
  )
    refuse("Pick a different model for the verifier");
  return models;
}

function applySandbox(v: unknown): string {
  if (typeof v !== "string") refuse("Sandbox must be a provider id");
  const choice = v.trim().toLowerCase();
  if (
    choice !== "default" &&
    choice !== "local" &&
    !(RUNNABLE_SANDBOX_PROVIDERS as readonly string[]).includes(choice)
  )
    refuse(`Unknown sandbox provider "${v}"`);
  return choice;
}

/** `current` with `patch` applied, or a thrown `Refused`. */
function applyPatch(
  current: ProjectSettingsDocument,
  patch: ProjectSettingsPatch,
  s: Omit<PatchState, "access" | "project">,
): ProjectSettingsDocument {
  const next: ProjectSettingsDocument = { ...current };
  if (patch.sandbox !== undefined) next.sandbox = applySandbox(patch.sandbox);
  if (patch.models !== undefined)
    next.models = applyModels(current.models, patch.models, s.ctx);
  if (patch.incidents !== undefined) {
    if (!isRecord(patch.incidents)) refuse("Incident policy must be an object");
    const policy = validatePolicyFields(patch.incidents, current.incidents);
    if (failed(policy)) refuse(policy.error);
    next.incidents = applyPolicyPatch(current.incidents, policy);
  }
  if (patch.production !== undefined) {
    const input = patch.production as unknown;
    if (!isRecord(input)) refuse("Production must be an object");
    const production = { ...current.production };
    if (input.runners !== undefined) {
      const runners = validateProductionRunners(
        input.runners,
        current.project,
        s.ctx.runnerProblem,
      );
      if (failed(runners)) refuse(runners.error);
      production.runners = runners;
    }
    if (input.actions !== undefined) {
      const actions = validateActionList(input.actions, production.runners);
      if (failed(actions)) refuse(actions.error);
      production.actions = actions;
    }
    next.production = production;
  }
  if (patch.access !== undefined) {
    const state: PatchState = {
      ...s,
      project: current.project,
      access: copyAccess(current.access),
    };
    applyAccessPatch(state, patch.access);
    next.access = state.access;
  }
  return next;
}

// ── Which fields changed ────────────────────────────────────────────────────

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rowPaths<R>(
  group: string,
  before: R[],
  after: R[],
  keyOf: (r: R) => string,
  rolesOf: (r: R) => Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const keys = [...new Set([...before.map(keyOf), ...after.map(keyOf)])].sort();
  for (const key of keys) {
    const b = before.find((r) => keyOf(r) === key);
    const a = after.find((r) => keyOf(r) === key);
    const br = b ? rolesOf(b) : {};
    const ar = a ? rolesOf(a) : {};
    const roles = [...new Set([...Object.keys(br), ...Object.keys(ar)])]
      .filter((role) => !same(br[role], ar[role]))
      .sort();
    if (roles.length)
      out.push(...roles.map((role) => `access.${group}.${key}.${role}`));
    else if (!b !== !a) out.push(`access.${group}.${key}`);
  }
  return out;
}

const roleSet = (roles: readonly string[]) =>
  Object.fromEntries(roles.map((r) => [r, true]));

/** Dotted paths of every caller-visible change, sorted. */
export function changedFieldPaths(
  before: ProjectSettingsDocument,
  after: ProjectSettingsDocument,
): string[] {
  const out: string[] = [];
  if (before.sandbox !== after.sandbox) out.push("sandbox");
  for (const role of PROJECT_ROLES)
    if (before.models[role] !== after.models[role]) out.push(`models.${role}`);
  const policy = new Set([
    ...Object.keys(before.incidents),
    ...Object.keys(after.incidents),
  ]);
  for (const field of [...policy].sort())
    if (
      !same(
        before.incidents[field as keyof typeof before.incidents],
        after.incidents[field as keyof typeof after.incidents],
      )
    )
      out.push(`incidents.${field}`);
  for (const field of ["runners", "actions", "releases"] as const)
    if (!same(before.production[field], after.production[field]))
      out.push(`production.${field}`);
  const ba = before.access;
  const aa = after.access;
  for (const role of UNATTENDED_ROLES)
    if (ba.modes[role] !== aa.modes[role]) out.push(`access.modes.${role}`);
  out.push(
    ...rowPaths(
      "connections",
      ba.connections,
      aa.connections,
      (r) => r.server,
      (r) => roleSet(r.roles),
    ),
    ...rowPaths(
      "credentials",
      ba.credentials,
      aa.credentials,
      (r) => r.credential,
      (r) => r.roles,
    ),
    ...rowPaths("hosts", ba.hosts, aa.hosts, hostKey, (r) => roleSet(r.roles)),
    ...rowPaths(
      "websites",
      ba.websites,
      aa.websites,
      (r) => r.host,
      (r) => roleSet(r.roles),
    ),
  );
  for (const role of UNATTENDED_ROLES)
    if (
      (ba.webSearch as string[]).includes(role) !==
      (aa.webSearch as string[]).includes(role)
    )
      out.push(`access.webSearch.${role}`);
  for (const field of ["routes", "deniedTools"] as const)
    if (!same(ba[field], aa[field])) out.push(`access.${field}`);
  const exceptionKey = (e: { signalId: string; role: string }) =>
    `${e.signalId}.${e.role}`;
  const exceptions = new Set([
    ...ba.signalExceptions.map(exceptionKey),
    ...aa.signalExceptions.map(exceptionKey),
  ]);
  for (const key of [...exceptions].sort())
    if (
      !same(
        ba.signalExceptions.find((e) => exceptionKey(e) === key),
        aa.signalExceptions.find((e) => exceptionKey(e) === key),
      )
    )
      out.push(`access.signalExceptions.${key}`);
  return out.sort();
}

// ── Writes ──────────────────────────────────────────────────────────────────

function validPatchShape(patch: unknown): patch is ProjectSettingsPatch {
  return (
    isRecord(patch) &&
    typeof patch.expectedRevision === "number" &&
    Number.isInteger(patch.expectedRevision)
  );
}

/**
 * Apply a page patch to the committed document. Every rule is checked
 * inside the catalog mutate against the value the write commits to. A
 * no-op patch returns the current document without writing.
 */
export async function updateProjectDocument(
  project: string,
  patch: ProjectSettingsPatch,
  actor: ProjectActor,
): Promise<ProjectSettingsDocument | ProjectWriteError> {
  const ctx = await context(isRecord(patch) && patch.access !== undefined);
  if (!ctx.projectExists(project))
    return { error: `Unknown project ${project}`, status: 404 };
  if (!validPatchShape(patch))
    return {
      error: "Settings changes need the revision they were made against",
      status: 400,
    };
  const now = new Date().toISOString();
  const by = actor.name || "Anonymous";
  // Composed before the mutate, which can't wait: the first write stores
  // what the legacy settings compose to, with this patch applied.
  const fallback = (await hasStoredProjectDocument(project))
    ? undefined
    : await composeFallback(project, now);
  let fields: string[] = [];
  let lent: PatchState["lent"] = [];
  let unchanged: ProjectSettingsDocument | undefined;
  let committed: unknown;
  try {
    committed = await projectDocuments().update(project, (stored) => {
      const current =
        stored !== null
          ? withDocumentDefaults(project, stored)
          : (fallback ?? defaultProjectDocument(project, now));
      if (patch.expectedRevision !== current.revision)
        throw new Refused(STALE_REVISION_ERROR, 409);
      const state = { ctx, actor, now, lent: [] as PatchState["lent"] };
      const next = applyPatch(current, patch, state);
      fields = changedFieldPaths(current, next);
      if (fields.length === 0) {
        unchanged = current;
        throw new Refused("", 400);
      }
      if (!actor.verified) {
        const production = fields.filter((f) => f.startsWith("production."));
        if (production.length)
          throw new Refused(PERSON_ONLY_ERROR, 403, production);
        const looser = loosenedFields(current.incidents, next.incidents);
        if (looser.length)
          throw new Refused(
            LOOSEN_ERROR,
            403,
            looser.map((f) => `incidents.${f}`),
          );
      }
      const problem = documentInvariantProblem(next);
      if (problem) throw new Refused(problem, 400);
      lent = state.lent;
      return {
        ...next,
        revision: current.revision + 1,
        releaseHookSecret: current.releaseHookSecret ?? newHookSecret(),
        ...(stored === null ? { migratedAt: current.migratedAt ?? now } : {}),
        updatedAt: now,
        updatedBy: by,
      } satisfies ProjectSettingsDocument;
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    if (unchanged) return remember(unchanged);
    if (error.status === 403)
      incidentAudit({
        kind: "project_settings_refused",
        project,
        by,
        fields: error.fields,
      });
    return { error: error.error, status: error.status };
  }
  const result = remember(withDocumentDefaults(project, committed));
  incidentAudit({ kind: "project_settings_updated", project, by, fields });
  for (const l of lent)
    incidentAudit({
      kind: "project_settings_credential_lent",
      project,
      credentialId: l.credential,
      role: l.role,
      mode: l.mode,
      by,
    });
  notify(project);
  return result;
}

/** Server-side writes (releases, pairing, `automationId`): no caller
 *  validation, no revision bump and no field audit, but only for a
 *  registered project and only when the whole document keeps its rules.
 *  Throws otherwise and writes nothing. */
export async function patchProjectDocumentAsServer(
  project: string,
  mutate: (d: ProjectSettingsDocument) => ProjectSettingsDocument,
): Promise<ProjectSettingsDocument> {
  if (!projectExists(project)) throw new Error(`Unknown project ${project}`);
  const now = new Date().toISOString();
  const fallback = (await hasStoredProjectDocument(project))
    ? undefined
    : await composeFallback(project, now);
  const committed = await projectDocuments().update(project, (stored) => {
    const current =
      stored !== null
        ? withDocumentDefaults(project, stored)
        : (fallback ?? defaultProjectDocument(project, now));
    const next = mutate(current);
    const problem = documentInvariantProblem(next);
    if (problem) throw new Error(problem);
    return {
      ...next,
      schema: 1,
      project,
      revision: current.revision,
      releaseHookSecret: next.releaseHookSecret ?? newHookSecret(),
      ...(stored === null ? { migratedAt: current.migratedAt ?? now } : {}),
    } satisfies ProjectSettingsDocument;
  });
  const result = remember(withDocumentDefaults(project, committed));
  notify(project);
  return result;
}
