import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createRunnerPairing,
  getRunner,
  INCIDENT_SERVICE_USER,
  listRunners,
  registerRunner,
  removeRunner,
  reserveRunnerForIncidents,
} from "../runners";
import { handleRunnersRoutes } from "./runners";

const HOME = mkdtempSync(join(tmpdir(), "os-runner-routes-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});
beforeEach(() => {
  for (const runner of listRunners()) removeRunner(runner.id);
});

function runner(name: string) {
  const out = registerRunner({
    code: createRunnerPairing("Ada").code,
    name,
    platform: "linux",
    arch: "x64",
    address: "100.64.0.9",
  });
  if (!out.ok) throw new Error(out.error);
  return out.runner;
}

function patch(id: string, body: unknown) {
  const url = new URL(`http://localhost/api/runners/${id}`);
  return handleRunnersRoutes({
    req: new Request(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/opensession",
    authUser: { login: "ada", name: "Ada" },
  });
}

test("a reserved Runner's policy changes only through binding", async () => {
  const prod = runner("prod-1");
  reserveRunnerForIncidents(prod.id, { repos: ["acme"] });
  const refused = await patch(prod.id, {
    label: "Prod",
    allowedUsers: ["Ada"],
    permissions: { commands: true },
  });
  expect(refused?.status).toBe(409);
  expect(await refused?.json()).toEqual({
    error:
      "Runner prod-1 is reserved for incidents: only its label, description, location and maintenance can change",
  });
  expect(getRunner(prod.id)).toMatchObject({
    allowedUsers: [INCIDENT_SERVICE_USER],
  });
  expect(getRunner(prod.id)?.label).toBeUndefined();

  const ok = await patch(prod.id, {
    label: "Prod",
    description: "Production box",
    location: "eu-west",
    maintenance: true,
  });
  expect(ok?.status).toBe(200);
  expect(getRunner(prod.id)).toMatchObject({
    label: "Prod",
    description: "Production box",
    location: "eu-west",
    maintenance: true,
    incidentReserved: true,
    allowedRepos: ["acme"],
  });
});

test("an ordinary Runner's policy can still be patched", async () => {
  const lab = runner("lab");
  const res = await patch(lab.id, { allowedUsers: ["Ada"], label: "Lab" });
  expect(res?.status).toBe(200);
  expect(getRunner(lab.id)).toMatchObject({
    label: "Lab",
    allowedUsers: ["Ada"],
  });
});
