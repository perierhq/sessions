import { afterEach, expect, test } from "bun:test";
import type { AgentAccess } from "../../../shared/incident-access";
import type { RunnerExecOptions } from "../../runner-ws";
import { agentAccessFixture } from "../testing/access-fixture";
import { __setBindingResolverForTest } from "./resolve";
import { execForIncidentAgent, runnerGrantProblem } from "./runner-exec";
import type { IncidentToolContext } from "./tool-context";

afterEach(() => __setBindingResolverForTest(undefined));

const granted = (over: Partial<AgentAccess> = {}) =>
  agentAccessFixture({
    hosts: [{ runner: "rn-prod", runnerName: "prod-1", access: "read-only" }],
    egress: {
      route: "runner",
      runner: "rn-prod",
      runnerName: "prod-1",
      hosts: ["search.example.test"],
    },
    ...over,
  });
const ctx = (access = granted()): IncidentToolContext => ({
  sessionId: "os-1",
  binding: {
    incidentId: "inc-1",
    role: "investigator",
    signalId: null,
    accessRevision: "r1",
    spawn: { hosts: [], credentials: [], egress: null },
  },
  access,
});

test("a Runner is granted as a host (with its SSH alias) or as the egress route", () => {
  const a = granted({
    hosts: [
      { runner: "rn-prod", runnerName: "prod-1", access: "read-only" },
      {
        runner: "rn-prod",
        runnerName: "prod-1",
        ssh: "db-1",
        access: "read-only",
      },
    ],
  });
  expect(runnerGrantProblem(a, { use: "host", runner: "rn-prod" })).toBeNull();
  expect(
    runnerGrantProblem(a, { use: "host", runner: "rn-prod", ssh: "db-1" }),
  ).toBeNull();
  expect(
    runnerGrantProblem(a, { use: "host", runner: "rn-prod", ssh: "db-2" }),
  ).toBe("db-2 via prod-1 is not one of this agent's hosts");
  expect(runnerGrantProblem(a, { use: "host", runner: "rn-other" })).toBe(
    "rn-other is not one of this agent's hosts",
  );
  expect(
    runnerGrantProblem(a, { use: "egress", runner: "rn-prod" }),
  ).toBeNull();
  expect(
    runnerGrantProblem(granted({ egress: null }), {
      use: "egress",
      runner: "rn-prod",
    }),
  ).toBe("rn-prod is not this agent's egress route");
});

test("the command goes out as the read-only caller, and authorizes against fresh access", async () => {
  let seen: {
    runner: string;
    command: string;
    opts: RunnerExecOptions;
  } | null = null;
  let fresh = granted();
  __setBindingResolverForTest(async () => fresh);
  const exec = async (
    runner: string,
    command: string,
    opts: RunnerExecOptions = {},
  ) => {
    seen = { runner, command, opts };
    const refusal = await opts.caller!.authorize();
    if (refusal) throw new Error(`Access refused: ${refusal}`);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const out = await execForIncidentAgent(
    ctx(),
    { use: "host", runner: "rn-prod" },
    "exec bash -s",
    {
      stdin: "{ 'uptime'\n} </dev/null\n",
      label: "incident host_command uptime",
      timeoutMs: 5_000,
    },
    { exec },
  );
  expect(out.stdout).toBe("ok");
  expect(seen!).toMatchObject({
    runner: "rn-prod",
    command: "exec bash -s",
    opts: {
      repo: "acme",
      sessionId: "os-1",
      stdin: "{ 'uptime'\n} </dev/null\n",
      auditCommand: "incident host_command uptime",
      timeoutMs: 5_000,
      caller: {
        kind: "incident-agent-readonly",
        incidentId: "inc-1",
        role: "investigator",
        use: "host",
      },
    },
  });
  expect(seen!.opts.aws).toBeUndefined();
  expect(seen!.opts.user).toBeUndefined();

  // The grant was withdrawn after the tool call resolved its access.
  fresh = granted({ hosts: [] });
  await expect(
    execForIncidentAgent(
      ctx(),
      { use: "host", runner: "rn-prod" },
      "exec bash -s",
      { stdin: "", label: "incident host_command uptime", timeoutMs: 5_000 },
      { exec },
    ),
  ).rejects.toThrow("Access refused: rn-prod is not one of this agent's hosts");

  // A refused incident refuses too.
  __setBindingResolverForTest(async () => {
    throw new Error("Agents are paused for acme");
  });
  await expect(
    execForIncidentAgent(
      ctx(),
      { use: "egress", runner: "rn-prod" },
      "exec bash -s",
      {
        stdin: "",
        label: "incident egress GET search.example.test/q",
        timeoutMs: 5_000,
      },
      { exec },
    ),
  ).rejects.toThrow("Access refused: Agents are paused for acme");

  // Access resolved for another incident or role never authorizes.
  __setBindingResolverForTest(async () => granted({ role: "verifier" }));
  await expect(
    execForIncidentAgent(
      ctx(),
      { use: "host", runner: "rn-prod" },
      "exec bash -s",
      { stdin: "", label: "incident host_command uptime", timeoutMs: 5_000 },
      { exec },
    ),
  ).rejects.toThrow(
    "Access refused: The agent's access does not match its binding",
  );
});

test("only this module sends commands as the read-only incident agent caller", async () => {
  const root = new URL("../../..", import.meta.url).pathname;
  const users: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
    if (path.endsWith(".test.ts") || path.includes("node_modules")) continue;
    const text = await Bun.file(`${root}${path}`).text();
    if (text.includes('"incident-agent-readonly"')) users.push(path);
  }
  expect(users.sort()).toEqual([
    "server/incidents/access/runner-exec.ts",
    "server/runner-ws.ts",
  ]);
});
