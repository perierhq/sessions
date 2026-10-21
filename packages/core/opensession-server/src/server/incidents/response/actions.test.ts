import { afterEach, beforeEach, expect, test } from "bun:test";
import type { IncidentAction } from "../../../shared/incident-response";
import { RunnerUnavailableError, type RunnerExecResult } from "../../runner-ws";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  type ActionDeps,
  __resetReleaseHookLimitForTest,
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

test("runs on the Runner as the incident service, the command on stdin only", async () => {
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
    "exec bash -s",
    {
      timeoutMs: 600_000,
      repo: "acme",
      // One group with its own stdin: a step cannot read the rest.
      stdin: "{\n./rollback.sh 'abc1234' --incident 'inc-1'\n} </dev/null\n",
      auditCommand: "incident action rollback",
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

test.skipIf(!Bun.which("bash"))(
  "a step that reads stdin cannot swallow the rest of the script",
  async () => {
    const seenOutput: string[] = [];
    const run = await runIncidentAction(
      {
        runId: "act-bash",
        incidentId: "inc-1",
        round: 1,
        project: "acme",
        action: {
          ...action,
          command:
            "echo one\ncat\nread -r line || echo none\necho {{incident}}",
        },
        vars,
        owner: "Ada",
        purpose: "plan",
      },
      {
        // The Runner runs `bash -lc <command>` with the input on stdin.
        exec: async (_runner, command, opts) => {
          const proc = Bun.spawn(["bash", "-c", command], {
            stdin: new TextEncoder().encode(opts.stdin),
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          seenOutput.push(stdout);
          return { code, stdout, stderr };
        },
        now: () => 0,
      },
    );
    expect(run).toMatchObject({ status: "ok", exitCode: 0 });
    expect(seenOutput).toEqual(["one\nnone\ninc-1\n"]);
  },
);
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
  expect(kit.audits).toHaveLength(3);
});

test("a Runner problem leaves the outcome unknown, never failed", async () => {
  const unknown = (r: Partial<RunnerExecResult> | Error) =>
    runIncidentAction(
      {
        runId: "act-4",
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
  const cases: Array<[Partial<RunnerExecResult> | Error, string]> = [
    [
      new RunnerUnavailableError("Runner prod-1 is offline"),
      "Runner prod-1 is offline. The action did not start",
    ],
    [
      new RunnerUnavailableError("Runner prod-1 is in maintenance"),
      "Runner prod-1 is in maintenance. The action did not start",
    ],
    [
      new RunnerUnavailableError(
        "Update Runner prod-1: it is too old to run incident checks and actions",
      ),
      "Update Runner prod-1: it is too old to run incident checks and actions. The action did not start",
    ],
    [
      new Error("socket closed"),
      "The Runner failed while the action started: socket closed. Check production before going on",
    ],
    [
      { code: -1, stderr: "half done\n[Runner disconnected]" },
      "The Runner disconnected while the action ran. Check production before going on",
    ],
    // Refused or never spawned: nothing ran.
    [
      new Error("Command input is too large"),
      "Command input is too large. The action did not start",
    ],
    [
      { code: -1, stderr: 'Executable not found in $PATH: "bash"' },
      'The Runner could not start the action: Executable not found in $PATH: "bash". The action did not start',
    ],
    [
      { code: -1, stderr: "Could not reach Runner: socket closed" },
      "The Runner could not start the action: Could not reach Runner: socket closed. The action did not start",
    ],
    [{ code: -1, stderr: "" }, "The Runner could not start the action"],
  ];
  for (const [result, detail] of cases)
    expect(await unknown(result)).toMatchObject({ status: "unknown", detail });
  expect(kit.audits.map((a) => a.status)).toEqual(cases.map(() => "unknown"));
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
  // A rollback is never what a rollback goes back past: the target is what
  // was live before the newest release that was not a rollback.
  expect(
    previousReleaseRef({
      ...s,
      releases: [
        { at: "c", source: "action", ref: "aaaaaaa", rollback: true },
        { at: "b", source: "action", ref: "bbbbbbb" },
        { at: "a", source: "hook", ref: "aaaaaaa" },
      ],
    }),
  ).toBe("aaaaaaa");
  expect(
    previousReleaseRef({
      ...s,
      releases: [
        { at: "d", source: "hook", ref: "ccccccc" },
        { at: "c", source: "action", ref: "aaaaaaa", rollback: true },
        { at: "b", source: "action", ref: "bbbbbbb" },
        { at: "a", source: "hook", ref: "aaaaaaa" },
      ],
    }),
  ).toBe("aaaaaaa");
});

test("the release hook takes at most 30 releases a minute per project", async () => {
  __resetReleaseHookLimitForTest();
  const s = await updateProjectSettings("acme", { autonomy: "propose" }, "Ada");
  if ("error" in s) throw new Error(s.error);
  const route = incidentReleaseHookRoutes().get("POST /incident-releases/*")!;
  const post = () => {
    const url = new URL(
      `https://hooks.example.test/incident-releases/acme/${s.releaseHookSecret}`,
    );
    return route(new Request(url, { method: "POST" }), url);
  };
  for (let i = 0; i < 30; i++) expect((await post()).status).toBe(200);
  const limited = await post();
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ error: "Too many releases" });
  __resetReleaseHookLimitForTest();
  expect((await post()).status).toBe(200);
});
