import { describe, expect, test } from "bun:test";
import {
  ANY_WEBSITE_HOST,
  type AccessRowView,
  type AccessTableView,
} from "../../shared/project-settings";
import {
  ALL_READY,
  READY_4_OF_6,
} from "../../shared/project-settings-fixtures";
import { buildAccessTable, type AccessTableEnv } from "./access-table";
import type { ConnectorState } from "./readiness";

function connector(
  server: string,
  label: string,
  allowedUsers = 0,
  allowUnattended = false,
): ConnectorState {
  return { server, label, status: "ok", allowedUsers, allowUnattended };
}

function env(over: Partial<AccessTableEnv> = {}): AccessTableEnv {
  return {
    connectors: [
      connector("linear", "Linear"),
      connector("sentry", "Sentry"),
      connector("grafana", "Grafana", 2),
    ],
    credentials: {
      "cred-cloudflare": {
        label: "Cloudflare token",
        service: "Cloudflare",
        host: "api.cloudflare.com",
        owner: "alex-doe",
        scope: "personal",
        kind: "api",
      },
      "cred-db-readonly": {
        label: "Production database, read only",
        service: "Postgres",
        host: "db.example.test",
        owner: "alex-doe",
        scope: "workspace",
        kind: "api",
      },
    },
    runners: { "rn-prod-eu-1": { name: "prod-eu-1" } },
    ...over,
  };
}

function row(
  table: AccessTableView,
  match: (r: AccessRowView) => boolean,
): AccessRowView {
  const found = table.groups.flatMap((g) => g.rows).find(match);
  if (!found) throw new Error("row not found");
  return found;
}

describe("buildAccessTable", () => {
  test("matches the 4 of 6 design, Grafana limited to named people", () => {
    const table = buildAccessTable(READY_4_OF_6.document, env());
    expect(table).toEqual(READY_4_OF_6.access);
  });

  test("Grafana allowed for agents loses the warning", () => {
    const allowed = env({
      connectors: [
        connector("linear", "Linear"),
        connector("sentry", "Sentry"),
        connector("grafana", "Grafana", 2, true),
      ],
    });
    expect(buildAccessTable(ALL_READY.document, allowed)).toEqual(
      ALL_READY.access,
    );
  });

  test("the blocked connector: one warning with Allow agents, ticked cells blocked", () => {
    const table = buildAccessTable(READY_4_OF_6.document, env());
    const grafana = row(
      table,
      (r) => r.key.kind === "connection" && r.key.server === "grafana",
    );
    expect(grafana.warning).toEqual({
      text: "Limited to 2 people, so agents can't open it",
      fix: { kind: "allow-agents", server: "grafana" },
    });
    expect(grafana.cells.investigator.value).toBe("blocked");
    expect(grafana.cells.you.value).toBe("yes");
  });

  test("mode, search and keychain cells", () => {
    const table = buildAccessTable(READY_4_OF_6.document, env());
    const mode = row(table, (r) => r.key.kind === "mode");
    expect(mode.cells.verifier.value).toBe("read");
    expect(mode.cells.investigator.value).toBe("branch");
    // Nothing reads these at run time: each automation sets its own mode,
    // and the GitHub flow picks one per kind of run.
    expect(mode.cells.automations).toEqual({
      value: "elsewhere",
      editable: false,
      label: "Set per automation",
      reason: "Each automation sets its own mode",
    });
    expect(mode.cells.reviews).toEqual({
      value: "elsewhere",
      editable: false,
      label: "Pushes to the PR branch",
      reason:
        "Set per run: reviews only read; fixes and replies to mentions push to the pull request's branch",
    });
    const search = row(table, (r) => r.key.kind === "webSearch");
    expect(search.cells.verifier).toEqual({
      value: "locked",
      editable: false,
      reason: "Never the verifier, by design",
    });
    const keychain = row(table, (r) => r.key.kind === "credential");
    expect(keychain.cells.automations.value).toBe("no");
    expect(keychain.cells.automations.editable).toBe(false);
    expect(keychain.cells.you).toEqual({
      value: "ask-each",
      editable: false,
      reason: "Lent per request from your keychain",
    });
  });

  test("a broken connector warns without a fix", () => {
    const table = buildAccessTable(
      READY_4_OF_6.document,
      env({
        connectors: [
          { ...connector("linear", "Linear"), status: "error" },
          connector("sentry", "Sentry"),
          connector("grafana", "Grafana", 2, true),
        ],
      }),
    );
    const linear = row(
      table,
      (r) => r.key.kind === "connection" && r.key.server === "linear",
    );
    expect(linear.warning).toEqual({
      text: "Not connected, so agents can't open it",
    });
    expect(linear.cells.automations.value).toBe("blocked");
    expect(linear.cells.verifier.value).toBe("no");
  });

  test("a standing credential, an ssh host, a stored any-website row and exceptions", () => {
    const doc = {
      ...READY_4_OF_6.document,
      access: {
        ...READY_4_OF_6.document.access,
        credentials: [
          {
            credential: "cred-x",
            roles: { verifier: "standing" as const },
            grantedBy: "Alex Doe",
            grantedAt: "2026-09-30T18:00:00.000Z",
          },
        ],
        hosts: [
          {
            runner: "rn-prod-eu-1",
            ssh: "db-1",
            access: "read-only" as const,
            roles: ["verifier" as const],
          },
        ],
        websites: [
          {
            host: ANY_WEBSITE_HOST,
            roles: ["automations" as const],
          },
        ],
        signalExceptions: [
          {
            signalId: "sig-1",
            role: "investigator" as const,
            fields: { connections: ["linear"] },
            updatedBy: "Alex Doe",
            updatedAt: "2026-09-30T18:00:00.000Z",
          },
        ],
      },
    };
    const table = buildAccessTable(doc, env({ credentials: {} }));
    const cred = row(table, (r) => r.key.kind === "credential");
    expect(cred.title).toBe("cred-x");
    expect(cred.cells.verifier.value).toBe("standing");
    expect(cred.cells.investigator.value).toBe("no");
    const host = row(table, (r) => r.key.kind === "host");
    expect(host.key).toEqual({
      kind: "host",
      runner: "rn-prod-eu-1",
      ssh: "db-1",
    });
    expect(host.title).toBe("db-1 via prod-eu-1, read-only commands");
    const websites = table.groups.find((g) => g.id === "websites");
    expect(websites?.rows).toHaveLength(1);
    expect(websites?.rows[0]?.cells.automations.value).toBe("locked");
    expect(table.signalExceptions).toEqual(doc.access.signalExceptions);
    expect(table.groups.map((g) => g.id)).toEqual([
      "code",
      "connectors",
      "keychain",
      "production",
      "websites",
      "search",
    ]);
  });

  test("Support: a column in every row, mode and search set here, keychain and hosts never", () => {
    const table = buildAccessTable(READY_4_OF_6.document, env());
    for (const group of table.groups)
      for (const r of group.rows) expect(r.cells.support).toBeDefined();
    const mode = row(table, (r) => r.key.kind === "mode");
    expect(mode.cells.support).toEqual({ value: "read", editable: true });
    const search = row(table, (r) => r.key.kind === "webSearch");
    expect(search.cells.support).toEqual({ value: "no", editable: true });
    for (const kind of ["credential", "host"] as const)
      expect(row(table, (r) => r.key.kind === kind).cells.support).toEqual({
        value: "no",
        editable: false,
        reason: "Only incident agents have this enforced",
      });

    const doc = structuredClone(READY_4_OF_6.document);
    doc.access.modes.support = "code";
    doc.access.connections[0]!.roles.push("support");
    doc.access.webSearch.push("support");
    const ticked = buildAccessTable(doc, env());
    expect(row(ticked, (r) => r.key.kind === "mode").cells.support.value).toBe(
      "branch",
    );
    expect(
      row(
        ticked,
        (r) => r.key.kind === "connection" && r.key.server === "linear",
      ).cells.support,
    ).toEqual({ value: "yes", editable: true });
    expect(
      row(ticked, (r) => r.key.kind === "webSearch").cells.support.value,
    ).toBe("yes");
  });

  test("a group with no rows is left out", () => {
    const doc = structuredClone(READY_4_OF_6.document);
    doc.access.credentials = [];
    doc.access.hosts = [];
    doc.access.connections = [];
    const table = buildAccessTable(doc, env());
    expect(table.groups.map((g) => g.id)).toEqual([
      "code",
      "websites",
      "search",
    ]);
  });
});
