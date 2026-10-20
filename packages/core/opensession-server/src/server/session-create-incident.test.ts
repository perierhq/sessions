// An incident agent's create goes through the real SessionControl path: the
// binding is re-resolved at spawn, and the session stores the policy narrowed
// to that fresh access (not the one the caller asked for). The spawn is
// audited only once the session exists.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = join(
  import.meta.dir,
  "testing/unattended-runner-create-fixture.ts",
);

describe("incident agent create", () => {
  test("stores the policy narrowed at spawn and audits the created session", async () => {
    const root = mkdtempSync(join(tmpdir(), "incident-create-"));
    try {
      const proc = Bun.spawn([process.execPath, fixture], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH || "",
          UNATTENDED_RUNNER_CREATE_ROOT: root,
          UNATTENDED_RUNNER_CREATE_INCIDENT: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (exitCode !== 0)
        throw new Error(
          `Incident create fixture failed (${exitCode}): ${stderr}`,
        );
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
      if (!line)
        throw new Error(
          `Incident create fixture produced no result: ${stdout}`,
        );
      const result = JSON.parse(line.slice("RESULT:".length)) as any;
      expect(result.session.automationDescendantPolicy).toMatchObject({
        mcpServers: [],
        incident: {
          incidentId: "inc-fixture",
          role: "investigator",
          signalId: null,
          accessRevision: "r-narrowed",
        },
      });
      const kinds = result.incidentAudits.map((e: any) => e.kind);
      expect(kinds.indexOf("incident_access_spawn_allowed")).toBeGreaterThan(
        -1,
      );
      expect(result.incidentAudits).toContainEqual(
        expect.objectContaining({
          kind: "incident_access_spawn",
          incident_id: "inc-fixture",
          session_id: result.created.id,
          revision: "r-narrowed",
          repo: "renderer",
          mode: "code",
        }),
      );
      expect(kinds.indexOf("incident_access_spawn")).toBeGreaterThan(
        kinds.indexOf("incident_access_spawn_allowed"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
