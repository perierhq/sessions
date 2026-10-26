import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
} from "./incident-response";
import {
  PROJECT_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  UNATTENDED_ROLES,
  defaultProjectDocument,
  projectStatusLabel,
  type ProjectDefaultsView,
  type ProjectListItem,
  type ProjectSettingsView,
} from "./project-settings";
import {
  ALL_READY,
  BLOCKED_NO_SANDBOX,
  DEFAULTS_VIEW,
  PROJECT_LIST,
  READY_4_OF_6,
} from "./project-settings-fixtures";

const NOW = "2026-10-01T09:00:00.000Z";

describe("project roles", () => {
  test("six roles in the fixed order, with their labels", () => {
    expect([...PROJECT_ROLES]).toEqual([
      "you",
      "automations",
      "investigator",
      "verifier",
      "reviews",
      "support",
    ]);
    expect(PROJECT_ROLES.map((r) => ROLE_LABELS[r])).toEqual([
      "You",
      "Automations",
      "Investigator",
      "Verifier",
      "Reviews",
      "Support",
    ]);
    expect(ROLE_DESCRIPTIONS.support).toBe(
      "Conversations from your support inboxes",
    );
    expect<string[]>([...UNATTENDED_ROLES]).toEqual(PROJECT_ROLES.slice(1));
    expect(ROLE_DESCRIPTIONS.verifier).toBe(
      "Incidents: proves the fix on a different provider",
    );
  });
});

describe("defaultProjectDocument", () => {
  test("starts unset, at revision 0, with today's access defaults", () => {
    const doc = defaultProjectDocument("acme-web", NOW);
    expect(doc.schema).toBe(1);
    expect(doc.project).toBe("acme-web");
    expect(doc.revision).toBe(0);
    expect(doc.sandbox).toBe("default");
    expect(doc.models).toEqual({});
    expect(doc.access.modes).toEqual({
      automations: "code",
      investigator: "code",
      verifier: "ask",
      reviews: "code",
      support: "ask",
    });
    expect(doc.access.webSearch).toEqual([
      "automations",
      "investigator",
      "reviews",
    ]);
    expect(doc.access.connections).toEqual([]);
    expect(doc.access.credentials).toEqual([]);
    expect(doc.access.hosts).toEqual([]);
    expect(doc.access.websites).toEqual([]);
    expect(doc.access.signalExceptions).toEqual([]);
    expect(doc.access.routes).toEqual({
      investigator: { route: "server" },
      verifier: { route: "server" },
    });
    expect(doc.access.deniedTools).toEqual({ investigator: [], verifier: [] });
    expect(doc.production).toEqual({ runners: [], actions: [], releases: [] });
    expect(doc.incidents).toEqual({
      agentsPaused: false,
      incidentsPaused: false,
      autonomy: DEFAULT_AUTONOMY,
      vetoMs: DEFAULT_VETO_MS,
      watchMs: DEFAULT_WATCH_MS,
      maxRounds: DEFAULT_MAX_ROUNDS,
      neverWithoutYou: [...DEFAULT_NEVER_WITHOUT_YOU],
      budget: { ...DEFAULT_BUDGET },
    });
    expect(doc.updatedAt).toBe(NOW);
    expect(doc.migratedAt).toBeUndefined();
  });

  test("returns fresh arrays, never shared defaults", () => {
    const a = defaultProjectDocument("acme-web", NOW);
    const b = defaultProjectDocument("acme-api", NOW);
    a.incidents.neverWithoutYou.push("not-reversible");
    a.access.webSearch.pop();
    expect(b.incidents.neverWithoutYou).toEqual([...DEFAULT_NEVER_WITHOUT_YOU]);
    expect(b.access.webSearch).toHaveLength(3);
  });
});

describe("projectStatusLabel", () => {
  test("partial", () => {
    expect(projectStatusLabel({ readyCount: 4, blocking: null }, true)).toEqual(
      { kind: "partial", label: "4 of 6 ready" },
    );
  });
  test("ready", () => {
    expect(projectStatusLabel({ readyCount: 6, blocking: null }, true)).toEqual(
      { kind: "ready", label: "Ready" },
    );
  });
  test("blocked wins over the count", () => {
    const blocking = BLOCKED_NO_SANDBOX.readiness.blocking;
    expect(projectStatusLabel({ readyCount: 6, blocking }, true)).toEqual({
      kind: "blocked",
      label: "Can't start",
    });
  });
  test("incidents off wins over everything", () => {
    const blocking = BLOCKED_NO_SANDBOX.readiness.blocking;
    expect(projectStatusLabel({ readyCount: 4, blocking }, false)).toEqual({
      kind: "off",
      label: "Incidents off",
    });
  });
});

describe("fixtures", () => {
  // Compile-time: each fixture satisfies its contract type.
  const views: ProjectSettingsView[] = [
    READY_4_OF_6,
    BLOCKED_NO_SANDBOX,
    ALL_READY,
  ];
  const defaults: ProjectDefaultsView = DEFAULTS_VIEW;
  const list: ProjectListItem[] = PROJECT_LIST;

  test("public names only", () => {
    const text = JSON.stringify({ views, defaults, list });
    expect(text).not.toMatch(/\.(com|net|org|io|dev|app|eu|de|pl)\b/);
    expect(text).toContain("api.example.test");
    expect(list.map((p) => p.id)).toEqual([
      "acme-web",
      "acme-api",
      "docs-site",
    ]);
  });

  test("ready 4 of 6 mirrors the design", () => {
    const v = READY_4_OF_6;
    expect(v.document.project).toBe("acme-web");
    expect(v.document.sandbox).toBe("podman");
    expect(v.readiness.readyCount).toBe(4);
    expect(v.readiness.total).toBe(6);
    expect(v.readiness.blocking).toBeNull();
    expect(v.readiness.status).toEqual(projectStatusLabel(v.readiness, true));
    expect(v.readiness.steps.map((s) => s.id)).toEqual([
      "deploy",
      "access",
      "models",
      "where",
      "production",
      "signals",
    ]);
    expect(v.readiness.steps[0]!.title).toBe("Rollback");
    expect(v.readiness.steps[1]!.title).toBe("Logs for agents");
    expect(v.effective.sandbox.automations).toMatchObject({
      state: "ok",
      provider: "daytona",
      source: "default",
      label: "Daytona eu",
    });
    expect(v.effective.sandbox.incidentAgents).toMatchObject({
      state: "ok",
      provider: "podman",
    });
    const grafana = v.access.groups
      .find((g) => g.id === "connectors")!
      .rows.find(
        (r) => r.key.kind === "connection" && r.key.server === "grafana",
      )!;
    expect(grafana.warning?.fix).toEqual({
      kind: "allow-agents",
      server: "grafana",
    });
    expect(grafana.cells.investigator.value).toBe("blocked");
    expect(v.runners.map((r) => r.name)).toEqual(["prod-eu-1"]);
    expect(v.document.production.runners).toEqual([v.runners[0]!.id]);
  });

  test("blocked mirrors the design", () => {
    const v = BLOCKED_NO_SANDBOX;
    expect(v.readiness.blocking?.id).toBe("where");
    expect(v.readiness.blocking?.fix).toEqual({ kind: "connect-sandbox" });
    expect(v.readiness.status).toEqual({
      kind: "blocked",
      label: "Can't start",
    });
    expect(v.readiness.readyCount).toBe(3);
    expect(v.effective.sandbox.incidentAgents.state).toBe("cant-start");
  });

  test("all ready", () => {
    expect(ALL_READY.readiness.readyCount).toBe(6);
    expect(ALL_READY.readiness.status).toEqual({
      kind: "ready",
      label: "Ready",
    });
    expect(ALL_READY.readiness.steps.every((s) => s.state === "ready")).toBe(
      true,
    );
  });

  test("Support runs where incident agents run, read-only, without search", () => {
    for (const v of views) {
      expect(v.effective.sandbox.support).toEqual(
        v.effective.sandbox.incidentAgents,
      );
      const mode = v.access.groups[0]!.rows[0]!;
      expect(mode.cells.support).toEqual({ value: "read", editable: true });
    }
  });

  test("every access row has a cell per role", () => {
    for (const v of views) {
      for (const group of v.access.groups) {
        for (const row of group.rows) {
          expect(Object.keys(row.cells).sort()).toEqual(
            [...PROJECT_ROLES].sort(),
          );
        }
      }
    }
  });

  test("defaults and list agree on project status", () => {
    expect(defaults.projects).toEqual(list);
    expect(list[0]!.status).toEqual(READY_4_OF_6.readiness.status);
    expect(list.slice(1).map((p) => p.status.label)).toEqual([
      "Incidents off",
      "Incidents off",
    ]);
    expect(PROJECT_ROLES.every((r) => defaults.models[r])).toBe(true);
    expect(defaults.websites).not.toContain("status.example.test");
  });
});
