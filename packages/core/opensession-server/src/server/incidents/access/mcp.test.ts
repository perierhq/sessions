import { afterEach, expect, test } from "bun:test";
import type { AgentAccess } from "../../../shared/incident-access";
import { automationSessionMcp } from "../../interactive-mcp";
import {
  agentAccessFixture,
  descendantFixture,
} from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  incidentAccessMcpForSession,
  incidentAccessToolDefinitions,
  incidentAccessToolsForSession,
} from "./mcp";
import { AgentAccessError, __setBindingResolverForTest } from "./resolve";

useIncidentTestKernel();
afterEach(() => __setBindingResolverForTest(undefined));

const binding = {
  incidentId: "inc-1",
  role: "investigator" as const,
  signalId: null,
  accessRevision: "r",
  spawn: { hosts: [], credentials: [], egress: null },
};
const names = (access: AgentAccess) =>
  incidentAccessToolDefinitions({ sessionId: "os-1", binding, access }).map(
    (t) => t.name,
  );
const textOf = (out: { content: unknown[] }) =>
  (out.content[0] as { text: string }).text;

test("tools follow the access", () => {
  expect(names(agentAccessFixture())).toEqual(["describe_access"]);
  expect(
    names(
      agentAccessFixture({
        hosts: [
          { runner: "rn-prod", runnerName: "prod-1", access: "read-only" },
        ],
        egress: { route: "server", hosts: ["search.example.test"] },
        credentials: [
          {
            credential: "kc-proxy",
            service: "proxy-api",
            host: "api.proxy.example.test",
            mode: "once",
            scope: "personal",
          },
        ],
      }),
    ),
  ).toEqual([
    "describe_access",
    "host_command",
    "egress_fetch",
    "call_credential",
  ]);
});
test("describe_access reports the fresh access and no secrets", async () => {
  const tools = incidentAccessToolDefinitions({
    sessionId: "os-1",
    binding,
    access: agentAccessFixture(),
  });
  __setBindingResolverForTest(async () =>
    agentAccessFixture({
      connections: ["sentry"],
      credentials: [
        {
          credential: "kc-proxy",
          service: "proxy-api",
          host: "api.proxy.example.test",
          mode: "once",
          scope: "personal",
        },
      ],
    }),
  );
  const out = await tools[0].handler({}, {});
  expect(JSON.parse(textOf(out))).toMatchObject({
    connections: ["sentry"],
    mode: "code",
    repos: ["acme"],
    credentials: [{ service: "proxy-api", mode: "once" }],
    egress: null,
    narrowed: [],
  });
});
test("describe_access lists only what this run is bound to, and names what was allowed later", async () => {
  const policy = {
    ...descendantFixture,
    mcpServers: ["sentry"],
    incident: binding,
  };
  __setBindingResolverForTest(async () =>
    agentAccessFixture({ connections: ["sentry", "logs", "tickets"] }),
  );
  const tools = await incidentAccessToolsForSession({
    id: "os-1",
    mode: "ask",
    automationDescendantPolicy: policy,
  });
  const out = JSON.parse(textOf(await tools[0].handler({}, {})));
  expect(out.connections).toEqual(["sentry"]);
  expect(out.mode).toBe("ask");
  expect(out.summary).not.toContain("logs");
  expect(out.summary).not.toContain("can edit");
  expect(out.note).toBe(
    "logs and tickets were allowed after this agent started. They apply from the next round.",
  );
  // Nothing allowed later: no note.
  __setBindingResolverForTest(async () =>
    agentAccessFixture({ connections: ["sentry"] }),
  );
  expect(
    JSON.parse(textOf(await tools[0].handler({}, {}))).note,
  ).toBeUndefined();
});
test("every call re-resolves: a revoked agent gets nothing", async () => {
  const granted = agentAccessFixture({
    hosts: [{ runner: "rn-prod", runnerName: "prod-1", access: "read-only" }],
  });
  const tools = incidentAccessToolDefinitions({
    sessionId: "os-1",
    binding,
    access: granted,
  });
  __setBindingResolverForTest(async () => {
    throw new AgentAccessError(
      "Incident inc-1 is resolved; its agents have no access",
      "incident",
    );
  });
  const out = await tools
    .find((t) => t.name === "host_command")!
    .handler({ runner: "prod-1", program: "ls" }, {});
  expect(out.content[0]).toEqual({
    type: "text",
    text: "Access refused: Incident inc-1 is resolved; its agents have no access",
  });
});
test("access for another incident or role is refused at call time", async () => {
  const tools = incidentAccessToolDefinitions({
    sessionId: "os-1",
    binding,
    access: agentAccessFixture(),
  });
  __setBindingResolverForTest(async () =>
    agentAccessFixture({ role: "verifier" }),
  );
  expect(textOf(await tools[0].handler({}, {}))).toStartWith(
    "Access refused: ",
  );
});
test("a narrowed access applies at call time even if the tool was listed", async () => {
  const tools = incidentAccessToolDefinitions({
    sessionId: "os-1",
    binding,
    access: agentAccessFixture({
      hosts: [{ runner: "rn-prod", runnerName: "prod-1", access: "read-only" }],
    }),
  });
  __setBindingResolverForTest(async () => agentAccessFixture({ hosts: [] }));
  const out = await tools
    .find((t) => t.name === "host_command")!
    .handler({ runner: "prod-1", program: "ls" }, {});
  expect(JSON.parse(textOf(out))).toEqual({
    ok: false,
    error: "prod-1 is not one of this agent's hosts",
  });
});
test("session builder fails closed", async () => {
  expect(await incidentAccessMcpForSession({ id: "os-1" })).toEqual({});
  __setBindingResolverForTest(async () => {
    throw new AgentAccessError("nope", "settings");
  });
  expect(
    await incidentAccessMcpForSession({
      id: "os-1",
      automationDescendantPolicy: { ...descendantFixture, incident: binding },
    }),
  ).toEqual({});
  __setBindingResolverForTest(async () => agentAccessFixture());
  expect(
    Object.keys(
      await incidentAccessMcpForSession({
        id: "os-1",
        automationDescendantPolicy: { ...descendantFixture, incident: binding },
      }),
    ),
  ).toEqual(["opensession-incident-access"]);
});
test("the fallback builder and every launch path name the incident server for bound agents", async () => {
  __setBindingResolverForTest(async () => agentAccessFixture());
  expect(
    Object.keys(
      await automationSessionMcp(
        {
          automation: "Incidents",
          automationDescendantPolicy: {
            ...descendantFixture,
            incident: binding,
          },
        },
        "os-1",
      ),
    ),
  ).toEqual(["opensession-incident-access"]);
  __setBindingResolverForTest(async () => {
    throw new AgentAccessError("nope", "settings");
  });
  expect(
    await automationSessionMcp(
      {
        automation: "Incidents",
        automationDescendantPolicy: { ...descendantFixture, incident: binding },
      },
      "os-1",
    ),
  ).toEqual({});
  const src = async (f: string) =>
    Bun.file(new URL(`../../${f}`, import.meta.url)).text();
  const run = await src("run-session.ts");
  expect(run).toContain("incidentAccessMcpForSession(");
  expect(run.match(/incidentProxyMcpServers/g)?.length).toBeGreaterThanOrEqual(
    2,
  );
  expect(await src("runner-session.ts")).toContain(
    "runInputs.incidentProxyMcpServers",
  );
  expect(await src("session-create.ts")).toContain("incidentProxyMcpServers");
});
