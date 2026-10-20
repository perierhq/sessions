import { afterEach, beforeEach, expect, test } from "bun:test";
import { configuredServer } from "../../config";
import {
  INCIDENT_SERVICE_USER,
  authenticateRunner,
  createRunnerPairing,
  getRunner,
  listRunners,
  registerRunner,
  updateRunner,
} from "../../runners";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  __setProjectSettingsContextForTest,
  getProjectSettings,
  productionRunnerProblem,
} from "./project-settings";
import {
  __flushProductionBindingsForTest,
  bindProductionRunner,
  listProductionRunnerCandidates,
  productionRunOnProblem,
  runnerLabel,
  startProductionPairing,
} from "./runners";

// The fixture points OPENSESSION_STATE_DIR at a scratch dir per test, so the
// Runner store is scratch too.
const kit = useIncidentTestKernel();
beforeEach(() =>
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme" || id === "acme-api",
  }),
);
afterEach(() => __setProjectSettingsContextForTest(undefined));

const person = { signedInPerson: true };

function register(
  code: string,
  name: string,
  platform: "linux" | "darwin" | "win32" = "linux",
) {
  const out = registerRunner({
    code,
    name,
    platform,
    arch: "x64",
    address: "100.64.0.9",
  });
  if (!out.ok) throw new Error(out.error);
  return out.runner;
}

/** A Runner paired the ordinary way, open to every repository. */
function plainRunner(
  name: string,
  platform: "linux" | "darwin" | "win32" = "linux",
) {
  return register(createRunnerPairing("Ada").code, name, platform);
}

function startPairing(project: string) {
  const pairing = startProductionPairing(project, "Ada", person);
  if ("error" in pairing) throw new Error(pairing.error);
  return pairing;
}

test("pairing for production reserves a new Runner for the project", async () => {
  const pairing = startPairing("acme");
  expect(pairing.command).toBe(
    `opensession runner connect --server ${configuredServer().publicBaseUrl} --code ${pairing.code}`,
  );
  expect(kit.audits).toContainEqual({
    kind: "incident_runner_pairing_started",
    project: "acme",
    by: "Ada",
    expiresAt: pairing.expiresAt,
  });
  expect(JSON.stringify(kit.audits)).not.toContain(pairing.code);
  const runner = register(pairing.code, "prod-1");
  await __flushProductionBindingsForTest(); // the callback is fire-and-forget
  expect(getRunner(runner.id)).toMatchObject({
    incidentReserved: true,
    allowedRepos: ["acme"],
    allowedUsers: [INCIDENT_SERVICE_USER],
    label: "Production · acme",
    permissions: {
      commands: true,
      fullSessions: false,
      terminals: false,
      portals: false,
      automationDescendants: false,
    },
  });
  expect((await getProjectSettings("acme")).productionRunners).toEqual([
    runner.id,
  ]);
  expect(kit.audits).toContainEqual({
    kind: "incident_runner_paired",
    project: "acme",
    runnerId: runner.id,
    by: "Ada",
  });
  expect(productionRunnerProblem(runner.id, "acme")).toBeNull();
  expect(runnerLabel(runner.id)).toBe("Production · acme");
});

test("a production pairing never takes over a Runner with the same name", async () => {
  const existing = plainRunner("prod-1");
  const runner = register(startPairing("acme").code, "prod-1");
  await __flushProductionBindingsForTest();
  expect(runner.id).not.toBe(existing.id);
  expect(getRunner(existing.id)?.incidentReserved).toBeUndefined();
  expect(getRunner(existing.id)?.allowedRepos).toEqual([]);
});

test("a production Runner is reserved from the moment it registers", async () => {
  const pairing = startPairing("acme");
  // Before any binding runs: never an ordinary open Runner, even briefly.
  const out = registerRunner({
    code: pairing.code,
    name: "prod-1",
    platform: "linux",
    arch: "x64",
    address: "100.64.0.9",
  });
  if (!out.ok) throw new Error(out.error);
  expect(out.runner).toMatchObject({
    incidentReserved: true,
    allowedRepos: ["acme"],
    allowedUsers: [INCIDENT_SERVICE_USER],
    label: "Production · acme",
    permissions: { commands: true, fullSessions: false, terminals: false },
  });
  expect(getRunner(out.runner.id)?.incidentReserved).toBe(true);
  await __flushProductionBindingsForTest();
});

test("a Windows machine cannot use a production pairing code", async () => {
  const pairing = startPairing("acme");
  const out = registerRunner({
    code: pairing.code,
    name: "win-1",
    platform: "win32",
    arch: "x64",
    address: "100.64.0.9",
  });
  expect(out).toEqual({
    ok: false,
    error:
      "Windows Runners cannot serve incidents. Pair a macOS or Linux machine",
  });
  await __flushProductionBindingsForTest();
  expect(listRunners()).toEqual([]);
  expect((await getProjectSettings("acme")).productionRunners).toEqual([]);
});

test("a production Runner whose binding fails is removed", async () => {
  const pairing = startPairing("acme");
  // The project is deleted before the machine registers.
  __setProjectSettingsContextForTest({ projectExists: () => false });
  const out = registerRunner({
    code: pairing.code,
    name: "prod-1",
    platform: "linux",
    arch: "x64",
    address: "100.64.0.9",
  });
  if (!out.ok) throw new Error(out.error);
  await __flushProductionBindingsForTest();
  expect(getRunner(out.runner.id)).toBeUndefined();
  expect(authenticateRunner(out.runner.id, out.token)).toBeUndefined();
  expect(listRunners()).toEqual([]);
});

test("pairing needs a signed-in person and a real project", () => {
  expect(startProductionPairing("acme", "Ada", {})).toEqual({
    error: "Only a signed-in person can pair a production Runner",
  });
  expect(startProductionPairing("nope", "Ada", person)).toEqual({
    error: "Unknown project nope",
  });
  expect(kit.audits).toEqual([]);
});

test("binding a Runner that serves other repositories needs confirmation", async () => {
  const shared = plainRunner("shared");
  await expect(
    bindProductionRunner("acme", shared.id, "Ada", person),
  ).rejects.toThrow(
    "Runner shared serves every repository. Confirm to reserve it for acme incidents only",
  );
  expect(getRunner(shared.id)?.incidentReserved).toBeUndefined();
  updateRunner(shared.id, { allowedRepos: ["acme", "acme-api"] });
  await expect(
    bindProductionRunner("acme", shared.id, "Ada", person),
  ).rejects.toThrow(
    "Runner shared serves acme-api. Confirm to reserve it for acme incidents only",
  );
  await bindProductionRunner("acme", shared.id, "Ada", person, {
    confirmShared: true,
  });
  expect(getRunner(shared.id)).toMatchObject({
    incidentReserved: true,
    allowedRepos: ["acme"],
  });
  // One reserved Runner may serve the incidents of a second project, with
  // confirmation; binding again adds nothing twice.
  await expect(
    bindProductionRunner("acme-api", shared.id, "Bo", person),
  ).rejects.toThrow("Runner shared serves acme");
  await bindProductionRunner("acme-api", shared.id, "Bo", person, {
    confirmShared: true,
  });
  await bindProductionRunner("acme", shared.id, "Ada", person);
  expect(getRunner(shared.id)?.allowedRepos).toEqual(["acme", "acme-api"]);
  expect((await getProjectSettings("acme")).productionRunners).toEqual([
    shared.id,
  ]);
  await expect(
    bindProductionRunner("acme", "runner-nope", "Ada", person),
  ).rejects.toThrow("Runner runner-nope is not paired");
  await expect(
    bindProductionRunner("nope", shared.id, "Ada", person, {
      confirmShared: true,
    }),
  ).rejects.toThrow("Unknown project nope");
});

test("binding needs a signed-in person", async () => {
  const runner = plainRunner("lab");
  await expect(
    bindProductionRunner("acme", runner.id, "Ada", {}, { confirmShared: true }),
  ).rejects.toThrow("Only a signed-in person can bind a production Runner");
  expect(getRunner(runner.id)?.incidentReserved).toBeUndefined();
  expect((await getProjectSettings("acme")).productionRunners).toEqual([]);
});

test("Windows Runners cannot serve incidents", async () => {
  const win = plainRunner("win", "win32");
  await expect(
    bindProductionRunner("acme", win.id, "Ada", person, {
      confirmShared: true,
    }),
  ).rejects.toThrow("Runner win runs Windows");
  expect(getRunner(win.id)?.incidentReserved).toBeUndefined();
});

test("candidates explain what binding a Runner would do", async () => {
  const apiOnly = register(startPairing("acme-api").code, "api-only");
  const win = plainRunner("win", "win32");
  const open = plainRunner("open");
  await __flushProductionBindingsForTest();
  const views = listProductionRunnerCandidates("acme", []);
  expect(views.find((v) => v.name === "api-only")).toMatchObject({
    id: apiOnly.id,
    platform: "linux",
    online: false,
    bound: false,
    problem: null,
    confirm: "Runner api-only serves acme-api",
  });
  expect(views.find((v) => v.name === "open")).toMatchObject({
    id: open.id,
    problem: null,
    confirm: "Runner open serves every repository",
  });
  expect(views.find((v) => v.name === "win")).toMatchObject({
    id: win.id,
    problem:
      "Runner win runs Windows; incident checks and actions need macOS or Linux",
  });
  // A bound Runner reports what is wrong with it now.
  expect(listProductionRunnerCandidates("acme-api", [apiOnly.id])[0]).toEqual(
    expect.objectContaining({ bound: true, problem: null }),
  );
  expect(productionRunnerProblem(open.id, "acme")).toBe(
    "Runner open is not reserved for incidents. Bind it to acme first",
  );
  expect(runnerLabel(undefined)).toBe("the Sessions server");
  expect(runnerLabel("runner-gone")).toBe("runner-gone");
});

test("a check runs only from a reserved production Runner of its project", async () => {
  const runner = register(startPairing("acme").code, "prod-1");
  const lab = plainRunner("lab");
  await __flushProductionBindingsForTest();
  expect(await productionRunOnProblem(runner.id, "acme")).toBeNull();
  expect(await productionRunOnProblem(runner.id, "acme-api")).toBe(
    "Runner Production · acme is not a production Runner for acme-api",
  );
  expect(await productionRunOnProblem(lab.id, "acme")).toBe(
    "Runner lab is not a production Runner for acme",
  );
  updateRunner(runner.id, { maintenance: true });
  expect(await productionRunOnProblem(runner.id, "acme")).toBeNull();
});
