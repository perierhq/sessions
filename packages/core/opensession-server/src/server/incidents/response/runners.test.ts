import { expect, test } from "bun:test";
import { configuredServer } from "../../config";
import { getRunner, registerRunner, updateRunner } from "../../runners";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { getProjectSettings } from "./project-settings";
import {
  __flushProductionBindingsForTest,
  bindProductionRunner,
  listProductionRunnerCandidates,
  runnerLabel,
  startProductionPairing,
} from "./runners";

// The fixture points OPENSESSION_STATE_DIR at a scratch dir per test, so the
// Runner store is scratch too.
const kit = useIncidentTestKernel();

function pair(name: string, platform: "linux" | "darwin" | "win32" = "linux") {
  const { code } = startProductionPairing("acme-api", "Ada");
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

test("pairing for production binds the Runner to the project, least privilege", async () => {
  const pairing = startProductionPairing("acme", "Ada");
  expect(pairing.command).toBe(
    `opensession runner connect --server ${configuredServer().publicBaseUrl} --code ${pairing.code}`,
  );
  const out = registerRunner({
    code: pairing.code,
    name: "prod-1",
    platform: "linux",
    arch: "x64",
    address: "100.64.0.9",
  });
  if (!out.ok) throw new Error(out.error);
  await __flushProductionBindingsForTest(); // the callback is fire-and-forget
  expect(getRunner(out.runner.id)).toMatchObject({
    allowedRepos: ["acme"],
    label: "Production · acme",
    permissions: { commands: true },
  });
  expect((await getProjectSettings("acme")).productionRunners).toEqual([
    out.runner.id,
  ]);
  expect(kit.audits).toContainEqual({
    kind: "incident_runner_paired",
    project: "acme",
    runnerId: out.runner.id,
    by: "Ada",
  });
  // Binding again adds nothing twice; a second project joins the list.
  await bindProductionRunner("acme", out.runner.id, "Ada");
  await bindProductionRunner("acme-api", out.runner.id, "Bo");
  expect(getRunner(out.runner.id)).toMatchObject({
    allowedRepos: ["acme", "acme-api"],
    label: "Production · acme",
  });
  expect((await getProjectSettings("acme")).productionRunners).toEqual([
    out.runner.id,
  ]);
  expect(runnerLabel(out.runner.id)).toBe("Production · acme");
  await expect(
    bindProductionRunner("acme", "runner-nope", "Ada"),
  ).rejects.toThrow("Runner runner-nope is not paired");
});
test("candidates explain why a Runner cannot serve a project", async () => {
  const apiOnly = pair("api-only");
  const win = pair("win", "win32");
  await __flushProductionBindingsForTest();
  // Allowed everywhere: the Windows Runner serves any project.
  updateRunner(win.id, { allowedRepos: [] });
  const views = listProductionRunnerCandidates("acme", [win.id]);
  expect(views.find((v) => v.name === "api-only")).toMatchObject({
    id: apiOnly.id,
    platform: "linux",
    online: false,
    bound: false,
    problem: "Runner api-only does not allow commands for acme",
  });
  expect(views.find((v) => v.name === "win")).toMatchObject({
    bound: true,
    problem: null,
    warning: "Windows Runners cannot run http checks",
  });
  expect(views.find((v) => v.name === "api-only")).not.toHaveProperty(
    "warning",
  );
  expect(runnerLabel(undefined)).toBe("the Sessions server");
  expect(runnerLabel("runner-gone")).toBe("runner-gone");
});
