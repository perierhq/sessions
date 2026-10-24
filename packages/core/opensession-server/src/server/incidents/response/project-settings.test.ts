import { beforeEach, expect, test } from "bun:test";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  __setProjectSettingsContextForTest,
  getProjectSettings,
  latestRelease,
  listProjectSettings,
  patchProjectSettings,
  peekProjectSettings,
  projectAction,
  recordRelease,
  redactProjectSettings,
  updateProjectSettings,
} from "./project-settings";

const kit = useIncidentTestKernel();
// Signed in: actions and production Runners are editable.
const update = (project: string, input: Record<string, unknown>, by: string) =>
  updateProjectSettings(project, input, by, { signedInPerson: true });
beforeEach(() =>
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: (id) =>
      id === "runner-prod" ? null : `Runner ${id} is not available`,
    modelProblem: (id) => (id.startsWith("pi/") ? null : `Unknown model ${id}`),
  }),
);
const deploy = {
  id: "deploy",
  kind: "deploy",
  label: "Deploy",
  runner: "runner-prod",
  command: "./deploy.sh {{ref}}",
};

test("defaults without a write", async () => {
  expect(await getProjectSettings("acme")).toMatchObject({
    project: "acme",
    agentsPaused: false,
    autonomy: "deploy-after-veto",
    vetoMs: 600_000,
    watchMs: 600_000,
    maxRounds: 2,
    neverWithoutYou: [
      "costs-money",
      "needs-secret",
      "migration",
      "outside-scope",
    ],
    budget: { perIncidentUsd: 20, perMonthUsd: 200 },
    productionRunners: [],
    actions: [],
    releases: [],
  });
  expect(kit.audits).toEqual([]);
  expect(await listProjectSettings()).toEqual([]);
});
test("a full update, with action defaults and a hook secret", async () => {
  const s = await update(
    "acme",
    {
      autonomy: "propose",
      night: { start: "23:00", end: "07:00", timeZone: "Europe/Warsaw" },
      productionRunners: ["runner-prod"],
      actions: [
        deploy,
        {
          id: "nightly",
          kind: "run-once",
          label: "Run nightly",
          runner: "runner-prod",
          command: "./nightly.sh",
        },
      ],
    },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  expect(s.actions[0]).toMatchObject({
    reversible: true,
    needsSecret: false,
    cost: { kind: "none" },
    timeoutMs: 600_000,
    scope: { services: [], paths: [], migrationPaths: [] },
  });
  expect(s.actions[1].reversible).toBe(false);
  expect(s.releaseHookSecret).toMatch(/^[0-9a-f]{48}$/);
  expect(redactProjectSettings(s)).not.toHaveProperty("releaseHookSecret");
  expect(redactProjectSettings(s).releaseHookPath).toBe(
    `/incident-releases/acme/${s.releaseHookSecret}`,
  );
  expect(kit.audits.at(-1)).toEqual({
    kind: "incident_settings_updated",
    project: "acme",
    by: "Ada",
    fields: ["actions", "autonomy", "night", "productionRunners"],
  });
  expect(s).toMatchObject({ updatedBy: "Ada" });
  expect(peekProjectSettings("acme")?.autonomy).toBe("propose");
  expect(projectAction(s, "run-once")?.id).toBe("nightly");
  expect((await listProjectSettings()).map((p) => p.project)).toEqual(["acme"]);
  // The same values again change nothing and audit nothing.
  const audits = kit.audits.length;
  await update("acme", { autonomy: "propose" }, "Bo");
  expect(kit.audits.length).toBe(audits);
  // Clearing the night rule.
  const cleared = await update("acme", { night: null }, "Ada");
  expect("error" in cleared ? cleared : cleared.night).toBeUndefined();
});
test.each([
  [{ autonomy: "yolo" }, "autonomy"],
  [{ vetoMs: 5_000 }, "vetoMs"],
  [{ night: { start: "23:00", end: "23:00", timeZone: "UTC" } }, "night"],
  [
    { night: { start: "23:00", end: "07:00", timeZone: "Mars/Olympus" } },
    "night",
  ],
  [{ budget: { perIncidentUsd: 50, perMonthUsd: 20 } }, "perMonthUsd"],
  [{ neverWithoutYou: ["migration", "migration"] }, "neverWithoutYou"],
  [
    { agents: { investigatorModel: "pi/a/x", verifierModel: "pi/a/x" } },
    "Pick a different model for the verifier",
  ],
  [{ agents: { verifierModel: "nope" } }, "Unknown model nope"],
  [{ productionRunners: ["runner-lab"] }, "Runner runner-lab is not available"],
  [
    {
      productionRunners: ["runner-prod"],
      actions: [{ ...deploy, command: "./deploy.sh {{branch}}" }],
    },
    "Unknown placeholder {{branch}}",
  ],
  [
    {
      productionRunners: ["runner-prod"],
      actions: [deploy, { ...deploy, id: "deploy-2" }],
    },
    "Only one deploy action per project",
  ],
  [{ actions: [deploy] }, "Pick one of the project's production Runners"],
  [
    {
      productionRunners: ["runner-prod"],
      actions: [{ ...deploy, scope: { paths: ["src/["] } }],
    },
    "scope",
  ],
])("rejects %j", async (input, message) => {
  expect(await update("acme", input, "Ada")).toEqual({
    error: expect.stringContaining(message),
  });
});
test("unknown projects are refused", async () => {
  expect(await update("other", { autonomy: "watch" }, "Ada")).toEqual({
    error: expect.stringContaining("other"),
  });
});
test("server-side fields cannot be written by callers; releases are capped", async () => {
  await update(
    "acme",
    {
      automationId: "auto-x",
      releases: [{ at: "x" }],
      releaseHookSecret: "0".repeat(48),
    },
    "Ada",
  );
  const s = await getProjectSettings("acme");
  expect(s.automationId).toBeUndefined();
  expect(s.releases).toEqual([]);
  expect(s.releaseHookSecret).toBeUndefined();
  for (let i = 0; i < 25; i++)
    await recordRelease("acme", {
      at: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(),
      source: "hook",
    });
  const after = await getProjectSettings("acme");
  expect(after.releases).toHaveLength(20);
  expect(latestRelease(after)?.at).toBe("2026-10-20T10:24:00.000Z");
  expect(kit.audits.at(-1)).toEqual({
    kind: "incident_release",
    project: "acme",
    source: "hook",
    ref: undefined,
  });
  const patched = await patchProjectSettings("acme", (p) => ({
    ...p,
    automationId: "auto-1",
  }));
  expect(patched.automationId).toBe("auto-1");
  expect((await getProjectSettings("acme")).automationId).toBe("auto-1");
});
test("agent models are stored canonical and compared by model", async () => {
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    modelProblem: () => null,
  });
  const s = await update(
    "acme",
    { agents: { investigatorModel: "opus" } },
    "Ada",
  );
  expect("error" in s ? s : s.agents).toEqual({
    investigatorModel: "pi/anthropic/claude-opus-5-5",
  });
  expect(
    await update(
      "acme",
      { agents: { verifierModel: "pi/openrouter/anthropic/claude-opus-5-5" } },
      "Ada",
    ),
  ).toEqual({ error: "Pick a different model for the verifier" });
  expect(
    await update(
      "acme",
      {
        agents: {
          investigatorModel: "claude-opus-5-5",
          verifierModel: "pi/anthropic/claude-opus-5-5",
        },
      },
      "Ada",
    ),
  ).toEqual({ error: "Pick a different model for the verifier" });
});
test("a Runner an action uses cannot be removed", async () => {
  const s = await update(
    "acme",
    { productionRunners: ["runner-prod"], actions: [deploy] },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  expect(await update("acme", { productionRunners: [] }, "Ada")).toEqual({
    error:
      "Action deploy runs on runner-prod, which is not one of the project's production Runners",
  });
  expect((await getProjectSettings("acme")).productionRunners).toEqual([
    "runner-prod",
  ]);
});
test("concurrent edits are checked against the record they commit to", async () => {
  const s = await update("acme", { productionRunners: ["runner-prod"] }, "Ada");
  if ("error" in s) throw new Error(s.error);
  const [removed, added] = await Promise.all([
    update("acme", { productionRunners: [] }, "Ada"),
    update("acme", { actions: [deploy] }, "Bo"),
  ]);
  expect("error" in removed).toBe(false);
  expect(added).toEqual({
    error: "Pick one of the project's production Runners (action deploy)",
  });
  const after = await getProjectSettings("acme");
  expect([after.productionRunners, after.actions]).toEqual([[], []]);
});
test("only a signed-in person changes actions and production Runners", async () => {
  expect(
    await updateProjectSettings(
      "acme",
      { productionRunners: ["runner-prod"], autonomy: "propose" },
      "agent",
    ),
  ).toEqual({
    error: "Only a signed-in person can change actions or production Runners",
    forbidden: true,
  });
  expect(kit.audits.at(-1)).toEqual({
    kind: "incident_settings_refused",
    project: "acme",
    by: "agent",
    fields: ["productionRunners"],
  });
  expect((await getProjectSettings("acme")).autonomy).toBe("deploy-after-veto");
  const other = await updateProjectSettings(
    "acme",
    { autonomy: "propose" },
    "agent",
  );
  expect("error" in other ? other : other.autonomy).toBe("propose");
});
test("only a signed-in person loosens the policy; anyone may tighten it", async () => {
  const anonymous = (input: Record<string, unknown>) =>
    updateProjectSettings("acme", input, "agent");
  const night = { start: "22:00", end: "07:00", timeZone: "Europe/Warsaw" };
  // Start from a strict record, set by a person.
  expect(
    await update(
      "acme",
      {
        agentsPaused: true,
        autonomy: "propose",
        vetoMs: 1_200_000,
        maxRounds: 2,
        night,
        neverWithoutYou: [
          "costs-money",
          "needs-secret",
          "migration",
          "outside-scope",
          "not-reversible",
        ],
        budget: { perIncidentUsd: 10, perMonthUsd: 100 },
      },
      "Ada",
    ),
  ).not.toHaveProperty("error");
  const loosen: Array<[Record<string, unknown>, string]> = [
    [{ autonomy: "deploy-right-away" }, "autonomy"],
    [{ neverWithoutYou: ["costs-money"] }, "neverWithoutYou"],
    [{ vetoMs: 600_000 }, "vetoMs"],
    [{ maxRounds: 3 }, "maxRounds"],
    [{ budget: { perIncidentUsd: 20 } }, "budget"],
    [{ budget: { perMonthUsd: 300 } }, "budget"],
    [{ agentsPaused: false }, "agentsPaused"],
    [{ night: null }, "night"],
    [{ night: { ...night, end: "06:00" } }, "night"],
  ];
  for (const [input, field] of loosen) {
    expect(await anonymous(input)).toEqual({
      error: "Only a signed-in person can loosen the incident policy",
      forbidden: true,
    });
    expect(kit.audits.at(-1)).toEqual({
      kind: "incident_settings_refused",
      project: "acme",
      by: "agent",
      fields: [field],
    });
  }
  const strict = await getProjectSettings("acme");
  expect(strict).toMatchObject({
    agentsPaused: true,
    autonomy: "propose",
    vetoMs: 1_200_000,
    maxRounds: 2,
    night,
    budget: { perIncidentUsd: 10, perMonthUsd: 100 },
  });
  expect(strict.neverWithoutYou).toHaveLength(5);
  // Tightening stays open.
  const tighter = await anonymous({
    autonomy: "watch",
    vetoMs: 1_800_000,
    maxRounds: 1,
    budget: { perIncidentUsd: 5, perMonthUsd: 50 },
  });
  expect(tighter).toMatchObject({
    autonomy: "watch",
    vetoMs: 1_800_000,
    maxRounds: 1,
    budget: { perIncidentUsd: 5, perMonthUsd: 50 },
  });
  // A person may loosen.
  expect(
    await update("acme", { agentsPaused: false, night: null }, "Ada"),
  ).toMatchObject({ agentsPaused: false });
  expect(await anonymous({ agentsPaused: true, night })).toMatchObject({
    agentsPaused: true,
    night,
  });
});

test("release refs must be commit SHAs; project ids are own keys", async () => {
  expect(
    await recordRelease("acme", {
      at: "2026-10-20T10:00:00.000Z",
      source: "hook",
      ref: "main",
    }),
  ).toEqual({ error: "Invalid ref" });
  expect((await getProjectSettings("acme")).releases).toEqual([]);
  await recordRelease("acme", {
    at: "2026-10-20T10:00:00.000Z",
    source: "hook",
    ref: "abc1234",
  });
  expect((await getProjectSettings("acme")).releases[0]?.ref).toBe("abc1234");
  __setProjectSettingsContextForTest({ modelProblem: () => null });
  expect(await update("constructor", { autonomy: "watch" }, "Ada")).toEqual({
    error: "Unknown project constructor",
  });
});
test("server-side writes keep the record's own rules and need a real project", async () => {
  await expect(
    patchProjectSettings("acme-gone", (p) => ({ ...p, automationId: "a" })),
  ).rejects.toThrow("Unknown project acme-gone");
  await expect(
    patchProjectSettings("acme", (p) => ({
      ...p,
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
    })),
  ).rejects.toThrow(
    "Action deploy runs on runner-lab, which is not one of the project's production Runners",
  );
  expect((await getProjectSettings("acme")).actions).toEqual([]);
  expect(
    await recordRelease("acme-gone", {
      at: "2026-10-20T10:00:00.000Z",
      source: "hook",
    }),
  ).toEqual({ error: "Unknown project acme-gone" });
});
