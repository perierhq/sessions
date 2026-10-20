// Strict validation of incident access profiles, signal overrides, project
// grant items and stored settings documents. Unknown fields are errors, never
// ignored. With an environment, every named connection, repo, Runner,
// credential and model is checked against live state; without one (a stored
// document), only the shape is checked.
import {
  ACCESS_MODES,
  ACCESS_PROFILE_FIELDS,
  type AccessMode,
  type AccessProfileField,
  type AccessProfileFields,
  type CompleteAccessProfile,
  CREDENTIAL_GRANT_MODES,
  type CredentialGrantMode,
  type EgressGrant,
  egressRouteKey,
  grantModeWithin,
  type HostGrant,
  hostGrantKey,
  INCIDENT_AGENT_ROLES,
  type IncidentAccessSettings,
  type IncidentAgentRole,
  isIncidentAgentRole,
  modeWithin,
  type ProfileCredential,
  type ProjectAccessGrants,
  type ProjectCredentialGrant,
  type SignalAccessOverride,
  defaultRoleProfile,
} from "../../../shared/incident-access";
import { LOCAL_WORKSPACE_TOOL_IDS } from "../../run-policy";
import type { AccessEnvironment } from "./environment";

export type FieldResult<T> = T | { error: string };

export function isFieldError(v: unknown): v is { error: string } {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as { error?: unknown }).error === "string"
  );
}

export const MAX_CONNECTIONS = 50;
export const MAX_DENIED_TOOLS = 100;
export const MAX_REPOS = 20;
export const MAX_RUNNERS = 20;
export const MAX_HOSTS = 20;
export const MAX_CREDENTIALS = 20;
export const MAX_EGRESS_HOSTS = 20;
export const MAX_OVERRIDES = 200;
export const MAX_EGRESS_ROUTES = 10;

const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DENIED_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const PRIVATE_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".intranet",
  ".home.arpa",
];

/** Where an item sits. `path` is set for stored documents: errors then name
 * the dotted path; otherwise they name the kind of object. `env` is absent
 * for stored documents (shape only). */
export interface ItemContext {
  env?: AccessEnvironment;
  path?: string;
}

const at = (path: string | undefined, key: string | number): string =>
  path ? `${path}.${key}` : String(key);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function unknownKey(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  kind: string | null,
  ctx: ItemContext,
): string | null {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    if (ctx.path !== undefined) return `Unknown field "${at(ctx.path, key)}"`;
    return kind ? `Unknown ${kind} field "${key}"` : `Unknown field "${key}"`;
  }
  return null;
}

export function missingKey(
  obj: Record<string, unknown>,
  required: readonly string[],
  path: string | undefined,
): string | null {
  for (const key of required)
    if (!Object.hasOwn(obj, key)) return `Missing field "${at(path, key)}"`;
  return null;
}

function nameList(
  v: unknown,
  field: string,
  max: number,
): FieldResult<string[]> {
  if (!Array.isArray(v)) return { error: `${field} must be a list of names` };
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item.trim())
      return { error: `${field} must be a list of names` };
    const name = item.trim();
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > max) return { error: `Too many ${field} (max ${max})` };
  return out;
}

function objectList(
  v: unknown,
  field: string,
  max: number,
): FieldResult<unknown[]> {
  if (!Array.isArray(v)) return { error: `${field} must be a list` };
  if (v.length > max) return { error: `Too many ${field} (max ${max})` };
  return v;
}

// ── Item validators (shared with grants.ts) ─────────────────────────────────

export function validateConnections(
  v: unknown,
  ctx: ItemContext,
): FieldResult<string[]> {
  const list = nameList(v, "connections", MAX_CONNECTIONS);
  if (isFieldError(list) || !ctx.env) return list;
  for (const name of list) {
    const status = ctx.env.connection(name);
    if (status === "missing") return { error: `Unknown connection "${name}"` };
    if (status === "internal")
      return { error: `"${name}" is built in and cannot be granted` };
    if (status === "user-gated")
      return {
        error: `"${name}" is limited to named people; incident agents act as nobody`,
      };
  }
  return list;
}

export function validateDeniedTools(v: unknown): FieldResult<string[]> {
  const list = nameList(v, "deniedTools", MAX_DENIED_TOOLS);
  if (isFieldError(list)) return list;
  for (const name of list)
    if (
      !DENIED_TOOL.test(name) &&
      !(LOCAL_WORKSPACE_TOOL_IDS as readonly string[]).includes(name)
    )
      return { error: `Unknown tool name "${name}"` };
  return list;
}

export function validateMode(v: unknown): FieldResult<AccessMode> {
  return (ACCESS_MODES as readonly unknown[]).includes(v)
    ? (v as AccessMode)
    : { error: "Mode must be ask or code" };
}

export function validateRepos(
  v: unknown,
  ctx: ItemContext,
): FieldResult<string[]> {
  const list = nameList(v, "repos", MAX_REPOS);
  if (isFieldError(list) || !ctx.env) return list;
  for (const id of list)
    if (!ctx.env.repoExists(id)) return { error: `Unknown repo "${id}"` };
  return list;
}

export function validateRunners(
  v: unknown,
  ctx: ItemContext,
): FieldResult<string[]> {
  const list = nameList(v, "runners", MAX_RUNNERS);
  if (isFieldError(list) || !ctx.env) return list;
  const out: string[] = [];
  for (const ref of list) {
    const info = ctx.env.runner(ref);
    if (!info) return { error: `Unknown Runner "${ref}"` };
    if (!info.isolated)
      return {
        error: `Runner ${info.name} is not set up for isolated automation work`,
      };
    if (info.userRestricted)
      return {
        error: `Runner ${info.name} only accepts named people; incident agents act as nobody`,
      };
    if (!out.includes(info.id)) out.push(info.id);
  }
  return out;
}

/** A Runner that runs commands for incident agents (hosts and egress). */
function commandRunner(ref: string, ctx: ItemContext): FieldResult<string> {
  if (!ctx.env) return ref;
  const info = ctx.env.runner(ref);
  if (!info) return { error: `Unknown Runner "${ref}"` };
  if (!info.commands)
    return { error: `Runner ${info.name} does not accept commands` };
  if (info.userRestricted)
    return {
      error: `Runner ${info.name} only accepts named people; incident agents act as nobody`,
    };
  return info.id;
}

export function validateHosts(
  v: unknown,
  ctx: ItemContext,
): FieldResult<HostGrant[]> {
  const list = objectList(v, "hosts", MAX_HOSTS);
  if (isFieldError(list)) return list;
  const out: HostGrant[] = [];
  for (const [i, item] of list.entries()) {
    const path = ctx.path === undefined ? undefined : at(ctx.path, i);
    if (!isPlainObject(item)) return { error: "Each host must be an object" };
    const bad = unknownKey(item, ["runner", "ssh", "access"], "host", {
      path,
    });
    if (bad) return { error: bad };
    if (typeof item.runner !== "string" || !item.runner.trim())
      return { error: "Each host needs a Runner" };
    if (item.access !== "read-only")
      return {
        error:
          "Only read-only host access is available; changes go through actions",
      };
    let ssh: string | undefined;
    if (item.ssh !== undefined) {
      if (typeof item.ssh !== "string" || !SSH_ALIAS.test(item.ssh))
        return { error: `Invalid SSH alias "${String(item.ssh)}"` };
      ssh = item.ssh;
    }
    const runner = commandRunner(item.runner.trim(), ctx);
    if (isFieldError(runner)) return runner;
    const host: HostGrant = ssh
      ? { runner, ssh, access: "read-only" }
      : { runner, access: "read-only" };
    if (!out.some((h) => hostGrantKey(h) === hostGrantKey(host)))
      out.push(host);
  }
  return out;
}

/** A credential reference: exists and is not a login. Returns its id. */
export function validateCredentialRef(
  ref: unknown,
  ctx: ItemContext,
): FieldResult<string> {
  if (typeof ref !== "string" || !ref.trim())
    return { error: "Each credential needs a credential id" };
  if (!ctx.env) return ref.trim();
  const info = ctx.env.credential(ref.trim());
  if (!info) return { error: `Unknown credential "${ref.trim()}"` };
  if (info.kind === "login")
    return {
      error: `${info.service} is a login; logins are never lent to incident agents`,
    };
  return info.id;
}

export function validateGrantMode(
  v: unknown,
): FieldResult<CredentialGrantMode> {
  return (CREDENTIAL_GRANT_MODES as readonly unknown[]).includes(v)
    ? (v as CredentialGrantMode)
    : { error: "Credential mode must be once or standing" };
}

export function validateProfileCredentials(
  v: unknown,
  ctx: ItemContext,
): FieldResult<ProfileCredential[]> {
  const list = objectList(v, "credentials", MAX_CREDENTIALS);
  if (isFieldError(list)) return list;
  const out: ProfileCredential[] = [];
  for (const [i, item] of list.entries()) {
    const path = ctx.path === undefined ? undefined : at(ctx.path, i);
    if (!isPlainObject(item))
      return { error: "Each credential must be an object" };
    const bad = unknownKey(item, ["credential", "mode"], "credential", {
      path,
    });
    if (bad) return { error: bad };
    const mode = validateGrantMode(item.mode);
    if (isFieldError(mode)) return mode;
    const id = validateCredentialRef(item.credential, ctx);
    if (isFieldError(id)) return id;
    if (out.some((c) => c.credential === id))
      return { error: `Credential "${id}" is listed twice` };
    out.push({ credential: id, mode });
  }
  return out;
}

export function validateModel(
  v: unknown,
  ctx: ItemContext,
): FieldResult<string | null> {
  if (v === null) return null;
  if (typeof v !== "string" || !v.trim())
    return { error: "Model must be a model id or null" };
  if (!ctx.env) return v.trim();
  const id = ctx.env.model(v.trim());
  return id ?? { error: `Unknown model "${v.trim()}"` };
}

/** An IP literal, including the forms a URL parser reads as IPv4 (a numeric
 * or hex last label, as in `0x7f.1`). */
function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true;
  const last = host.split(".").pop() ?? "";
  return /^(0x[0-9a-f]*|[0-9]+)$/i.test(last);
}

/** Why a host may not be an egress host, or null; the host lower-cased
 *  with any IPv6 brackets removed. Saved hosts and the hosts a signal
 *  reaches by default both go through it. */
export function egressHostProblem(raw: string): {
  host: string;
  problem: string | null;
} {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    isIpLiteral(host) ||
    host === "localhost" ||
    PRIVATE_SUFFIXES.some((s) => host.endsWith(s))
  )
    return { host, problem: "Egress hosts must be public host names" };
  if (!HOST_NAME.test(host))
    return { host, problem: `Invalid egress host "${raw}"` };
  return { host, problem: null };
}

export function validateEgressHosts(v: unknown): FieldResult<string[]> {
  const list = nameList(v, "egress hosts", MAX_EGRESS_HOSTS);
  if (isFieldError(list)) return list;
  const out: string[] = [];
  for (const raw of list) {
    const { host, problem } = egressHostProblem(raw);
    if (problem) return { error: problem };
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export function validateProxyUrl(v: unknown): FieldResult<string> {
  if (typeof v !== "string" || !v.trim())
    return { error: "A proxy route needs a URL" };
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    return { error: "Invalid proxy URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { error: "Proxy URL must be http or https" };
  if (url.username || url.password)
    return { error: "Put proxy credentials in the keychain, not the URL" };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash)
    return { error: "Proxy URL cannot have a path, query or fragment" };
  if (/[?#]/.test(v.trim().slice(url.origin.length)))
    return { error: "Proxy URL cannot have a path, query or fragment" };
  return url.origin;
}

const EGRESS_KEYS = {
  server: ["route", "hosts"],
  runner: ["route", "runner", "hosts"],
  proxy: ["route", "url", "credential", "hosts"],
} as const;

export function validateEgressGrant(
  v: unknown,
  ctx: ItemContext,
): FieldResult<EgressGrant> {
  if (!isPlainObject(v)) return { error: "Egress must be an object or null" };
  const route = v.route;
  if (route !== "server" && route !== "runner" && route !== "proxy")
    return { error: "Egress route must be server, runner or proxy" };
  const bad = unknownKey(v, EGRESS_KEYS[route], "egress", ctx);
  if (bad) return { error: bad };
  let hosts: string[] | undefined;
  if (v.hosts !== undefined) {
    const list = validateEgressHosts(v.hosts);
    if (isFieldError(list)) return list;
    if (list.length) hosts = list;
  }
  const withHosts = <T extends object>(g: T): T & { hosts?: string[] } =>
    hosts ? { ...g, hosts } : g;
  if (route === "server") return withHosts({ route: "server" as const });
  if (route === "runner") {
    if (typeof v.runner !== "string" || !v.runner.trim())
      return { error: "A Runner route needs a Runner" };
    const runner = commandRunner(v.runner.trim(), ctx);
    if (isFieldError(runner)) return runner;
    return withHosts({ route: "runner" as const, runner });
  }
  const url = validateProxyUrl(v.url);
  if (isFieldError(url)) return url;
  if (v.credential === undefined)
    return withHosts({ route: "proxy" as const, url });
  const credential = validateCredentialRef(v.credential, ctx);
  if (isFieldError(credential)) return credential;
  return withHosts({ route: "proxy" as const, url, credential });
}

// ── Profiles ────────────────────────────────────────────────────────────────

type FieldValidator = (v: unknown, ctx: ItemContext) => FieldResult<unknown>;

const FIELD_VALIDATORS: Record<AccessProfileField, FieldValidator> = {
  connections: validateConnections,
  deniedTools: (v) => validateDeniedTools(v),
  mode: (v) => validateMode(v),
  repos: validateRepos,
  runners: validateRunners,
  hosts: validateHosts,
  credentials: validateProfileCredentials,
  model: validateModel,
  egress: (v, ctx) => (v === null ? null : validateEgressGrant(v, ctx)),
};

const VERIFIER_LOCK =
  "The verifier cannot edit the candidate, so its mode must be ask";

/** The role locks a profile or merged override must keep. */
export function roleLockProblem(
  role: IncidentAgentRole,
  fields: AccessProfileFields,
): string | null {
  if (role === "verifier" && fields.mode === "code") return VERIFIER_LOCK;
  return null;
}

function parseFields(
  input: unknown,
  opts: {
    role: IncidentAgentRole;
    partial: boolean;
    base?: CompleteAccessProfile;
  },
  ctx: ItemContext,
): FieldResult<AccessProfileFields> {
  if (!isPlainObject(input))
    return {
      error:
        ctx.path !== undefined
          ? `Field "${ctx.path}" must be an object`
          : "Profile fields must be an object",
    };
  const bad = unknownKey(input, ACCESS_PROFILE_FIELDS, null, ctx);
  if (bad) return { error: bad };
  if (!opts.partial && !opts.base) {
    const missing = missingKey(input, ACCESS_PROFILE_FIELDS, ctx.path);
    if (missing) return { error: missing };
  }
  const out: Record<string, unknown> = opts.partial
    ? {}
    : { ...(opts.base as CompleteAccessProfile) };
  for (const field of ACCESS_PROFILE_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const value = FIELD_VALIDATORS[field](input[field], {
      env: ctx.env,
      path: ctx.path === undefined ? undefined : at(ctx.path, field),
    });
    if (isFieldError(value))
      return ctx.path === undefined
        ? value
        : prefixed(at(ctx.path, field), value);
    out[field] = value;
  }
  const lock = roleLockProblem(opts.role, out as AccessProfileFields);
  if (lock) return { error: ctx.path ? `${ctx.path}: ${lock}` : lock };
  return out as AccessProfileFields;
}

/** A complete profile (absent fields from the role default) or, with
 * `partial`, an override holding only the fields it names. */
export function validateProfileFields(
  input: unknown,
  opts: { role: IncidentAgentRole; project: string; partial: boolean },
  env: AccessEnvironment,
): FieldResult<AccessProfileFields> {
  return parseFields(
    input,
    {
      role: opts.role,
      partial: opts.partial,
      base: opts.partial
        ? undefined
        : defaultRoleProfile(opts.role, opts.project),
    },
    { env },
  );
}

/** Field-level replace: an override never merges lists. */
export function mergeProfile(
  base: CompleteAccessProfile,
  override: AccessProfileFields | undefined,
): CompleteAccessProfile {
  const out = { ...base };
  if (!override) return out;
  for (const field of ACCESS_PROFILE_FIELDS)
    if (Object.hasOwn(override, field) && override[field] !== undefined)
      (out as Record<string, unknown>)[field] = override[field];
  return out;
}

// ── Within the project's grants ─────────────────────────────────────────────

/** The first way `fields` exceed `grants`, or null. Denied tools and the
 * model are never limited: a denial narrows and a model is no privilege. */
export function checkWithinGrants(
  fields: AccessProfileFields,
  grants: ProjectAccessGrants,
): string | null {
  for (const name of fields.connections ?? [])
    if (!grants.connections.includes(name))
      return `Connection "${name}" is not in the project's grants`;
  if (fields.mode && !modeWithin(fields.mode, grants.maxMode))
    return `Mode ${fields.mode} is wider than the project's grants`;
  for (const repo of fields.repos ?? [])
    if (!grants.repos.includes(repo))
      return `Repo "${repo}" is not in the project's grants`;
  for (const runner of fields.runners ?? [])
    if (!grants.runners.includes(runner))
      return `Runner "${runner}" is not in the project's grants`;
  const hostKeys = new Set(grants.hosts.map(hostGrantKey));
  for (const host of fields.hosts ?? [])
    if (!hostKeys.has(hostGrantKey(host)))
      return `Host ${hostGrantKey(host)} is not in the project's grants`;
  for (const cred of fields.credentials ?? []) {
    const grant = grants.credentials.find(
      (g) => g.credential === cred.credential,
    );
    if (!grant)
      return `Credential "${cred.credential}" is not in the project's grants`;
    if (!grantModeWithin(cred.mode, grant.mode))
      return `Credential "${cred.credential}" as ${cred.mode} is wider than the project's grant (${grant.mode})`;
  }
  if (fields.egress) {
    const key = egressRouteKey(fields.egress);
    const grant = grants.egress.find((g) => egressRouteKey(g) === key);
    if (!grant) return `Egress route ${key} is not in the project's grants`;
    if (
      fields.egress.route === "proxy" &&
      grant.route === "proxy" &&
      fields.egress.credential !== undefined &&
      fields.egress.credential !== grant.credential
    )
      return `Proxy credential "${fields.egress.credential}" is not in the project's grants`;
    if (grant.hosts?.length)
      for (const host of fields.egress.hosts ?? [])
        if (!grant.hosts.includes(host))
          return `Egress host ${host} is not in the project's grants for that route`;
  }
  return null;
}

// ── Stored documents ────────────────────────────────────────────────────────

const GRANT_KEYS = [
  "connections",
  "repos",
  "runners",
  "hosts",
  "credentials",
  "egress",
  "maxMode",
] as const;

const SETTINGS_KEYS = [
  "project",
  "revision",
  "grants",
  "profiles",
  "overrides",
  "updatedBy",
  "updatedAt",
] as const;

const OVERRIDE_KEYS = [
  "signalId",
  "role",
  "fields",
  "updatedBy",
  "updatedAt",
] as const;

function prefixed(path: string, r: { error: string }): { error: string } {
  return r.error.startsWith("Unknown field") ||
    r.error.startsWith("Missing field")
    ? r
    : { error: `${path}: ${r.error}` };
}

function str(v: unknown, path: string): FieldResult<string> {
  return typeof v === "string"
    ? v
    : { error: `Field "${path}" must be a string` };
}

/** Grants from a stored document: shape only. */
function parseStoredGrants(
  v: unknown,
  path: string,
): FieldResult<ProjectAccessGrants> {
  if (!isPlainObject(v)) return { error: `Field "${path}" must be an object` };
  const bad = unknownKey(v, GRANT_KEYS, null, { path });
  if (bad) return { error: bad };
  const missing = missingKey(v, GRANT_KEYS, path);
  if (missing) return { error: missing };
  const ctx = (key: string): ItemContext => ({ path: at(path, key) });
  const connections = validateConnections(v.connections, ctx("connections"));
  if (isFieldError(connections))
    return prefixed(at(path, "connections"), connections);
  const repos = validateRepos(v.repos, ctx("repos"));
  if (isFieldError(repos)) return prefixed(at(path, "repos"), repos);
  const runners = validateRunners(v.runners, ctx("runners"));
  if (isFieldError(runners)) return prefixed(at(path, "runners"), runners);
  const hosts = validateHosts(v.hosts, ctx("hosts"));
  if (isFieldError(hosts)) return prefixed(at(path, "hosts"), hosts);
  const credList = objectList(v.credentials, "credentials", MAX_CREDENTIALS);
  if (isFieldError(credList))
    return prefixed(at(path, "credentials"), credList);
  const credentials: ProjectCredentialGrant[] = [];
  for (const [i, item] of credList.entries()) {
    const p = at(at(path, "credentials"), i);
    if (!isPlainObject(item))
      return { error: `Field "${p}" must be an object` };
    const keys = ["credential", "mode", "grantedBy", "grantedAt"] as const;
    const badKey = unknownKey(item, [...keys, "grantedByLogin"], null, {
      path: p,
    });
    if (badKey) return { error: badKey };
    const miss = missingKey(item, keys, p);
    if (miss) return { error: miss };
    const credential = validateCredentialRef(item.credential, {});
    if (isFieldError(credential)) return prefixed(p, credential);
    const mode = validateGrantMode(item.mode);
    if (isFieldError(mode)) return prefixed(p, mode);
    const grantedBy = str(item.grantedBy, at(p, "grantedBy"));
    if (isFieldError(grantedBy)) return grantedBy;
    const grantedAt = str(item.grantedAt, at(p, "grantedAt"));
    if (isFieldError(grantedAt)) return grantedAt;
    let grantedByLogin: string | undefined;
    if (item.grantedByLogin !== undefined) {
      const login = str(item.grantedByLogin, at(p, "grantedByLogin"));
      if (isFieldError(login)) return login;
      grantedByLogin = login;
    }
    if (credentials.some((c) => c.credential === credential))
      return { error: `${p}: Credential "${credential}" is listed twice` };
    credentials.push({
      credential,
      mode,
      grantedBy,
      ...(grantedByLogin !== undefined ? { grantedByLogin } : {}),
      grantedAt,
    });
  }
  const egress = parseEgressGrants(v.egress, { path: at(path, "egress") });
  if (isFieldError(egress)) return prefixed(at(path, "egress"), egress);
  const maxMode = validateMode(v.maxMode);
  if (isFieldError(maxMode)) return prefixed(at(path, "maxMode"), maxMode);
  return {
    connections,
    repos,
    runners,
    hosts,
    credentials,
    egress,
    maxMode,
  };
}

/** The list of egress routes a project grants: at most ten, unique by route. */
export function parseEgressGrants(
  v: unknown,
  ctx: ItemContext,
): FieldResult<EgressGrant[]> {
  const list = objectList(v, "egress routes", MAX_EGRESS_ROUTES);
  if (isFieldError(list)) return list;
  const out: EgressGrant[] = [];
  for (const [i, item] of list.entries()) {
    const grant = validateEgressGrant(item, {
      env: ctx.env,
      path: ctx.path === undefined ? undefined : at(ctx.path, i),
    });
    if (isFieldError(grant)) return grant;
    const key = egressRouteKey(grant);
    if (out.some((g) => egressRouteKey(g) === key))
      return { error: `Egress route ${key} is listed twice` };
    out.push(grant);
  }
  return out;
}

/** Strict structural parse of a stored settings document. */
export function parseStoredSettings(
  value: unknown,
): FieldResult<IncidentAccessSettings> {
  if (!isPlainObject(value)) return { error: "Settings must be an object" };
  const bad = unknownKey(value, SETTINGS_KEYS, null, { path: "" });
  if (bad) return { error: bad };
  const missing = missingKey(value, SETTINGS_KEYS, "");
  if (missing) return { error: missing };
  const project = str(value.project, "project");
  if (isFieldError(project)) return project;
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    return { error: 'Field "revision" must be a whole number' };
  const updatedBy = str(value.updatedBy, "updatedBy");
  if (isFieldError(updatedBy)) return updatedBy;
  const updatedAt = str(value.updatedAt, "updatedAt");
  if (isFieldError(updatedAt)) return updatedAt;
  const grants = parseStoredGrants(value.grants, "grants");
  if (isFieldError(grants)) return grants;

  if (!isPlainObject(value.profiles))
    return { error: 'Field "profiles" must be an object' };
  const roleBad = unknownKey(value.profiles, INCIDENT_AGENT_ROLES, null, {
    path: "profiles",
  });
  if (roleBad) return { error: roleBad };
  const roleMissing = missingKey(
    value.profiles,
    INCIDENT_AGENT_ROLES,
    "profiles",
  );
  if (roleMissing) return { error: roleMissing };
  const profiles = {} as Record<IncidentAgentRole, CompleteAccessProfile>;
  for (const role of INCIDENT_AGENT_ROLES) {
    const fields = parseFields(
      value.profiles[role],
      { role, partial: false },
      { path: `profiles.${role}` },
    );
    if (isFieldError(fields)) return fields;
    profiles[role] = fields as CompleteAccessProfile;
  }

  if (!Array.isArray(value.overrides))
    return { error: 'Field "overrides" must be a list' };
  if (value.overrides.length > MAX_OVERRIDES)
    return { error: `Too many signal overrides (max ${MAX_OVERRIDES})` };
  const overrides: SignalAccessOverride[] = [];
  for (const [i, item] of value.overrides.entries()) {
    const p = `overrides.${i}`;
    if (!isPlainObject(item))
      return { error: `Field "${p}" must be an object` };
    const badKey = unknownKey(item, OVERRIDE_KEYS, null, { path: p });
    if (badKey) return { error: badKey };
    const miss = missingKey(item, OVERRIDE_KEYS, p);
    if (miss) return { error: miss };
    if (!isIncidentAgentRole(item.role))
      return { error: `${p}: Unknown agent role "${String(item.role)}"` };
    const signalId = str(item.signalId, at(p, "signalId"));
    if (isFieldError(signalId)) return signalId;
    const by = str(item.updatedBy, at(p, "updatedBy"));
    if (isFieldError(by)) return by;
    const when = str(item.updatedAt, at(p, "updatedAt"));
    if (isFieldError(when)) return when;
    const fields = parseFields(
      item.fields,
      { role: item.role, partial: true },
      { path: at(p, "fields") },
    );
    if (isFieldError(fields)) return fields;
    if (overrides.some((o) => o.signalId === signalId && o.role === item.role))
      return { error: `${p}: Override listed twice` };
    overrides.push({
      signalId,
      role: item.role,
      fields,
      updatedBy: by,
      updatedAt: when,
    });
  }
  return {
    project,
    revision: value.revision,
    grants,
    profiles,
    overrides,
    updatedBy,
    updatedAt,
  };
}
