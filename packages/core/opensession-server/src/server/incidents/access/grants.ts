// Strict validation of a project's incident access grants (the ceiling every
// profile and override must fit), including who may lend a credential:
// only its owner (signed in) for a personal one, any signed-in teammate for a
// workspace one, nobody for a login. Narrowing and removal need no authority.
import {
  type CredentialGrantMode,
  grantModeWithin,
  type ProjectAccessGrants,
  type ProjectCredentialGrant,
} from "../../../shared/incident-access";
import type { AccessEnvironment } from "./environment";
import {
  type FieldResult,
  isFieldError,
  isPlainObject,
  MAX_CREDENTIALS,
  missingKey,
  parseEgressGrants,
  unknownKey,
  validateConnections,
  validateCredentialRef,
  validateGrantMode,
  validateHosts,
  validateMode,
  validateRepos,
  validateRunners,
} from "./fields";

export interface AccessActor {
  name: string;
  /** A GitHub web sign-in, not a claimed name. */
  verified: boolean;
  /** The verified sign-in's GitHub login; lending a personal credential
   *  is checked against it, never against `name`. */
  login?: string;
}

export interface CredentialGrantChange {
  credential: string;
  change: "granted" | "widened" | "removed";
  mode?: CredentialGrantMode;
}

const GRANT_KEYS = [
  "connections",
  "repos",
  "runners",
  "hosts",
  "credentials",
  "egress",
  "maxMode",
] as const;

const SIGN_IN = "Sign in to grant credentials to incident agents";

export function validateGrants(
  input: unknown,
  ctx: {
    project: string;
    actor: AccessActor;
    previous: ProjectAccessGrants;
    now: string;
  },
  env: AccessEnvironment,
): FieldResult<{
  grants: ProjectAccessGrants;
  credentialChanges: CredentialGrantChange[];
}> {
  if (!isPlainObject(input)) return { error: "Grants must be an object" };
  const bad = unknownKey(input, GRANT_KEYS, null, {});
  if (bad) return { error: bad };
  const missing = missingKey(input, GRANT_KEYS, undefined);
  if (missing) return { error: missing };
  const item = { env };

  const connections = validateConnections(input.connections, item);
  if (isFieldError(connections)) return connections;
  const repos = validateRepos(input.repos, item);
  if (isFieldError(repos)) return repos;
  const runners = validateRunners(input.runners, item);
  if (isFieldError(runners)) return runners;
  const hosts = validateHosts(input.hosts, item);
  if (isFieldError(hosts)) return hosts;

  if (!Array.isArray(input.credentials))
    return { error: "credentials must be a list" };
  if (input.credentials.length > MAX_CREDENTIALS)
    return { error: `Too many credentials (max ${MAX_CREDENTIALS})` };
  const credentials: ProjectCredentialGrant[] = [];
  const changes: CredentialGrantChange[] = [];
  for (const entry of input.credentials) {
    if (!isPlainObject(entry))
      return { error: "Each credential must be an object" };
    // grantedBy and grantedAt are stamped here, never taken from the caller.
    const badKey = unknownKey(
      entry,
      ["credential", "mode", "grantedBy", "grantedByLogin", "grantedAt"],
      "credential",
      {},
    );
    if (badKey) return { error: badKey };
    const mode = validateGrantMode(entry.mode);
    if (isFieldError(mode)) return mode;
    const id = validateCredentialRef(entry.credential, item);
    if (isFieldError(id)) return id;
    if (credentials.some((c) => c.credential === id))
      return { error: `Credential "${id}" is listed twice` };
    const previous = ctx.previous.credentials.find((c) => c.credential === id);
    if (previous && grantModeWithin(mode, previous.mode)) {
      // Carried or narrowed: keeps who granted it and when.
      credentials.push({
        credential: id,
        mode,
        grantedBy: previous.grantedBy,
        ...(previous.grantedByLogin !== undefined
          ? { grantedByLogin: previous.grantedByLogin }
          : {}),
        grantedAt: previous.grantedAt,
      });
      continue;
    }
    const info = env.credential(id);
    if (!info) return { error: `Unknown credential "${id}"` };
    const login = ctx.actor.verified ? ctx.actor.login?.trim() : undefined;
    if (!login) return { error: SIGN_IN };
    if (info.scope === "personal" && !env.isOwner(login, info.owner))
      return {
        error: `Only ${info.owner} can grant ${info.service} to incident agents`,
      };
    credentials.push({
      credential: id,
      mode,
      grantedBy: ctx.actor.name,
      grantedByLogin: login,
      grantedAt: ctx.now,
    });
    changes.push({
      credential: id,
      change: previous ? "widened" : "granted",
      mode,
    });
  }
  for (const previous of ctx.previous.credentials)
    if (!credentials.some((c) => c.credential === previous.credential))
      changes.push({ credential: previous.credential, change: "removed" });

  const egress = parseEgressGrants(input.egress, item);
  if (isFieldError(egress)) return egress;
  for (const route of egress) {
    if (route.route !== "proxy" || route.credential === undefined) continue;
    if (!credentials.some((c) => c.credential === route.credential))
      return {
        error: `Proxy credential "${route.credential}" is not in the project's grants`,
      };
    const info = env.credential(route.credential);
    if (!info) return { error: `Unknown credential "${route.credential}"` };
    const proxyHost = new URL(route.url).hostname;
    if (info.host !== proxyHost)
      return { error: `${info.service} is not for ${proxyHost}` };
    if (info.injectionHeader.toLowerCase() !== "proxy-authorization")
      return {
        error: `${info.service} must inject Proxy-Authorization to be used as a proxy credential`,
      };
  }

  const maxMode = validateMode(input.maxMode);
  if (isFieldError(maxMode)) return maxMode;

  changes.sort((a, b) =>
    a.credential < b.credential ? -1 : a.credential > b.credential ? 1 : 0,
  );
  return {
    grants: {
      connections,
      repos,
      runners,
      hosts,
      credentials,
      egress,
      maxMode,
    },
    credentialChanges: changes,
  };
}
