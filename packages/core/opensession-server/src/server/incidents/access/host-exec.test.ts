import { beforeEach, expect, test } from "bun:test";
import type { ResolvedHost } from "../../../shared/incident-access";
import type {
  RunnerExecOptions,
  RunnerExecResult,
  execOnRunner,
} from "../../runner-ws";
import { agentAccessFixture } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { type HostExecDeps, runHostCommand } from "./host-exec";
import type { IncidentToolContext } from "./tool-context";

const kit = useIncidentTestKernel();
const ctx = (
  hosts: ResolvedHost[] = [
    { runner: "rn-prod", runnerName: "prod-1", access: "read-only" },
    {
      runner: "rn-prod",
      runnerName: "prod-1",
      ssh: "db-1",
      access: "read-only",
    },
  ],
): IncidentToolContext => ({
  sessionId: "os-1",
  binding: {
    incidentId: "inc-1",
    role: "investigator",
    signalId: null,
    accessRevision: "r1",
  },
  access: {
    ...agentAccessFixture(),
    hosts,
    credentials: [
      {
        credential: "kc-proxy",
        service: "proxy-api",
        host: "api.proxy.example.test",
        mode: "once",
        scope: "personal",
      },
    ],
  },
});
let calls: Array<{ runner: string; command: string; opts: RunnerExecOptions }> =
  [];
let scrubbedWith: string[][] = [];
const deps = (out: Partial<RunnerExecResult> = {}): HostExecDeps => ({
  connected: () => true,
  scrub: (t, ids) => {
    scrubbedWith.push(ids);
    return t.replaceAll("s3cret", "[scrubbed]");
  },
  exec: (async (runner: string, command: string, opts: RunnerExecOptions) => {
    calls.push({ runner, command, opts });
    return { code: 0, stdout: "ok", stderr: "", ...out };
  }) as typeof execOnRunner,
});
beforeEach(() => {
  calls = [];
  scrubbedWith = [];
});

test("runs a normalized argv, quoted, as nobody and without AWS", async () => {
  const out = await runHostCommand(
    ctx(),
    {
      runner: "prod-1",
      program: "journalctl",
      args: ["-u", "app", "--since", "-1h"],
    },
    deps(),
  );
  expect(out).toEqual({
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: "ok",
    stderr: "",
    truncated: false,
  });
  expect(calls[0]).toEqual({
    runner: "rn-prod",
    command: "journalctl -u app --since -1h --no-pager",
    opts: { timeoutMs: 60_000, sessionId: "os-1", aws: false },
  });
  expect(scrubbedWith[0]).toEqual(["kc-proxy"]);
  expect(kit.audits).toContainEqual({
    kind: "incident_host_command",
    incident_id: "inc-1",
    incident_role: "investigator",
    session_id: "os-1",
    runner_id: "rn-prod",
    program: "journalctl",
    args: "-u app --since -1h",
    exit_code: 0,
    timed_out: false,
    duration_ms: expect.any(Number),
  });
});
test("metacharacters stay data", async () => {
  await runHostCommand(
    ctx(),
    {
      runner: "rn-prod",
      program: "grep",
      args: ["-c", "403; rm -rf /", "/var/log/app/access.log"],
    },
    deps(),
  );
  expect(calls[0].command).toBe(
    "grep -c '403; rm -rf /' /var/log/app/access.log",
  );
});
test("ssh hosts go through the Runner with a fixed option set", async () => {
  await runHostCommand(
    ctx(),
    {
      runner: "prod-1",
      ssh: "db-1",
      program: "cat",
      args: ["/var/log/db.log"],
    },
    deps(),
  );
  expect(calls[0].command).toBe(
    "ssh -o BatchMode=yes -o ConnectTimeout=10 -- db-1 'cat /var/log/db.log'",
  );
  await runHostCommand(
    ctx(),
    {
      runner: "prod-1",
      ssh: "db-1",
      program: "grep",
      args: ["-c", "$(id)", "/var/log/db.log"],
    },
    deps(),
  );
  // Quoted once for the Runner's shell and once for the remote one.
  expect(calls[1].command).toBe(
    String.raw`ssh -o BatchMode=yes -o ConnectTimeout=10 -- db-1 'grep -c '\''$(id)'\'' /var/log/db.log'`,
  );
});
test("refusals: other hosts, other programs, offline Runners", async () => {
  expect(
    await runHostCommand(ctx(), { runner: "prod-2", program: "ls" }, deps()),
  ).toEqual({ ok: false, error: "prod-2 is not one of this agent's hosts" });
  expect(
    await runHostCommand(
      ctx(),
      { runner: "prod-1", ssh: "db-2", program: "ls" },
      deps(),
    ),
  ).toEqual({
    ok: false,
    error: "db-2 via prod-1 is not one of this agent's hosts",
  });
  expect(
    await runHostCommand(
      ctx(),
      { runner: "prod-1", ssh: "-oProxyCommand=id", program: "ls" },
      deps(),
    ),
  ).toEqual({
    ok: false,
    error: "-oProxyCommand=id via prod-1 is not one of this agent's hosts",
  });
  expect(
    await runHostCommand(
      ctx(),
      { runner: "prod-1", program: "docker", args: ["exec", "app", "sh"] },
      deps(),
    ),
  ).toEqual({ ok: false, error: "docker exec is not allowed" });
  expect(kit.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_host_denied",
      program: "docker",
    }),
  );
  expect(
    await runHostCommand(
      ctx(),
      { runner: "prod-1", program: "ls" },
      { ...deps(), connected: () => false },
    ),
  ).toEqual({ ok: false, error: "prod-1 is offline" });
  expect(calls).toEqual([]);
});
test("output is capped and scrubbed; timeouts clamp", async () => {
  const out = await runHostCommand(
    ctx(),
    {
      runner: "prod-1",
      program: "cat",
      args: ["/var/log/app.log"],
      timeoutSeconds: 9999,
    },
    deps({ stdout: "s3cret " + "x".repeat(70_000) }),
  );
  expect(out).toMatchObject({ ok: true, truncated: true });
  expect(out.ok && out.stdout.startsWith("[scrubbed]")).toBe(true);
  expect(out.ok && out.stdout.length).toBeLessThanOrEqual(65_536);
  expect(calls[0].opts.timeoutMs).toBe(300_000);
  await runHostCommand(
    ctx(),
    { runner: "prod-1", program: "ls", timeoutSeconds: 0 },
    deps(),
  );
  expect(calls[1].opts.timeoutMs).toBe(1_000);
});
test("an exec failure is reported, not thrown", async () => {
  const out = await runHostCommand(
    ctx(),
    { runner: "prod-1", program: "ls" },
    {
      ...deps(),
      exec: (async () => {
        throw new Error("Runner rn-prod is not connected");
      }) as unknown as typeof execOnRunner,
    },
  );
  expect(out).toEqual({
    ok: false,
    error: "Could not run on prod-1: Runner rn-prod is not connected",
  });
});
test("long arguments are cut in the audit", async () => {
  await runHostCommand(
    ctx(),
    {
      runner: "prod-1",
      program: "grep",
      args: ["x".repeat(800), "/var/log/a.log"],
    },
    deps(),
  );
  const line = kit.audits.find((e) => e.kind === "incident_host_command");
  expect(String(line?.args).length).toBe(500);
});
