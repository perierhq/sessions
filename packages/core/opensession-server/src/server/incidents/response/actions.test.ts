import { afterEach, beforeEach, expect, test } from "bun:test";
import type { IncidentAction } from "../../../shared/incident-response";
import type { RunnerExecResult } from "../../runner-ws";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  type ActionDeps,
  incidentReleaseHookRoutes,
  newActionRunId,
  previousReleaseRef,
  renderActionCommand,
  runIncidentAction,
} from "./actions";
import {
  __setProjectSettingsContextForTest,
  getProjectSettings,
  updateProjectSettings,
} from "./project-settings";

const kit = useIncidentTestKernel();
beforeEach(() =>
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: () => null,
    modelProblem: () => null,
  }),
);
afterEach(() => __setProjectSettingsContextForTest(undefined));

const action: IncidentAction = {
  id: "rollback",
  kind: "rollback",
  label: "Roll back",
  runner: "runner-prod",
  command: "./rollback.sh {{previousRef}} --incident {{incident}}",
  timeoutMs: 600_000,
  reversible: true,
  cost: { kind: "none" },
  needsSecret: true,
  scope: { services: [], paths: [], migrationPaths: [] },
};
const vars = { incident: "inc-1", project: "acme", previousRef: "abc1234" };

test("renders quoted, validated values", () => {
  expect(renderActionCommand(action.command, vars)).toBe(
    "./rollback.sh 'abc1234' --incident 'inc-1'",
  );
  expect(
    renderActionCommand(action.command, {
      ...vars,
      previousRef: "abc; rm -rf /",
    }),
  ).toEqual({ error: "Invalid value for {{previousRef}}" });
  expect(renderActionCommand("./deploy.sh {{ref}}", vars)).toEqual({
    error: "{{ref}} has no value",
  });
  expect(
    renderActionCommand("./x.sh {{project}}", { ...vars, project: "a b" }),
  ).toEqual({ error: "Invalid value for {{project}}" });
  expect(
    renderActionCommand("./x.sh {{incident}}", { ...vars, incident: "x" }),
  ).toEqual({ error: "Invalid value for {{incident}}" });
  expect(renderActionCommand("./x.sh {{token}}", vars)).toEqual({
    error: "Unknown placeholder {{token}}",
  });
  expect(newActionRunId()).toMatch(/^act-[0-9a-f-]{36}$/);
});

test("runs on the Runner as the owner, audits without the command", async () => {
  const seen: unknown[] = [];
  const run = await runIncidentAction(
    {
      runId: "act-1",
      incidentId: "inc-1",
      round: 1,
      project: "acme",
      action,
      vars,
      owner: "Ada",
      purpose: "auto-rollback",
      sessionId: "sess-coord",
    },
    {
      exec: async (...args) => {
        seen.push(args);
        return { code: 0, stdout: "ok", stderr: "" };
      },
      now: () => 0,
    },
  );
  expect(run).toMatchObject({
    id: "act-1",
    status: "ok",
    detail: "Exit 0",
    secretTouched: true,
    purpose: "auto-rollback",
    round: 1,
    actionId: "rollback",
    kind: "rollback",
    label: "Roll back",
    runner: "runner-prod",
    exitCode: 0,
    ref: "abc1234",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(0).toISOString(),
  });
  expect(seen[0]).toEqual([
    "runner-prod",
    "./rollback.sh 'abc1234' --incident 'inc-1'",
    {
      timeoutMs: 600_000,
      user: "Ada",
      repo: "acme",
      sessionId: "sess-coord",
      cwd: undefined,
    },
  ]);
  expect(kit.audits.at(-1)).toEqual({
    kind: "incident_action",
    incidentId: "inc-1",
    actionId: "rollback",
    actionKind: "rollback",
    runner: "runner-prod",
    status: "ok",
    exitCode: 0,
    purpose: "auto-rollback",
    secretTouched: true,
  });
  expect(JSON.stringify(kit.audits)).not.toContain("rollback.sh");
  expect(JSON.stringify(run)).not.toContain("rollback.sh");
});

test("failures never throw", async () => {
  const fail = (r: Partial<RunnerExecResult> | Error) =>
    runIncidentAction(
      {
        runId: "act-2",
        incidentId: "inc-1",
        round: 1,
        project: "acme",
        action,
        vars,
        owner: "Ada",
        purpose: "plan",
      },
      {
        exec: async () => {
          if (r instanceof Error) throw r;
          return { code: 0, stdout: "", stderr: "", ...r };
        },
        now: () => 0,
      },
    );
  expect(
    await fail({ code: 2, stderr: "pulling\nimage not found\n" }),
  ).toMatchObject({
    status: "failed",
    exitCode: 2,
    detail: "Exit 2: image not found",
  });
  expect(await fail({ code: 3 })).toMatchObject({ detail: "Exit 3" });
  expect(await fail({ code: -1, timedOut: true })).toMatchObject({
    status: "failed",
    detail: "Timed out after 10 min",
  });
  expect(
    await fail(new Error("Runner runner-prod is not connected")),
  ).toMatchObject({
    status: "failed",
    detail: "Runner runner-prod is not connected",
  });
  expect(kit.audits).toHaveLength(4);
});

test("a render error fails the run without touching the Runner", async () => {
  let calls = 0;
  const deps: Partial<ActionDeps> = {
    exec: async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "" };
    },
    now: () => 0,
  };
  const run = await runIncidentAction(
    {
      runId: "act-3",
      incidentId: "inc-1",
      round: 1,
      project: "acme",
      action,
      vars: { incident: "inc-1", project: "acme" },
      owner: "Ada",
      purpose: "plan",
    },
    deps,
  );
  expect(run).toMatchObject({
    status: "failed",
    detail: "{{previousRef}} has no value",
  });
  expect(calls).toBe(0);
  expect(kit.audits.at(-1)).toMatchObject({
    kind: "incident_action",
    status: "failed",
  });
});

test("release hook records releases for rollback-first", async () => {
  // A real change, so the record is written with its hook secret.
  const s = await updateProjectSettings("acme", { autonomy: "propose" }, "Ada");
  if ("error" in s) throw new Error(s.error);
  if (!s.releaseHookSecret) throw new Error("no hook secret");
  const route = incidentReleaseHookRoutes().get("POST /incident-releases/*")!;
  const post = (path: string, body?: string) => {
    const url = new URL(`https://hooks.example.test${path}`);
    return route(new Request(url, { method: "POST", body }), url);
  };
  const ok = await post(
    `/incident-releases/acme/${s.releaseHookSecret}`,
    JSON.stringify({ ref: "def5678", note: `  ${"v4.2".padEnd(250, "!")}  ` }),
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  const latest = (await getProjectSettings("acme")).releases[0];
  expect(latest).toMatchObject({ source: "hook", ref: "def5678" });
  expect(latest?.note).toHaveLength(200);
  expect(
    (await post(`/incident-releases/acme/${s.releaseHookSecret}`)).status,
  ).toBe(200);
  expect((await getProjectSettings("acme")).releases).toHaveLength(2);

  expect((await post(`/incident-releases/acme/${"0".repeat(48)}`)).status).toBe(
    404,
  );
  expect(
    (await post(`/incident-releases/acme-api/${s.releaseHookSecret}`)).status,
  ).toBe(404);
  expect((await post(`/incident-releases/acme`)).status).toBe(400);
  expect(
    (
      await post(
        `/incident-releases/acme/${s.releaseHookSecret}`,
        JSON.stringify({ ref: "main" }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await post(`/incident-releases/acme/${s.releaseHookSecret}`, "not json"))
      .status,
  ).toBe(400);
  expect(
    (
      await post(
        `/incident-releases/acme/${s.releaseHookSecret}`,
        "x".repeat(10_001),
      )
    ).status,
  ).toBe(413);
  expect((await getProjectSettings("acme")).releases).toHaveLength(2);
  expect(
    previousReleaseRef({
      ...s,
      releases: [
        { at: "b", source: "action", ref: "bbbbbbb" },
        { at: "a", source: "hook", ref: "aaaaaaa" },
      ],
    }),
  ).toBe("aaaaaaa");
  expect(previousReleaseRef({ ...s, releases: [] })).toBeUndefined();
});
