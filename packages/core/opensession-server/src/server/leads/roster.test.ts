/**
 * GET /api/supervisor/leads: every project's lead from its stored settings
 * document, running leads first, with the label people know the project by
 * and the owner it answers to. The documents come from a stub; the route
 * reads nothing else.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import { defaultLeadSettings } from "../../shared/project-lead";

const root = mkdtempSync(join(tmpdir(), "lead-roster-test-"));
const savedState = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

const { __setLeadRosterDepsForTest, listLeadRoster } = await import("./roster");
const { handleSupervisorRoutes } = await import("../routes/supervisor");

afterEach(() => __setLeadRosterDepsForTest(undefined));
afterAll(() => {
  if (savedState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = savedState;
  rmSync(root, { recursive: true, force: true });
});

function doc(
  project: string,
  lead: Partial<ProjectSettingsDocument["lead"]>,
): ProjectSettingsDocument {
  return {
    project,
    lead: { ...defaultLeadSettings(), ...lead },
  } as ProjectSettingsDocument;
}

function stub(docs: ProjectSettingsDocument[]) {
  __setLeadRosterDepsForTest({
    listProjectDocuments: async () => docs,
    projectLabel: (project) => (project === "acme-web" ? "Acme web" : project),
    leadOwner: (d) => d.lead.owner ?? "",
  });
}

test("lists running leads first, then by label, with stage and owner", async () => {
  stub([
    doc("zeta", { enabled: false }),
    doc("beta", { enabled: true, stage: "act", owner: "Ada" }),
    doc("acme-web", { enabled: true, stage: "coordinate" }),
  ]);
  expect(await listLeadRoster()).toEqual([
    {
      project: "acme-web",
      label: "Acme web",
      enabled: true,
      stage: "coordinate",
    },
    {
      project: "beta",
      label: "beta",
      enabled: true,
      stage: "act",
      owner: "Ada",
    },
    { project: "zeta", label: "zeta", enabled: false, stage: "watch" },
  ]);
});

test("the route answers GET with the roster and nothing else", async () => {
  stub([doc("acme-web", { enabled: true, stage: "watch" })]);
  const call = (method: string) => {
    const url = new URL("http://localhost/api/supervisor/leads");
    return handleSupervisorRoutes({
      req: new Request(url, { method }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
    });
  };
  const res = await call("GET");
  expect(res?.status).toBe(200);
  expect(await res!.json()).toEqual({
    leads: [
      {
        project: "acme-web",
        label: "Acme web",
        enabled: true,
        stage: "watch",
      },
    ],
  });
  expect(await call("POST")).toBeUndefined();
});

test("no stored documents is an empty list", async () => {
  stub([]);
  expect(await listLeadRoster()).toEqual([]);
});
