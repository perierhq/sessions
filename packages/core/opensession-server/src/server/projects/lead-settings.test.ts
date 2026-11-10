import { afterEach, beforeEach, expect, test } from "bun:test";
import { DEFAULT_LEAD_RULES } from "../../shared/project-lead";
import type { ProjectSettingsPatch } from "../../shared/project-settings";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { __setLegacyEnvironmentForTest } from "./legacy";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
  patchProjectDocumentAsServer,
  type ProjectActor,
  projectDocuments,
  updateProjectDocument,
} from "./store";

const kit = useIncidentTestKernel();
const person: ProjectActor = { name: "Ada", verified: true, login: "ada" };
const agent: ProjectActor = { name: "agent", verified: false };

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
    runnerProblem: () => null,
    modelProblem: () => null,
  });
  __setOwnerRosterForTest([
    { name: "Ada Lovelace", github: "ada" },
    { name: "Grace Hopper", github: "grace" },
  ] as never);
});
afterEach(() => {
  __setLegacyEnvironmentForTest(undefined);
  __setProjectStoreContextForTest(undefined);
  __setOwnerRosterForTest(undefined);
});

async function write(
  lead: unknown,
  actor: ProjectActor = person,
): ReturnType<typeof updateProjectDocument> {
  const { revision } = await getProjectDocument("acme-web");
  return updateProjectDocument(
    "acme-web",
    { expectedRevision: revision, lead } as ProjectSettingsPatch,
    actor,
  );
}

test("a project reads with the lead off, watching, at the ADR's defaults", async () => {
  const doc = await getProjectDocument("acme-web");
  expect(doc.lead).toEqual({
    enabled: false,
    stage: "watch",
    rules: { ...DEFAULT_LEAD_RULES },
    budgetUsdPerMonth: 50,
  });
});

test("a document stored before the lead reads it at its defaults", async () => {
  const doc = await getProjectDocument("acme-web");
  const { lead: _lead, ...older } = doc;
  await projectDocuments().set("acme-web", { ...older, revision: 3 });
  const read = await getProjectDocument("acme-web");
  expect(read.revision).toBe(3);
  expect(read.lead.enabled).toBe(false);
  expect(read.lead.rules.refund).toBe("only-you");
});

test("a person turns the lead on, moves the stage and sets the owner", async () => {
  const doc = await write({
    enabled: true,
    stage: "coordinate",
    budgetUsdPerMonth: 80,
    owner: "ada",
    rules: { "dependency-major": "alone" },
  });
  if ("error" in doc) throw new Error(doc.error);
  expect(doc.lead).toMatchObject({
    enabled: true,
    stage: "coordinate",
    budgetUsdPerMonth: 80,
    owner: "Ada",
  });
  expect(doc.lead.rules["dependency-major"]).toBe("alone");
  expect(doc.lead.rules["ci-repair"]).toBe("alone");
  expect(doc.revision).toBe(1);
  const audit = kit.audits.find((a) => a.kind === "project_settings_updated");
  expect(audit?.fields).toEqual([
    "lead.budgetUsdPerMonth",
    "lead.enabled",
    "lead.owner",
    "lead.rules.dependency-major",
    "lead.stage",
  ]);
});

test("pinned categories can't be lowered, even by a person", async () => {
  for (const level of ["alone", "asks-first"])
    expect(await write({ rules: { refund: level } })).toEqual({
      error:
        "Only you decide refunds: a lead may prepare, never act (lead.rules.refund)",
      status: 400,
    });
  expect(
    await write({ rules: { "production-data-write": "alone" } }),
  ).toMatchObject({ status: 400 });
  // Restating only you is a no-op.
  const same = await write({ rules: { contract: "only-you" } });
  expect("error" in same ? same.error : same.revision).toBe(0);
});

test("pinned categories stay only you through server writes and stored values", async () => {
  await expect(
    patchProjectDocumentAsServer("acme-web", (d) => ({
      ...d,
      lead: { ...d.lead, rules: { ...d.lead.rules, pricing: "alone" } },
    })),
  ).rejects.toThrow("Only you decide pricing");
  const doc = await getProjectDocument("acme-web");
  await projectDocuments().set("acme-web", {
    ...doc,
    lead: { ...doc.lead, rules: { ...doc.lead.rules, dispute: "alone" } },
  });
  expect((await getProjectDocument("acme-web")).lead.rules.dispute).toBe(
    "only-you",
  );
});

test("the goal is the server's to set", async () => {
  expect(await write({ goalId: "goal-1" })).toEqual({
    error: "The lead's goal (lead.goalId) is set by the server",
    status: 400,
  });
  const doc = await patchProjectDocumentAsServer("acme-web", (d) => ({
    ...d,
    lead: { ...d.lead, goalId: "goal-1" },
  }));
  expect(doc.lead.goalId).toBe("goal-1");
  expect(doc.revision).toBe(0);
});

test("bad values are refused", async () => {
  const cases: Array<[unknown, string]> = [
    [{ enabled: "yes" }, "Lead on (lead.enabled) must be true or false"],
    [
      { stage: "run" },
      "Lead stage (lead.stage) must be one of watch, coordinate, act",
    ],
    [
      { rules: { "make-coffee": "alone" } },
      'Unknown lead category "make-coffee"',
    ],
    [
      { rules: { "ci-repair": "sometimes" } },
      "Lead rule (lead.rules.ci-repair) must be one of alone, asks-first, only-you",
    ],
    [
      { budgetUsdPerMonth: -1 },
      "Lead budget (lead.budgetUsdPerMonth) must be from $0 to $100000",
    ],
    [
      { owner: "Mallory" },
      'Lead owner (lead.owner): Nobody on the team is called "Mallory"',
    ],
    [
      { owner: "Anonymous" },
      "Lead owner (lead.owner): The owner must be a person",
    ],
    ["on", "Lead settings must be an object"],
  ];
  for (const [lead, error] of cases)
    expect(await write(lead)).toEqual({ error, status: 400 });
});

const LOOSEN =
  "Only the instance owner or the lead's owner can give the project lead more room";
const grace: ProjectActor = { name: "Grace", verified: true, login: "grace" };

test("only the instance owner or the lead's owner gives the lead more room", async () => {
  for (const actor of [agent, grace, { ...grace, login: undefined }])
    for (const lead of [
      { enabled: true },
      { stage: "act" },
      { rules: { "ban-user": "alone" } },
      { budgetUsdPerMonth: 51 },
      { owner: "Grace" },
    ]) {
      const result = await write(lead, actor);
      expect(result).toEqual({ error: LOOSEN, status: 403 });
    }
  const refused = kit.audits.filter(
    (a) => a.kind === "project_settings_refused",
  );
  expect(refused.slice(0, 5).map((a) => a.fields)).toEqual([
    ["lead.enabled"],
    ["lead.stage"],
    ["lead.rules.ban-user"],
    ["lead.budgetUsdPerMonth"],
    ["lead.owner"],
  ]);
  expect(refused).toHaveLength(15);
});

test("the lead's owner may give it more room; the instance owner always may", async () => {
  // Ada is the instance owner (the first directory member).
  const owned = await write({ owner: "Grace" });
  if ("error" in owned) throw new Error(owned.error);
  const raised = await write(
    { enabled: true, stage: "coordinate", budgetUsdPerMonth: 80 },
    grace,
  );
  if ("error" in raised) throw new Error(raised.error);
  expect(raised.lead).toMatchObject({
    enabled: true,
    stage: "coordinate",
    budgetUsdPerMonth: 80,
    owner: "Grace",
  });
  // Handing the lead to someone else is more room too: Grace may, a
  // claimed name may not.
  expect(await write({ owner: "Ada" }, { ...agent, name: "Grace" })).toEqual({
    error: LOOSEN,
    status: 403,
  });
  const handed = await write({ owner: "Ada" }, grace);
  if ("error" in handed) throw new Error(handed.error);
  // No longer the owner: Grace can tighten, not loosen.
  expect(await write({ budgetUsdPerMonth: 90 }, grace)).toEqual({
    error: LOOSEN,
    status: 403,
  });
  const lower = await write({ budgetUsdPerMonth: 40 }, grace);
  if ("error" in lower) throw new Error(lower.error);
  expect(lower.lead.budgetUsdPerMonth).toBe(40);
});

test("anyone may tighten the lead", async () => {
  const on = await write({ enabled: true, stage: "act" });
  if ("error" in on) throw new Error(on.error);
  const tighter = await write(
    {
      enabled: false,
      stage: "watch",
      rules: { "ci-repair": "asks-first", "ban-user": "only-you" },
      budgetUsdPerMonth: 10,
    },
    agent,
  );
  if ("error" in tighter) throw new Error(tighter.error);
  expect(tighter.lead).toMatchObject({
    enabled: false,
    stage: "watch",
    budgetUsdPerMonth: 10,
  });
  expect(tighter.lead.rules["ci-repair"]).toBe("asks-first");
  expect(tighter.lead.rules["ban-user"]).toBe("only-you");
});

test("clearing the owner", async () => {
  await write({ owner: "Ada" });
  const cleared = await write({ owner: null });
  if ("error" in cleared) throw new Error(cleared.error);
  expect(cleared.lead.owner).toBeUndefined();
});
