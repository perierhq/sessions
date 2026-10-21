// Incident access settings as the settings page edits them: field labels,
// what a profile may pick from (never wider than the project's grants, spec
// 3.6a), counts and summaries, and the drafts the preview resolves.

import {
  ACCESS_PROFILE_FIELDS,
  type AccessMode,
  type AccessProfileField,
  type AccessProfileFields,
  type CompleteAccessProfile,
  type CredentialGrantMode,
  type EgressGrant,
  type EgressRoute,
  type HostGrant,
  type IncidentAgentRole,
  type ProjectAccessGrants,
  type SignalAccessOverride,
} from "../../../shared/incident-access";
import {
  describeIndependence,
  type Independence,
} from "../../../shared/incident-response";

export const FIELD_LABELS: Record<AccessProfileField, string> = {
  connections: "Connections",
  deniedTools: "Blocked tools",
  mode: "Mode",
  repos: "Repositories",
  runners: "Runners",
  hosts: "Hosts",
  credentials: "Credentials",
  model: "Model",
  egress: "Network route",
};

export const ROLE_LABELS: Record<IncidentAgentRole, string> = {
  investigator: "Investigator",
  verifier: "Verifier",
};

export const MODE_LABELS: Record<AccessMode, string> = {
  ask: "Read-only",
  code: "Can edit",
};

export const GRANT_MODE_LABELS: Record<CredentialGrantMode, string> = {
  once: "Once",
  standing: "Standing",
};

/** The OptionSelect value for "pick for me". */
export const AUTOMATIC = "auto";

/** The labels of the fields an override sets, in profile order. */
export function overrideSummary(o: SignalAccessOverride): string {
  const set = ACCESS_PROFILE_FIELDS.filter(
    (field) => Object.hasOwn(o.fields, field) && o.fields[field] !== undefined,
  );
  return set.length
    ? set.map((field) => FIELD_LABELS[field]).join(", ")
    : "Nothing yet";
}

export interface GrantedChoices {
  connections: string[];
  repos: string[];
  runners: string[];
  hosts: HostGrant[];
  credentials: Array<{ credential: string; maxMode: CredentialGrantMode }>;
  egress: EgressGrant[];
  maxMode: AccessMode;
}

/** What a profile or override may pick from: exactly the grants. */
export function grantedChoices(grants: ProjectAccessGrants): GrantedChoices {
  return {
    connections: [...grants.connections],
    repos: [...grants.repos],
    runners: [...grants.runners],
    hosts: [...grants.hosts],
    credentials: grants.credentials.map((c) => ({
      credential: c.credential,
      maxMode: c.mode,
    })),
    egress: [...grants.egress],
    maxMode: grants.maxMode,
  };
}

/** `list` with `item` removed when one with its key is there, else added. */
export function toggleIn<T>(list: T[], item: T, key: (t: T) => string): T[] {
  const k = key(item);
  return list.some((t) => key(t) === k)
    ? list.filter((t) => key(t) !== k)
    : [...list, item];
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The grants as counts: `2 connections · 1 host · 1 credential`. */
export function grantsSummary(grants: ProjectAccessGrants): string {
  const parts = [
    [grants.connections.length, "connection", "connections"],
    [grants.repos.length, "repository", "repositories"],
    [grants.runners.length, "Runner", "Runners"],
    [grants.hosts.length, "host", "hosts"],
    [grants.credentials.length, "credential", "credentials"],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => counted(n, one, many));
  return text.length ? text.join(" · ") : "Nothing beyond its own server";
}

export function textToList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function listToText(list: string[]): string {
  return list.join(", ");
}

/** A network route in words. */
export function egressLabel(
  route: EgressRoute,
  runnerName: (id: string) => string,
): string {
  switch (route.route) {
    case "server":
      return "This server";
    case "runner":
      return `Through ${runnerName(route.runner)}`;
    case "proxy": {
      let host = route.url;
      try {
        host = new URL(route.url).host;
      } catch {
        // Shown as typed.
      }
      return `Proxy ${host}`;
    }
  }
}

/** The profile an override's agent gets: each field the override sets,
 *  else the role's. A role's own (complete) profile comes back as it is. */
export function effectiveProfile(
  role: CompleteAccessProfile,
  fields: AccessProfileFields,
): CompleteAccessProfile {
  return {
    connections: fields.connections ?? role.connections,
    deniedTools: fields.deniedTools ?? role.deniedTools,
    mode: fields.mode ?? role.mode,
    repos: fields.repos ?? role.repos,
    runners: fields.runners ?? role.runners,
    hosts: fields.hosts ?? role.hosts,
    credentials: fields.credentials ?? role.credentials,
    model: fields.model === undefined ? role.model : fields.model,
    egress: fields.egress === undefined ? role.egress : fields.egress,
  };
}

/** An override's field following the role (`inherit`) or holding its own
 *  value, which starts as the role's. */
export function inheritField(
  fields: AccessProfileFields,
  field: AccessProfileField,
  inherit: boolean,
  role: CompleteAccessProfile,
): AccessProfileFields {
  const next: AccessProfileFields = { ...fields };
  if (inherit) {
    delete next[field];
    return next;
  }
  return { ...next, [field]: structuredClone(role[field]) };
}

/** The preview's draft for a role profile (no signal) or a signal's
 *  override. */
export function previewDraft(
  role: IncidentAgentRole,
  signalId: string | null,
  fields: AccessProfileFields,
):
  | { profiles: Partial<Record<IncidentAgentRole, AccessProfileFields>> }
  | {
      overrides: Array<{
        role: IncidentAgentRole;
        signalId: string;
        fields: AccessProfileFields;
      }>;
    } {
  return signalId
    ? { overrides: [{ role, signalId, fields }] }
    : { profiles: { [role]: fields } };
}

/** `Automatic`, the catalog's models, and the stored one when the catalog
 *  no longer lists it. */
export function modelChoices(
  models: Array<{ id: string; label: string }>,
  current: string | null | undefined,
): Array<{ value: string; label: string }> {
  const options = [
    { value: AUTOMATIC, label: "Automatic" },
    ...models.map((m) => ({ value: m.id, label: m.label })),
  ];
  if (current && !models.some((m) => m.id === current))
    options.push({ value: current, label: current });
  return options;
}

/** One field of a profile in words, for a field an override leaves to
 *  its role. */
export function describeField(
  field: AccessProfileField,
  profile: CompleteAccessProfile,
  names: {
    runner: (id: string) => string;
    credential: (id: string) => string;
    repo: (id: string) => string;
    model: (id: string) => string;
  },
): string {
  const list = (items: string[]) => (items.length ? items.join(", ") : "None");
  switch (field) {
    case "connections":
      return list(profile.connections);
    case "deniedTools":
      return list(profile.deniedTools);
    case "mode":
      return MODE_LABELS[profile.mode];
    case "repos":
      return list(profile.repos.map(names.repo));
    case "runners":
      return list(profile.runners.map(names.runner));
    case "hosts":
      return list(
        profile.hosts.map((h) =>
          h.ssh
            ? `${names.runner(h.runner)} › ${h.ssh}`
            : names.runner(h.runner),
        ),
      );
    case "credentials":
      return list(
        profile.credentials.map(
          (c) =>
            `${names.credential(c.credential)} (${GRANT_MODE_LABELS[c.mode].toLowerCase()})`,
        ),
      );
    case "model":
      return profile.model ? names.model(profile.model) : "Automatic";
    case "egress":
      return profile.egress
        ? egressLabel(profile.egress, names.runner)
        : "None";
  }
}

/** An access summary under its role's own title: without the leading
 *  role name the server's summary starts with. */
export function summaryWithoutRole(
  summary: string,
  role: IncidentAgentRole,
): string {
  const prefix = `${ROLE_LABELS[role]} · `;
  if (!summary.startsWith(prefix)) return summary;
  const rest = summary.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** `describeIndependence` without its `Verifier · ` prefix. */
export function independenceText(i: Independence): string {
  return describeIndependence(i).replace(/^Verifier · /, "");
}
