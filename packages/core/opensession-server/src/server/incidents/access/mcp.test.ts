import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../../paths";
import type { AgentAccess } from "../../../shared/incident-access";
import { automationSessionMcp } from "../../interactive-mcp";
import {
  agentAccessFixture,
  descendantFixture,
  supersededIncidentFixture,
} from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  __setApplyFindingsForTest,
  incidentAccessMcpForSession,
  incidentAccessToolDefinitions,
  incidentAccessToolsForSession,
} from "./mcp";
import { AgentAccessError, __setBindingResolverForTest } from "./resolve";

useIncidentTestKernel();
afterEach(() => {
  __setBindingResolverForTest(undefined);
  __setApplyFindingsForTest(undefined);
});

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
  expect(names(agentAccessFixture())).toEqual([
    "describe_access",
    "show_findings",
  ]);
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
    "show_findings",
    "host_command",
    "egress_fetch",
    "call_credential",
  ]);
});
test("show_findings is mounted for every bound agent", () => {
  for (const role of ["investigator", "verifier"] as const)
    expect(
      incidentAccessToolDefinitions({
        sessionId: "os-1",
        binding: { ...binding, role },
        access: agentAccessFixture({ role }),
      }).map((t) => t.name),
    ).toContain("show_findings");
});
test("show_findings uses the binding's session, not its arguments", async () => {
  const seen: unknown[] = [];
  __setApplyFindingsForTest(async (req) => {
    seen.push(req);
    return { saved: true, blocks: 0, notes: [], text: "Cleared." };
  });
  __setBindingResolverForTest(async () => agentAccessFixture());
  const show = incidentAccessToolDefinitions({
    sessionId: "os-1",
    binding,
    access: agentAccessFixture(),
  }).find((t) => t.name === "show_findings")!;
  const out = await show.handler({ blocks: [], sessionId: "os-evil" }, {});
  expect(textOf(out)).toBe("Cleared.");
  expect(seen).toEqual([
    {
      incidentId: "inc-1",
      role: "investigator",
      sessionId: "os-1",
      input: { blocks: [] },
      source: "tool",
    },
  ]);

  __setBindingResolverForTest(async () => {
    throw new AgentAccessError(
      "Incident inc-1 is resolved; its agents have no access",
      "incident",
    );
  });
  const refused = await show.handler({ blocks: [] }, {});
  expect(textOf(refused)).toBe(
    "Access refused: Incident inc-1 is resolved; its agents have no access",
  );
  expect(seen).toHaveLength(1);
});
test("show_findings applies one session's calls in call order", async () => {
  // Review Focus 2 through the real tool: the first call's access check is
  // slower, and the second call still applies after it.
  const applied: string[] = [];
  __setApplyFindingsForTest(async (req) => {
    const blocks = (req.input as { blocks: Array<{ id: string }> }).blocks;
    applied.push(blocks.map((b) => b.id).join(","));
    return { saved: true, blocks: blocks.length, notes: [], text: "Saved." };
  });
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolves = 0;
  __setBindingResolverForTest(async () => {
    resolves += 1;
    if (resolves === 1) await slow;
    return agentAccessFixture();
  });
  const show = incidentAccessToolDefinitions({
    sessionId: "os-1",
    binding,
    access: agentAccessFixture(),
  }).find((t) => t.name === "show_findings")!;
  const first = show.handler({ blocks: [{ id: "a" }] }, {});
  const second = show.handler({ blocks: [{ id: "b" }] }, {});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  release();
  await Promise.all([first, second]);
  expect(applied).toEqual(["a", "b"]);
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
test("describe_access tells the agent how to call each lent credential", async () => {
  // The kernel fixture's temporary state root, never a real keychain.
  process.env.OPENSESSION_KEYCHAIN_STORE = `${process.env.OPENSESSION_STATE_DIR!}/keychain.json`;
  const kc = await import("../../keychain");
  const limited = kc.addCredential({
    owner: "Alex",
    service: "acme-orders",
    name: "Acme orders",
    host: "api.example.test",
    secret: "sk-orders",
    description: "Read-only orders",
    allowedMethods: ["GET"],
    allowedPathPrefixes: ["/v1/orders"],
    statusOnly: true,
  });
  const open = kc.addCredential({
    owner: "Alex",
    service: "acme-search",
    host: "search.example.test",
    secret: "sk-search",
  });
  try {
    __setBindingResolverForTest(async () =>
      agentAccessFixture({
        credentials: [
          {
            credential: limited.id,
            service: "acme-orders",
            host: "api.example.test",
            mode: "standing",
            scope: "personal",
          },
          {
            credential: open.id,
            service: "acme-search",
            host: "search.example.test",
            mode: "once",
            scope: "personal",
          },
        ],
      }),
    );
    const tools = incidentAccessToolDefinitions({
      sessionId: "os-1",
      binding,
      access: agentAccessFixture(),
    });
    const out = JSON.parse(textOf(await tools[0].handler({}, {})));
    expect(out.credentials).toEqual([
      {
        service: "acme-orders",
        name: "Acme orders",
        mode: "standing",
        host: "api.example.test",
        description: "Read-only orders",
        methods: ["GET"],
        paths: ["/v1/orders"],
        statusOnly: true,
      },
      {
        service: "acme-search",
        mode: "once",
        host: "search.example.test",
        methods: "any",
        paths: "any",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("sk-");
  } finally {
    await kc.deleteCredentialAsync(limited.id, "Alex");
    await kc.deleteCredentialAsync(open.id, "Alex");
    delete process.env.OPENSESSION_KEYCHAIN_STORE;
  }
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
// The grant store's path is fixed when mcp-oauth loads, before the kernel
// fixture moves the state root.
const oauthStorePath = statePath(".opensession-mcp-oauth.json");
test("describe_access names a connection whose sign-in expired", async () => {
  const storePath = oauthStorePath;
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(
    storePath,
    JSON.stringify({
      stacked: {
        serverUrl: "https://mcp.example.test/mcp",
        endpoints: { authorize: "", token: "https://mcp.example.test/token" },
        clientInfo: { clientId: "c" },
        shared: {
          tokens: { accessToken: "old", expiresAt: Date.now() - 60_000 },
          updatedAt: new Date(0).toISOString(),
          connectedBy: "Example",
        },
      },
    }),
  );
  try {
    __setBindingResolverForTest(async () =>
      agentAccessFixture({ connections: ["sentry", "stacked"] }),
    );
    const tools = incidentAccessToolDefinitions({
      sessionId: "os-1",
      binding,
      access: agentAccessFixture(),
    });
    const out = JSON.parse(textOf(await tools[0].handler({}, {})));
    expect(out.connections).toEqual(["sentry", "stacked"]);
    expect(out.unavailable).toEqual([
      "stacked: sign-in expired. A person needs to reconnect it in Settings → Connections.",
    ]);
  } finally {
    rmSync(storePath, { force: true });
  }
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
test("a superseded agent is refused at call time and gets no tools", async () => {
  const incidentId = await supersededIncidentFixture("os-1", "os-2");
  const ours = { ...binding, incidentId };
  __setBindingResolverForTest(async () => agentAccessFixture({ incidentId }));
  const tools = incidentAccessToolDefinitions({
    sessionId: "os-1",
    binding: ours,
    access: agentAccessFixture({ incidentId }),
  });
  expect(textOf(await tools[0].handler({}, {}))).toBe(
    "Access refused: this agent was superseded by os-2",
  );
  const session = (id: string) => ({
    id,
    mode: "code",
    automationDescendantPolicy: { ...descendantFixture, incident: ours },
  });
  expect(await incidentAccessMcpForSession(session("os-1"))).toEqual({});
  // The session that took over keeps its tools.
  expect(
    Object.keys(await incidentAccessMcpForSession(session("os-2"))),
  ).toEqual(["opensession-incident-access"]);
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
