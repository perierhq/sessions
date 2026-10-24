import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ProjectSettingsPatch } from "../../shared/project-settings";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { __setLegacyEnvironmentForTest } from "./legacy";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
  listProjectDocuments,
  onProjectDocumentChange,
  patchProjectDocumentAsServer,
  peekProjectDocument,
  type ProjectActor,
  updateProjectDocument,
} from "./store";

const kit = useIncidentTestKernel();
const person: ProjectActor = { name: "Ada", verified: true, login: "ada" };
const agent: ProjectActor = { name: "agent", verified: false };

afterEach(() => {
  __setLegacyEnvironmentForTest(undefined);
  __setProjectStoreContextForTest(undefined);
});
beforeEach(() => {
  __setLegacyEnvironmentForTest({
    projects: () => ["acme-web"],
    sandbox: () => ({ perRepo: {} }),
    automations: async () => [],
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });
  __setProjectStoreContextForTest({
    projectExists: (id) => id === "acme-web",
    runnerProblem: (id) =>
      id === "runner-prod" ? null : `Runner ${id} is not available`,
    modelProblem: () => null,
    connectionExists: (name) => ["linear", "grafana", "sentry"].includes(name),
    credential: (id) =>
      id === "cred-grafana"
        ? {
            id,
            service: "grafana",
            host: "grafana.example.test",
            owner: "Ada",
            kind: "api",
            scope: "personal",
            injectionHeader: "Authorization",
          }
        : null,
    isOwner: (login) => login === "ada",
    ownerRoster: () => "one",
    hostProblem: () => null,
  });
});

async function write(
  patch: Omit<ProjectSettingsPatch, "expectedRevision">,
  actor: ProjectActor = person,
) {
  const { revision } = await getProjectDocument("acme-web");
  return updateProjectDocument(
    "acme-web",
    { expectedRevision: revision, ...patch },
    actor,
  );
}

async function written(
  patch: Omit<ProjectSettingsPatch, "expectedRevision">,
  actor: ProjectActor = person,
) {
  const result = await write(patch, actor);
  if ("error" in result) throw new Error(result.error);
  return result;
}

test("a project without a document reads as the defaults, unwritten", async () => {
  const doc = await getProjectDocument("acme-web");
  expect(doc).toMatchObject({ revision: 0, sandbox: "default", models: {} });
  expect(await listProjectDocuments()).toEqual([]);
  expect(peekProjectDocument("acme-web")?.revision).toBe(0);
});

test("unknown projects answer 404", async () => {
  expect(
    await updateProjectDocument(
      "acme-gone",
      { expectedRevision: 0, sandbox: "podman" },
      person,
    ),
  ).toEqual({ error: "Unknown project acme-gone", status: 404 });
});

test("a stale revision answers 409", async () => {
  await written({ sandbox: "podman" });
  expect(
    await updateProjectDocument(
      "acme-web",
      { expectedRevision: 0, sandbox: "daytona" },
      person,
    ),
  ).toEqual({ error: "Settings changed since you loaded them", status: 409 });
  expect((await getProjectDocument("acme-web")).sandbox).toBe("podman");
});

test("a model is stored canonical and bumps the revision", async () => {
  const doc = await written({ models: { investigator: "opus" } });
  expect(doc.models.investigator).toBe("pi/anthropic/claude-opus-5-5");
  expect(doc.revision).toBe(1);
  expect(doc.updatedBy).toBe("Ada");
  expect(doc.migratedAt).toBeString();
  expect(doc.releaseHookSecret).toMatch(/^[0-9a-f]{48}$/);
  expect(
    await write({
      models: { verifier: "pi/openrouter/anthropic/claude-opus-5-5" },
    }),
  ).toEqual({ error: "Pick a different model for the verifier", status: 400 });
  const cleared = await written({ models: { investigator: null } });
  expect(cleared.models).toEqual({});
});

test("only a signed-in person adds a production Runner", async () => {
  expect(
    await write({ production: { runners: ["runner-prod"] } }, agent),
  ).toEqual({
    error: "Only a signed-in person can change actions or production Runners",
    status: 403,
  });
  expect(kit.audits.at(-1)).toEqual({
    kind: "project_settings_refused",
    project: "acme-web",
    by: "agent",
    fields: ["production.runners"],
  });
  const doc = await written({ production: { runners: ["runner-prod"] } });
  expect(doc.production.runners).toEqual(["runner-prod"]);
});

test("raising the budget needs a person; lowering it does not", async () => {
  expect(
    await write(
      { incidents: { budget: { perIncidentUsd: 40, perMonthUsd: 400 } } },
      agent,
    ),
  ).toEqual({
    error: "Only a signed-in person can loosen the incident policy",
    status: 403,
  });
  const lower = await written(
    { incidents: { budget: { perIncidentUsd: 5, perMonthUsd: 200 } } },
    agent,
  );
  expect(lower.incidents.budget.perIncidentUsd).toBe(5);
});

test("the verifier never searches the web", async () => {
  expect(
    await write({
      access: {
        cells: [{ row: { kind: "webSearch" }, role: "verifier", value: true }],
      },
    }),
  ).toEqual({ error: "The verifier never searches the web", status: 400 });
});

test("keychain and host cells apply only to incident agents", async () => {
  for (const row of [
    { kind: "credential", credential: "cred-grafana" } as const,
    { kind: "host", runner: "runner-prod" } as const,
  ])
    expect(
      await write({
        access: { cells: [{ row, role: "reviews", value: true }] },
      }),
    ).toMatchObject({ status: 400 });
});

test("a connector cell, a website row and their audit paths", async () => {
  await written({
    access: { addRows: [{ kind: "connection", server: "linear" }] },
  });
  const doc = await written({
    access: {
      cells: [
        {
          row: { kind: "connection", server: "linear" },
          role: "reviews",
          value: true,
        },
      ],
    },
  });
  expect(doc.access.connections).toEqual([
    { server: "linear", roles: ["reviews"] },
  ]);
  expect(kit.audits.at(-1)).toEqual({
    kind: "project_settings_updated",
    project: "acme-web",
    by: "Ada",
    fields: ["access.connections.linear.reviews"],
  });
  const withSite = await written({
    access: {
      cells: [
        {
          row: { kind: "website", host: "docs.example.test" },
          role: "automations",
          value: true,
        },
      ],
    },
  });
  expect(withSite.access.websites).toEqual([
    { host: "docs.example.test", roles: ["automations"] },
  ]);
  const removed = await written({
    access: { removeRows: [{ kind: "website", host: "docs.example.test" }] },
  });
  expect(removed.access.websites).toEqual([]);
  expect(
    await write({
      access: {
        cells: [
          {
            row: { kind: "website", host: "bad host" },
            role: "automations",
            value: true,
          },
        ],
      },
    }),
  ).toMatchObject({ status: 400 });
  expect(
    await write({
      access: {
        cells: [
          {
            row: { kind: "connection", server: "nope" },
            role: "automations",
            value: true,
          },
        ],
      },
    }),
  ).toEqual({ error: 'Unknown connection "nope"', status: 400 });
});

test("a personal credential is lent only by its signed-in owner", async () => {
  const cell = {
    row: { kind: "credential", credential: "cred-grafana" },
    role: "investigator",
    value: "once",
  } as const;
  expect(await write({ access: { cells: [cell] } }, agent)).toEqual({
    error: "Sign in to grant credentials to incident agents",
    status: 403,
  });
  expect(
    await write(
      { access: { cells: [cell] } },
      { name: "Bo", verified: true, login: "bo" },
    ),
  ).toEqual({
    error: "Only Ada can grant grafana to incident agents",
    status: 400,
  });
  const doc = await written({ access: { cells: [cell] } });
  expect(doc.access.credentials[0]).toMatchObject({
    credential: "cred-grafana",
    roles: { investigator: "once" },
    grantedBy: "Ada",
    grantedByLogin: "ada",
  });
  // Narrowing needs no authority.
  const off = await written(
    { access: { cells: [{ ...cell, value: null }] } },
    agent,
  );
  expect(off.access.credentials[0]?.roles).toEqual({});
});

test("listeners fire once per committed write, never on a no-op", async () => {
  const seen: string[] = [];
  const stop = onProjectDocumentChange((p) => seen.push(p));
  try {
    await written({ sandbox: "podman" });
    const audits = kit.audits.length;
    const same = await written({ sandbox: "podman" });
    expect(same.revision).toBe(1);
    expect(kit.audits.length).toBe(audits);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["acme-web"]);
  } finally {
    stop();
  }
});

test("server writes keep the revision and the document's rules", async () => {
  await written({ sandbox: "podman" });
  const doc = await patchProjectDocumentAsServer("acme-web", (d) => ({
    ...d,
    automationId: "auto-1",
  }));
  expect(doc).toMatchObject({ automationId: "auto-1", revision: 1 });
  await expect(
    patchProjectDocumentAsServer("acme-web", (d) => ({
      ...d,
      production: {
        ...d.production,
        actions: [
          {
            id: "deploy",
            kind: "deploy",
            label: "Deploy",
            runner: "runner-lab",
            command: "./deploy.sh",
            timeoutMs: 600_000,
            reversible: true,
            cost: { kind: "none" },
            needsSecret: false,
            scope: { services: [], paths: [], migrationPaths: [] },
          },
        ],
      },
    })),
  ).rejects.toThrow("not one of the project's production Runners");
  await expect(
    patchProjectDocumentAsServer("acme-gone", (d) => d),
  ).rejects.toThrow("Unknown project acme-gone");
});

const WIDEN = {
  error: "Only a signed-in person can give agents more access",
  status: 403,
};

test("only a signed-in person widens what agents may use", async () => {
  const cell = (
    row: NonNullable<
      NonNullable<ProjectSettingsPatch["access"]>["cells"]
    >[number]["row"],
    role: "automations" | "investigator" | "verifier" | "reviews",
    value: boolean | "code" | "ask",
  ) => ({ access: { cells: [{ row, role, value }] } });
  // Narrow first, so turning these back on is a widening.
  await written({
    access: {
      cells: [
        { row: { kind: "webSearch" }, role: "reviews", value: false },
        { row: { kind: "mode" }, role: "investigator", value: "ask" },
      ],
    },
  });
  const widenings: Array<
    [Omit<ProjectSettingsPatch, "expectedRevision">, string]
  > = [
    [
      cell({ kind: "website", host: "docs.example.test" }, "automations", true),
      "access.websites.docs.example.test.automations",
    ],
    [
      cell({ kind: "connection", server: "linear" }, "automations", true),
      "access.connections.linear.automations",
    ],
    [
      cell({ kind: "connection", server: "linear" }, "reviews", true),
      "access.connections.linear.reviews",
    ],
    [
      cell({ kind: "host", runner: "runner-prod" }, "investigator", true),
      "access.hosts.runner-prod.investigator",
    ],
    [cell({ kind: "webSearch" }, "reviews", true), "access.webSearch.reviews"],
    [
      cell({ kind: "mode" }, "investigator", "code"),
      "access.modes.investigator",
    ],
    [{ sandbox: "local" }, "sandbox"],
  ];
  for (const [patch, field] of widenings) {
    expect(await write(patch, agent)).toEqual(WIDEN);
    expect(kit.audits.at(-1)).toEqual({
      kind: "project_settings_refused",
      project: "acme-web",
      by: "agent",
      fields: [field],
    });
  }
  const doc = await getProjectDocument("acme-web");
  expect(doc.revision).toBe(1);
  expect(doc.sandbox).toBe("default");
  expect(doc.access.modes.investigator).toBe("ask");
  expect(doc.access.websites).toEqual([]);
  expect(doc.access.hosts).toEqual([]);
  expect(doc.access.webSearch).not.toContain("reviews");
  // The same changes from a person go through.
  for (const [patch] of widenings) await written(patch);
});

test("narrowing what agents may use stays open", async () => {
  await written({
    sandbox: "podman",
    access: {
      cells: [
        {
          row: { kind: "website", host: "docs.example.test" },
          role: "automations",
          value: true,
        },
        {
          row: { kind: "connection", server: "linear" },
          role: "reviews",
          value: true,
        },
      ],
    },
  });
  const doc = await written(
    {
      access: {
        cells: [
          {
            row: { kind: "connection", server: "linear" },
            role: "reviews",
            value: false,
          },
          { row: { kind: "mode" }, role: "investigator", value: "ask" },
          { row: { kind: "webSearch" }, role: "automations", value: false },
        ],
        removeRows: [{ kind: "website", host: "docs.example.test" }],
      },
    },
    agent,
  );
  expect(doc.access.websites).toEqual([]);
  expect(doc.access.connections).toEqual([{ server: "linear", roles: [] }]);
  expect(doc.access.modes.investigator).toBe("ask");
  expect(doc.access.webSearch).not.toContain("automations");
  // Models are not access: anyone may set them.
  expect(
    (await written({ models: { reviews: "opus" } }, agent)).models.reviews,
  ).toBeString();
});
