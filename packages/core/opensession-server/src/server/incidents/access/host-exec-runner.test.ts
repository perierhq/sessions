// A granted host command or Runner egress request reaches a production Runner
// reserved for incidents through the real Runner channel, on the read-only
// incident agent path.
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAccess } from "../../../shared/incident-access";
import * as auditModule from "../../audit";
import { runnerWsClose, runnerWsMessage, runnerWsOpen } from "../../runner-ws";
import {
  createRunnerPairing,
  listRunners,
  registerRunner,
  removeRunner,
  reserveRunnerForIncidents,
} from "../../runners";
import { __setIncidentAuditForTest } from "../audit-sink";
import { agentAccessFixture } from "../testing/access-fixture";
import { egressFetch } from "./egress";
import { runHostCommand } from "./host-exec";
import { __setBindingResolverForTest } from "./resolve";
import type { IncidentToolContext } from "./tool-context";

const HOME = mkdtempSync(join(tmpdir(), "os-host-exec-runner-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;
const incidentAudits: Array<Record<string, unknown>> = [];
const restoreAudit = __setIncidentAuditForTest((e) => {
  incidentAudits.push(e);
});

afterEach(() => {
  for (const runner of listRunners()) removeRunner(runner.id);
  __setBindingResolverForTest(undefined);
  incidentAudits.length = 0;
});
afterAll(() => {
  __setIncidentAuditForTest(restoreAudit);
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});

type Answer = { stdout?: string; stderr?: string; code?: number };
const journal = (): Answer => ({ stdout: "-- Logs begin --\n" });

async function withReservedRunner(
  run: (id: string, sent: any[]) => Promise<void>,
  opts: { execStdin?: boolean; answer?: (exec: any) => Answer } = {},
) {
  const answer = opts.answer ?? journal;
  const { code } = createRunnerPairing("tester");
  const registered = registerRunner({
    code,
    name: "prod-1",
    platform: "linux",
    arch: "x64",
    address: "100.101.102.109",
  });
  if (!registered.ok) throw new Error(registered.error);
  const id = registered.runner.id;
  reserveRunnerForIncidents(id, { repos: ["acme"] });
  const sent: any[] = [];
  const ws = {
    data: { kind: "runner", runnerId: id },
    close() {},
    send(frame: string) {
      const message = JSON.parse(frame);
      sent.push(message);
      if (message.t === "exec")
        queueMicrotask(() => {
          const out = answer(message);
          const frame = {
            id: message.id,
            operationToken: message.operationToken,
          };
          for (const stream of ["stdout", "stderr"] as const)
            if (out[stream])
              runnerWsMessage(
                ws,
                JSON.stringify({
                  t: "out",
                  stream,
                  ...frame,
                  data: out[stream],
                }),
              );
          runnerWsMessage(
            ws,
            JSON.stringify({ t: "exit", ...frame, code: out.code ?? 0 }),
          );
        });
    },
  };
  runnerWsOpen(ws);
  runnerWsMessage(
    ws,
    JSON.stringify({
      t: "hello",
      version: 1,
      execStdin: opts.execStdin ?? true,
    }),
  );
  try {
    await run(id, sent);
  } finally {
    runnerWsClose(ws);
  }
}

const access = (runner: string, over: Partial<AgentAccess> = {}) =>
  agentAccessFixture({
    hosts: [{ runner, runnerName: "prod-1", access: "read-only" }],
    ...over,
  });
const ctx = (a: AgentAccess): IncidentToolContext => ({
  sessionId: "os-1",
  binding: {
    incidentId: "inc-1",
    role: "investigator",
    signalId: null,
    accessRevision: "r1",
    spawn: { hosts: [], credentials: [], egress: null },
  },
  access: a,
});

test("an agent with a host grant runs a read-only command on a reserved Runner; the audit has a label only", async () => {
  const audits = spyOn(auditModule, "auditAsync").mockImplementation(() => {});
  try {
    await withReservedRunner(async (id, sent) => {
      __setBindingResolverForTest(async () => access(id));
      const out = await runHostCommand(ctx(access(id)), {
        runner: "prod-1",
        program: "journalctl",
        args: ["-u", "acme-api", "--grep", "token=abc"],
      });
      expect(out).toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: "-- Logs begin --\n",
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        t: "exec",
        command: "exec bash -s",
        label: "incident host_command journalctl",
      });
      expect(sent[0].stdin).toContain(
        "journalctl -u acme-api --grep token=abc",
      );
      expect(sent[0].awsEnv).toBeUndefined();
    });
    const runnerAudit = JSON.stringify(audits.mock.calls.map((c) => c[0]));
    expect(runnerAudit).toContain("incident host_command journalctl");
    expect(runnerAudit).not.toContain("acme-api");
    expect(runnerAudit).not.toContain("token=abc");
  } finally {
    audits.mockRestore();
  }
});

test("without the grant, at the tool or at dispatch, nothing reaches the Runner", async () => {
  await withReservedRunner(async (id, sent) => {
    // Not one of its hosts.
    expect(
      await runHostCommand(ctx(access(id, { hosts: [] })), {
        runner: "prod-1",
        program: "uptime",
      }),
    ).toEqual({ ok: false, error: "prod-1 is not one of this agent's hosts" });
    // Granted when the call started, withdrawn before dispatch.
    __setBindingResolverForTest(async () => access(id, { hosts: [] }));
    expect(
      await runHostCommand(ctx(access(id)), {
        runner: "prod-1",
        program: "uptime",
      }),
    ).toEqual({
      ok: false,
      error:
        "Could not run on prod-1: Access refused: " +
        `${id} is not one of this agent's hosts`,
    });
    expect(sent).toEqual([]);
  });
});

const egressAccess = (runner: string) =>
  agentAccessFixture({
    egress: {
      route: "runner",
      runner,
      runnerName: "prod-1",
      hosts: ["search.example.test"],
    },
  });
/** A Runner that resolves the name, has curl 8.5 and answers the request. */
const egressAnswer = (exec: any): Answer => {
  if (String(exec.command).includes("getent"))
    return { stdout: "93.184.216.34 STREAM search.example.test\n" };
  if (exec.command === "command curl --version")
    return { stdout: "curl 8.5.0 (x86_64-pc-linux-gnu)\n" };
  return {
    stdout: "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nok",
    stderr: "\n__SESSIONS_CURL__200\n",
  };
};

test("Runner egress on a reserved Runner: the request is on stdin, argv and audits carry none of it", async () => {
  const audits = spyOn(auditModule, "auditAsync").mockImplementation(() => {});
  try {
    await withReservedRunner(
      async (id, sent) => {
        __setBindingResolverForTest(async () => egressAccess(id));
        const out = await egressFetch(ctx(egressAccess(id)), {
          url: "https://search.example.test/q?token=abc",
          method: "POST",
          headers: { "User-Agent": "acme-app/4.2" },
          body: "@secret-body",
        });
        expect(out).toMatchObject({ ok: true, status: 200, body: "ok" });
        // Resolve, curl version, request: each a fixed command.
        expect(sent.map((m) => m.t)).toEqual(["exec", "exec", "exec"]);
        for (const frame of sent) {
          expect(frame.label).toBe(
            "incident egress POST search.example.test/q",
          );
          expect(frame.awsEnv).toBeUndefined();
          for (const secret of [
            "search.example.test",
            "token=abc",
            "secret-body",
            "acme-app",
          ])
            expect(frame.command).not.toContain(secret);
        }
        expect(sent[0].stdin).toBe("search.example.test\n");
        const curl = sent[2];
        expect(curl.command).toStartWith("command curl --disable --config - ");
        // An @ at the start of the body is text, never a file on the Runner.
        expect(curl.stdin).toContain('data-raw = "@secret-body"');
        expect(curl.stdin).toContain(
          'url = "https://search.example.test/q?token=abc"',
        );
      },
      { answer: egressAnswer },
    );
    const runnerAudit = JSON.stringify(audits.mock.calls.map((c) => c[0]));
    expect(runnerAudit).toContain("incident egress POST search.example.test/q");
    expect(runnerAudit).toContain("incident-agent-readonly");
    const incidentAudit = JSON.stringify(incidentAudits);
    for (const secret of ["token=abc", "secret-body", "acme-app"]) {
      expect(runnerAudit).not.toContain(secret);
      expect(incidentAudit).not.toContain(secret);
    }
  } finally {
    audits.mockRestore();
  }
});

test("a Runner without command input is a Runner problem: update the Runner, nothing is sent", async () => {
  await withReservedRunner(
    async (id, sent) => {
      __setBindingResolverForTest(async () => access(id));
      expect(
        await runHostCommand(ctx(access(id)), {
          runner: "prod-1",
          program: "uptime",
        }),
      ).toEqual({
        ok: false,
        error:
          "Could not run on prod-1: Update Runner prod-1: it is too old to run incident agent commands",
      });
      __setBindingResolverForTest(async () => egressAccess(id));
      expect(
        await egressFetch(ctx(egressAccess(id)), {
          url: "https://search.example.test/q",
        }),
      ).toEqual({
        ok: false,
        error:
          "Could not run on prod-1: Update Runner prod-1: it is too old to run incident agent commands",
      });
      expect(sent).toEqual([]);
    },
    { execStdin: false, answer: egressAnswer },
  );
});

test("Runner egress withdrawn before dispatch sends nothing", async () => {
  await withReservedRunner(
    async (id, sent) => {
      __setBindingResolverForTest(async () =>
        agentAccessFixture({ egress: null }),
      );
      const out = await egressFetch(ctx(egressAccess(id)), {
        url: "https://search.example.test/q",
      });
      expect(out).toEqual({
        ok: false,
        error: `Could not run on prod-1: Runner prod-1: Access refused: ${id} is not this agent's egress route`,
      });
      expect(sent).toEqual([]);
    },
    { answer: egressAnswer },
  );
});
