// The project page's access table: one row per capability, one column per
// role. The You column is computed from what interactive sessions get
// today, never stored. Keychain and production cells apply only to the
// incident agents; for Automations and Reviews they read "no" and can't be
// edited. Pure: plain data in, view out.

import type { CredentialInfo } from "../../shared/incident-access";
import {
  ANY_WEBSITE_HOST,
  type AccessCellValue,
  type AccessCellView,
  type AccessGroupId,
  type AccessRowView,
  type AccessTableView,
  type ProjectRole,
  type ProjectSettingsDocument,
  type UnattendedRole,
} from "../../shared/project-settings";
import {
  connectorProblem,
  peopleCount,
  type ConnectorState,
} from "./readiness";

export interface AccessTableEnv {
  connectors: ConnectorState[];
  /** Keychain entries by id; `label` overrides the service name as the row
   *  title. */
  credentials: Record<string, CredentialInfo & { label?: string }>;
  runners: Record<string, { name: string }>;
}

export type AccessTableDocument = Pick<
  ProjectSettingsDocument,
  "project" | "access"
>;

const YOU_COMPUTED = "Interactive sessions follow Organization → Connections";
const INCIDENT_ONLY = "Only incident agents have this enforced";
const NEEDS_A_LIST = "Unattended runs need a list";
const NEVER_VERIFIER = "Never the verifier, by design";

function cell(
  value: AccessCellValue,
  editable = true,
  reason?: string,
): AccessCellView {
  return reason ? { value, editable, reason } : { value, editable };
}

function tick(on: boolean): AccessCellView {
  return cell(on ? "yes" : "no");
}

const YOU_YES = cell("yes", false, YOU_COMPUTED);

function row(
  base: Omit<AccessRowView, "cells">,
  you: AccessCellView,
  unattended: (role: UnattendedRole) => AccessCellView,
): AccessRowView {
  const cells: Record<ProjectRole, AccessCellView> = {
    you,
    automations: unattended("automations"),
    investigator: unattended("investigator"),
    verifier: unattended("verifier"),
    reviews: unattended("reviews"),
  };
  return { ...base, cells };
}

function modeRow(doc: AccessTableDocument): AccessRowView {
  const modes = doc.access.modes;
  return row(
    { key: { kind: "mode" }, title: `Changes code in ${doc.project}` },
    YOU_YES,
    (role) => {
      const mode = modes[role];
      if (mode === "ask") return cell("read");
      // Incident runs publish a branch and a pull request, never main.
      return cell(
        role === "investigator" || role === "verifier" ? "branch" : "yes",
      );
    },
  );
}

function connectionRows(
  doc: AccessTableDocument,
  env: AccessTableEnv,
): AccessRowView[] {
  const byServer = new Map(env.connectors.map((c) => [c.server, c]));
  return doc.access.connections.map((entry) => {
    const state = byServer.get(entry.server);
    const problem = connectorProblem(state);
    const warning = problem
      ? problem.kind === "limited"
        ? {
            text: `Limited to ${peopleCount(problem.people)}, so agents can't open it`,
            fix: { kind: "allow-agents" as const, server: entry.server },
          }
        : { text: "Not connected, so agents can't open it" }
      : undefined;
    const base: Omit<AccessRowView, "cells"> = {
      key: { kind: "connection", server: entry.server },
      title: state?.label ?? entry.server,
    };
    const built = row(base, YOU_YES, (role) => {
      const on = entry.roles.includes(role);
      return on && warning ? cell("blocked", true, warning.text) : tick(on);
    });
    return warning ? { ...built, warning } : built;
  });
}

function credentialRows(
  doc: AccessTableDocument,
  env: AccessTableEnv,
): AccessRowView[] {
  return doc.access.credentials.map((entry) => {
    const info = env.credentials[entry.credential];
    return row(
      {
        key: { kind: "credential", credential: entry.credential },
        title: info?.label ?? info?.service ?? entry.credential,
      },
      cell("ask-each", false, "Lent per request from your keychain"),
      (role) => {
        if (role !== "investigator" && role !== "verifier") {
          return cell("no", false, INCIDENT_ONLY);
        }
        const mode = entry.roles[role];
        if (mode === "once") return cell("ask-once");
        if (mode === "standing") return cell("standing");
        return cell("no");
      },
    );
  });
}

function hostRows(
  doc: AccessTableDocument,
  env: AccessTableEnv,
): AccessRowView[] {
  return doc.access.hosts.map((entry) => {
    const name = env.runners[entry.runner]?.name ?? entry.runner;
    const where = entry.ssh ? `${entry.ssh} via ${name}` : name;
    return row(
      {
        key: entry.ssh
          ? { kind: "host", runner: entry.runner, ssh: entry.ssh }
          : { kind: "host", runner: entry.runner },
        title: `${where}, read-only commands`,
        detail: "Logs, disk, processes. Never writes",
      },
      cell("no", false, "You reach production yourself"),
      (role) =>
        role === "investigator" || role === "verifier"
          ? tick(entry.roles.includes(role))
          : cell("no", false, INCIDENT_ONLY),
    );
  });
}

function websiteRows(doc: AccessTableDocument): AccessRowView[] {
  const anyWebsite = row(
    {
      key: { kind: "website", host: ANY_WEBSITE_HOST },
      title: "Any website",
      detail: "Only you. Unattended runs need a list",
    },
    YOU_YES,
    () => cell("locked", false, NEEDS_A_LIST),
  );
  const listed = doc.access.websites
    .filter((w) => w.host !== ANY_WEBSITE_HOST)
    .map((w) =>
      row(
        { key: { kind: "website", host: w.host }, title: w.host },
        YOU_YES,
        (role) => tick(w.roles.includes(role)),
      ),
    );
  return [anyWebsite, ...listed];
}

function searchRow(doc: AccessTableDocument): AccessRowView {
  const on = new Set<string>(doc.access.webSearch);
  return row(
    {
      key: { kind: "webSearch" },
      title: "Search the web",
      detail: NEVER_VERIFIER,
    },
    YOU_YES,
    (role) =>
      role === "verifier"
        ? cell("locked", false, NEVER_VERIFIER)
        : tick(on.has(role)),
  );
}

export function buildAccessTable(
  doc: AccessTableDocument,
  env: AccessTableEnv,
): AccessTableView {
  const groups: AccessTableView["groups"] = [];
  const add = (
    id: AccessGroupId,
    label: string | null,
    rows: AccessRowView[],
  ) => groups.push({ id, label, rows });
  add("code", null, [modeRow(doc)]);
  add("connectors", "Connectors", connectionRows(doc, env));
  add("keychain", "Keychain", credentialRows(doc, env));
  add("production", "Production", hostRows(doc, env));
  add("websites", "Websites agents may open", websiteRows(doc));
  add("search", null, [searchRow(doc)]);
  return { groups, signalExceptions: doc.access.signalExceptions };
}
