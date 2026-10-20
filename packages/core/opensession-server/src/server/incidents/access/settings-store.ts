// Incident access settings, one document per project on the `incident-access`
// catalog namespace: the project's grants, a complete profile per role and
// per-signal overrides. Written only through the settings API, with revisions
// for optimistic concurrency, an audit line per change (field names only)
// and change listeners. Nothing here is read from a repository.
import {
  ACCESS_PROFILE_FIELDS,
  type AccessProfileFields,
  type CompleteAccessProfile,
  type CredentialInfo,
  defaultIncidentAccessSettings,
  type IncidentAccessSettings,
  type IncidentAccessSettingsView,
  type IncidentAgentRole,
  isIncidentAgentRole,
  type ProjectAccessGrants,
  type SignalAccessOverride,
} from "../../../shared/incident-access";
import { catalogDocuments } from "../../catalog-documents";
import { incidentAudit } from "../audit-sink";
import { getSignal } from "../signal-store";
import { type AccessEnvironment, loadAccessEnvironment } from "./environment";
import {
  checkWithinGrants,
  isFieldError,
  MAX_OVERRIDES,
  mergeProfile,
  parseStoredSettings,
  roleLockProblem,
  validateProfileFields,
} from "./fields";
import {
  type AccessActor,
  type CredentialGrantChange,
  validateGrants,
} from "./grants";

export const INCIDENT_ACCESS_NAMESPACE = "incident-access";

export class AccessSettingsError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 500,
  ) {
    super(message);
    this.name = "AccessSettingsError";
  }
}

export type AccessChange =
  | { kind: "grants"; grants: unknown }
  | { kind: "profile"; role: IncidentAgentRole; fields: unknown }
  | {
      kind: "override";
      role: IncidentAgentRole;
      signalId: string;
      fields: unknown;
    }
  | { kind: "delete-override"; role: IncidentAgentRole; signalId: string }
  | { kind: "reset" };

export type AccessWriteError = { error: string; status: 400 | 404 | 409 | 500 };

// Bound on first use, never at import: the catalog client is a live effect.
let documents: ReturnType<typeof catalogDocuments> | undefined;
function accessDocuments(): ReturnType<typeof catalogDocuments> {
  return (documents ??= catalogDocuments(INCIDENT_ACCESS_NAMESPACE));
}

const listeners = new Set<(project: string) => void>();

export function onIncidentAccessChange(
  listener: (project: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(project: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(project);
    } catch (error) {
      console.warn("[incident-access] change listener failed:", error);
    }
  }
}

type StoredState =
  | { settings: IncidentAccessSettings; isDefault: boolean }
  | { unreadable: string };

function unreadableMessage(project: string, reason: string): string {
  return `Stored access settings for ${project} are unreadable: ${reason}`;
}

function readStored(project: string, raw: unknown, now: string): StoredState {
  if (raw === null || raw === undefined)
    return {
      settings: defaultIncidentAccessSettings(project, now),
      isDefault: true,
    };
  const parsed = parseStoredSettings(raw);
  if (isFieldError(parsed)) return { unreadable: parsed.error };
  if (parsed.project !== project)
    return { unreadable: `it names project ${parsed.project}` };
  return { settings: parsed, isDefault: false };
}

function view(
  settings: IncidentAccessSettings,
  isDefault: boolean,
  env: AccessEnvironment,
): IncidentAccessSettingsView {
  const credentialInfo: Record<string, CredentialInfo> = {};
  for (const grant of settings.grants.credentials) {
    const info = env.credential(grant.credential);
    if (!info || info.id !== grant.credential) continue;
    credentialInfo[grant.credential] = {
      service: info.service,
      host: info.host,
      owner: info.owner,
      scope: info.scope,
      kind: info.kind,
    };
  }
  return { ...settings, isDefault, credentialInfo };
}

/** The stored settings, or the defaults when none are stored. */
export async function getIncidentAccessSettings(
  project: string,
): Promise<IncidentAccessSettingsView> {
  const env = await loadAccessEnvironment();
  if (!env.projectExists(project))
    throw new AccessSettingsError(`Unknown project "${project}"`, 404);
  const state = readStored(
    project,
    await accessDocuments().get(project),
    new Date().toISOString(),
  );
  if ("unreadable" in state)
    throw new AccessSettingsError(
      unreadableMessage(project, state.unreadable),
      500,
    );
  return view(state.settings, state.isDefault, env);
}

// ── Applying a change (pure) ────────────────────────────────────────────────

/** Keys sorted at every level, so equal settings encode equally. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

function sameSettings(
  a: IncidentAccessSettings,
  b: IncidentAccessSettings,
): boolean {
  const strip = (s: IncidentAccessSettings) => ({
    project: s.project,
    grants: s.grants,
    profiles: s.profiles,
    overrides: s.overrides,
  });
  return canonical(strip(a)) === canonical(strip(b));
}

function changedKeys(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  keys: readonly string[],
): string[] {
  return keys
    .filter((k) => canonical(before?.[k]) !== canonical(after?.[k]))
    .sort();
}

const GRANT_FIELDS: Array<keyof ProjectAccessGrants> = [
  "connections",
  "repos",
  "runners",
  "hosts",
  "credentials",
  "egress",
  "maxMode",
];

/** Every profile and override inside `grants`, or the first that is not. */
function allWithinGrants(settings: IncidentAccessSettings): string | null {
  for (const role of ["investigator", "verifier"] as const) {
    const violation = checkWithinGrants(
      settings.profiles[role],
      settings.grants,
    );
    if (violation) return `The ${role} profile: ${violation}`;
  }
  for (const o of settings.overrides) {
    const violation = checkWithinGrants(o.fields, settings.grants);
    if (violation)
      return `The ${o.role} override for ${o.signalId}: ${violation}`;
  }
  return null;
}

interface Applied {
  /** null: the document is deleted (reset). */
  next: IncidentAccessSettings | null;
  fields: string[];
  credentialChanges: CredentialGrantChange[];
}

const roleError = (role: unknown): AccessWriteError => ({
  error: `Unknown agent role "${String(role)}"`,
  status: 400,
});

/**
 * Apply one change to `current` in memory. `checkGrants: false` defers the
 * within-grants check of profiles and overrides to the caller (a draft
 * applies several changes and checks once at the end).
 */
export function applyAccessChange(
  current: IncidentAccessSettings,
  change: AccessChange,
  actor: AccessActor,
  env: AccessEnvironment,
  now: string,
  opts: { checkGrants?: boolean } = {},
): Applied | AccessWriteError {
  const checkGrants = opts.checkGrants !== false;
  const by = actor.name || "Anonymous";
  switch (change.kind) {
    case "reset":
      return {
        next: null,
        fields: [],
        credentialChanges: current.grants.credentials.map((c) => ({
          credential: c.credential,
          change: "removed" as const,
        })),
      };
    case "grants": {
      const out = validateGrants(
        change.grants,
        { project: current.project, actor, previous: current.grants, now },
        env,
      );
      if (isFieldError(out)) return { error: out.error, status: 400 };
      const next = { ...current, grants: out.grants };
      if (checkGrants) {
        const violation = allWithinGrants(next);
        if (violation) return { error: violation, status: 400 };
      }
      return {
        next,
        fields: changedKeys(
          current.grants as unknown as Record<string, unknown>,
          out.grants as unknown as Record<string, unknown>,
          GRANT_FIELDS,
        ),
        credentialChanges: out.credentialChanges,
      };
    }
    case "profile": {
      if (!isIncidentAgentRole(change.role)) return roleError(change.role);
      const role = change.role;
      const fields = validateProfileFields(
        change.fields,
        { role, project: current.project, partial: false },
        env,
      );
      if (isFieldError(fields))
        return { error: `The ${role} profile: ${fields.error}`, status: 400 };
      if (checkGrants) {
        const violation = checkWithinGrants(fields, current.grants);
        if (violation)
          return { error: `The ${role} profile: ${violation}`, status: 400 };
      }
      const profile = fields as CompleteAccessProfile;
      return {
        next: {
          ...current,
          profiles: { ...current.profiles, [role]: profile },
        },
        fields: changedKeys(
          current.profiles[role] as unknown as Record<string, unknown>,
          profile as unknown as Record<string, unknown>,
          ACCESS_PROFILE_FIELDS,
        ),
        credentialChanges: [],
      };
    }
    case "override": {
      if (!isIncidentAgentRole(change.role)) return roleError(change.role);
      const role = change.role;
      const prefix = `The ${role} override for ${change.signalId}`;
      const fields = validateProfileFields(
        change.fields,
        { role, project: current.project, partial: true },
        env,
      );
      if (isFieldError(fields))
        return { error: `${prefix}: ${fields.error}`, status: 400 };
      if (checkGrants) {
        const violation = checkWithinGrants(fields, current.grants);
        if (violation) return { error: `${prefix}: ${violation}`, status: 400 };
      }
      const lock = roleLockProblem(
        role,
        mergeProfile(current.profiles[role], fields),
      );
      if (lock) return { error: `${prefix}: ${lock}`, status: 400 };
      const index = current.overrides.findIndex(
        (o) => o.role === role && o.signalId === change.signalId,
      );
      const previous = index >= 0 ? current.overrides[index] : undefined;
      const fieldsChanged = changedKeys(
        previous?.fields as Record<string, unknown> | undefined,
        fields as Record<string, unknown>,
        ACCESS_PROFILE_FIELDS,
      );
      if (previous && !fieldsChanged.length)
        return { next: current, fields: [], credentialChanges: [] };
      const record: SignalAccessOverride = {
        signalId: change.signalId,
        role,
        fields: fields as AccessProfileFields,
        updatedBy: by,
        updatedAt: now,
      };
      const overrides = [...current.overrides];
      if (index >= 0) overrides[index] = record;
      else {
        if (overrides.length >= MAX_OVERRIDES)
          return {
            error: `Too many signal overrides (max ${MAX_OVERRIDES})`,
            status: 400,
          };
        overrides.push(record);
      }
      return {
        next: { ...current, overrides },
        fields: fieldsChanged,
        credentialChanges: [],
      };
    }
    case "delete-override": {
      if (!isIncidentAgentRole(change.role)) return roleError(change.role);
      const overrides = current.overrides.filter(
        (o) => !(o.role === change.role && o.signalId === change.signalId),
      );
      if (overrides.length === current.overrides.length)
        return { error: "Not found", status: 404 };
      return {
        next: { ...current, overrides },
        fields: [],
        credentialChanges: [],
      };
    }
    default:
      return {
        error: `Unknown change "${String((change as { kind?: unknown }).kind)}"`,
        status: 400,
      };
  }
}

async function signalProblem(
  project: string,
  signalId: unknown,
): Promise<AccessWriteError | null> {
  const signal =
    typeof signalId === "string" ? await getSignal(signalId) : null;
  if (!signal)
    return { error: `Unknown signal "${String(signalId)}"`, status: 400 };
  if (signal.project !== project)
    return {
      error: `Signal ${signal.id} belongs to another project`,
      status: 400,
    };
  return null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Thrown out of the catalog mutate to end it without a write. */
class EndWithoutWrite {
  constructor(readonly result: IncidentAccessSettingsView | AccessWriteError) {}
}

export async function updateIncidentAccess(
  project: string,
  change: AccessChange,
  actor: AccessActor,
  opts: { expectedRevision?: number } = {},
): Promise<IncidentAccessSettingsView | AccessWriteError> {
  const env = await loadAccessEnvironment();
  if (!env.projectExists(project))
    return { error: `Unknown project "${project}"`, status: 404 };
  if (
    (change.kind === "override" || change.kind === "delete-override") &&
    !isIncidentAgentRole(change.role)
  )
    return roleError(change.role);
  if (change.kind === "override") {
    const problem = await signalProblem(project, change.signalId);
    if (problem) return problem;
  }
  const now = new Date().toISOString();
  const by = actor.name || "Anonymous";
  let committed:
    | {
        before: IncidentAccessSettings;
        next: IncidentAccessSettings | null;
        applied: Applied;
      }
    | undefined;
  try {
    await accessDocuments().update(project, (raw) => {
      const state = readStored(project, raw, now);
      if ("unreadable" in state) {
        if (change.kind !== "reset")
          throw new EndWithoutWrite({
            error: `${unreadableMessage(project, state.unreadable)}. Reset them to start over.`,
            status: 500,
          });
        committed = {
          before: defaultIncidentAccessSettings(project, now),
          next: null,
          applied: { next: null, fields: [], credentialChanges: [] },
        };
        return null;
      }
      const current = state.settings;
      if (
        opts.expectedRevision !== undefined &&
        opts.expectedRevision !== current.revision
      )
        throw new EndWithoutWrite({
          error: "Access settings changed since you loaded them",
          status: 409,
        });
      const applied = applyAccessChange(current, change, actor, env, now);
      if ("error" in applied && "status" in applied)
        throw new EndWithoutWrite(applied);
      const result = applied as Applied;
      const unchanged =
        result.next === null
          ? state.isDefault
          : sameSettings(current, result.next);
      if (unchanged)
        throw new EndWithoutWrite(view(current, state.isDefault, env));
      const next =
        result.next === null
          ? null
          : {
              ...result.next,
              revision: current.revision + 1,
              updatedBy: by,
              updatedAt: now,
            };
      committed = { before: current, next, applied: result };
      return next;
    });
  } catch (error) {
    if (error instanceof EndWithoutWrite) return error.result;
    throw error;
  }
  if (!committed) throw new Error("incident access update did not commit");
  const { before, next, applied } = committed;
  incidentAudit({
    kind: "incident_access_updated",
    project,
    by,
    change: change.kind,
    ...("role" in change ? { role: change.role } : {}),
    ...("signalId" in change ? { signalId: change.signalId } : {}),
    fields: applied.fields,
  });
  const credentialChanges =
    change.kind === "reset"
      ? before.grants.credentials.map((c) => ({
          credential: c.credential,
          change: "removed" as const,
        }))
      : applied.credentialChanges;
  for (const c of credentialChanges) {
    if (c.change === "removed")
      incidentAudit({
        kind: "incident_access_credential_removed",
        project,
        credentialId: c.credential,
        by,
      });
    else
      incidentAudit({
        kind: "incident_access_credential_granted",
        project,
        credentialId: c.credential,
        mode: c.mode,
        by,
      });
  }
  notify(project);
  return next === null
    ? view(defaultIncidentAccessSettings(project, now), true, env)
    : view(next, false, env);
}

/**
 * Validate a draft against the current settings in memory: grants first,
 * then profiles and overrides, then every profile and override against the
 * drafted grants. Nothing is written or audited.
 */
export async function draftIncidentAccess(
  project: string,
  draft: {
    grants?: unknown;
    profiles?: Partial<Record<IncidentAgentRole, unknown>>;
    overrides?: Array<{ role: unknown; signalId: unknown; fields: unknown }>;
  },
  actor: AccessActor,
): Promise<IncidentAccessSettings | AccessWriteError> {
  const env = await loadAccessEnvironment();
  if (!env.projectExists(project))
    return { error: `Unknown project "${project}"`, status: 404 };
  const now = new Date().toISOString();
  const state = readStored(project, await accessDocuments().get(project), now);
  if ("unreadable" in state)
    return {
      error: `${unreadableMessage(project, state.unreadable)}. Reset them to start over.`,
      status: 500,
    };
  const changes: AccessChange[] = [];
  if (draft.grants !== undefined)
    changes.push({ kind: "grants", grants: draft.grants });
  if (draft.profiles !== undefined) {
    if (
      !draft.profiles ||
      typeof draft.profiles !== "object" ||
      Array.isArray(draft.profiles)
    )
      return { error: "Profiles must be an object", status: 400 };
    for (const [role, fields] of Object.entries(draft.profiles)) {
      if (!isIncidentAgentRole(role)) return roleError(role);
      changes.push({ kind: "profile", role, fields });
    }
  }
  if (draft.overrides !== undefined) {
    if (!Array.isArray(draft.overrides))
      return { error: "Overrides must be a list", status: 400 };
    for (const o of draft.overrides) {
      if (!o || typeof o !== "object")
        return { error: "Each override must be an object", status: 400 };
      if (!isIncidentAgentRole(o.role)) return roleError(o.role);
      const problem = await signalProblem(project, o.signalId);
      if (problem) return problem;
      changes.push({
        kind: "override",
        role: o.role,
        signalId: o.signalId as string,
        fields: o.fields,
      });
    }
  }
  let settings = state.settings;
  for (const change of changes) {
    const applied = applyAccessChange(settings, change, actor, env, now, {
      checkGrants: false,
    });
    if ("status" in applied) return applied;
    if (applied.next) settings = applied.next;
  }
  const violation = allWithinGrants(settings);
  if (violation) return { error: violation, status: 400 };
  return settings;
}
