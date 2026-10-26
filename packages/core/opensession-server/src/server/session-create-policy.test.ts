import { afterEach, describe, expect, test } from "bun:test";
import {
  assertAutomationDescendantOpeningIsolation,
  descendantOpeningScope,
  openingCreateTrustPolicy,
  openingMentionsNote,
} from "./session-create";
import {
  AgentAccessError,
  __setBindingResolverForTest,
} from "./incidents/access/resolve";
import { __setIncidentAuditForTest } from "./incidents/audit-sink";
import { agentAccessFixture } from "./incidents/testing/access-fixture";
import { sandboxRunSecuritySpec } from "./run-session";
import { runAccountSpec } from "./session-run-inputs";
import type { UnifiedSession } from "./types";
import {
  restoreResolvedCreate,
  snapshotOpeningCreate,
} from "./session-create-plan";

describe("automation descendant opening policy", () => {
  const descendant = {
    automationId: "auto-renderer",
    automationName: "Renderer swarm",
    mcpServers: [] as string[],
    repo: "renderer",
    publicationRepo: "tellahq/renderer",
    baseBranch: "main",
    allowedRunners: ["mac-studio"],
    publication: "branch-pr-only" as const,
  };

  test("an incident agent's opening turn gets its enforced connections; other descendants stay empty", () => {
    const incident = {
      incidentId: "inc-1",
      role: "investigator" as const,
      signalId: null,
      accessRevision: "r1",
      spawn: { hosts: [], credentials: [], egress: null },
    };
    expect(
      openingCreateTrustPolicy({
        automationDescendantPolicy: {
          ...descendant,
          mcpServers: ["sentry"],
          incident,
        },
        branch: "fix/x",
        runMcpServers: ["everything"],
        user: "x",
      }).mcpServers,
    ).toEqual(["sentry"]);
    expect(
      openingCreateTrustPolicy({
        automationDescendantPolicy: descendant,
        branch: "fix/x",
        runMcpServers: ["everything"],
        user: "x",
      }).mcpServers,
    ).toEqual([]);
  });

  test("an incident agent's opening turn re-resolves its access like every later turn", async () => {
    const incident = {
      incidentId: "inc-1",
      role: "investigator" as const,
      signalId: null,
      accessRevision: "r1",
      spawn: { hosts: [], credentials: [], egress: null },
    };
    const previousAudit = __setIncidentAuditForTest(() => {});
    try {
      __setBindingResolverForTest(async () =>
        agentAccessFixture({
          repos: ["renderer"],
          connections: ["logs"],
          deniedTools: { bash: "off" },
        }),
      );
      const scope = await descendantOpeningScope({
        id: "os-1",
        mode: "code",
        repo: "renderer",
        automationDescendantPolicy: {
          ...descendant,
          mcpServers: ["sentry", "logs"],
          incident,
        },
      });
      expect(scope.mcpServers).toEqual(["logs"]);
      expect(scope.deniedTools).toMatchObject({ bash: "off" });
      expect(scope.incidentProxyMcpServers).toEqual([
        "opensession-incident-access",
      ]);
      __setBindingResolverForTest(async () => {
        throw new AgentAccessError(
          "Incident inc-1 is paused; its agents have no access",
          "incident",
        );
      });
      await expect(
        descendantOpeningScope({
          id: "os-1",
          mode: "code",
          repo: "renderer",
          automationDescendantPolicy: { ...descendant, incident },
        }),
      ).rejects.toThrow("is paused");
    } finally {
      __setBindingResolverForTest(undefined);
      __setIncidentAuditForTest(previousAudit);
    }
    expect(
      await descendantOpeningScope({
        id: "os-2",
        automationDescendantPolicy: descendant,
      }),
    ).toEqual({ mcpServers: [], incidentProxyMcpServers: [] });
  });

  test("the sandbox and local opening turns take the descendant opening scope", async () => {
    const src = await Bun.file(
      new URL("./session-create.ts", import.meta.url),
    ).text();
    expect(
      src.match(/descendantOpeningScope\(/g)?.length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("a sandboxed incident agent proxies only the incident access server", () => {
    const spec = sandboxRunSecuritySpec(
      {
        id: "os-1",
        automationDescendantPolicy: {
          ...descendant,
          incident: {
            incidentId: "inc-1",
            role: "verifier",
            signalId: null,
            accessRevision: "r",
            spawn: { hosts: [], credentials: [], egress: null },
          },
        },
      } as unknown as UnifiedSession,
      {
        isAutomationSession: true,
        mcpServers: ["sentry"],
        incidentProxyMcpServers: ["opensession-incident-access"],
      },
    );
    expect(spec.proxyMcpServers).toEqual(["opensession-incident-access"]);
    expect(
      sandboxRunSecuritySpec(
        {
          id: "os-2",
          automationDescendantPolicy: descendant,
        } as UnifiedSession,
        {
          isAutomationSession: true,
          incidentProxyMcpServers: ["opensession-incident-access"],
        },
      ).proxyMcpServers,
    ).toEqual([]);
  });

  test("opening dispatch rejects default-local and admits an explicit sandbox", () => {
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: descendant,
        sandboxProvider: null,
        runnerTarget: undefined,
      }),
    ).toThrow(/isolated sandbox or Runner/);
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: descendant,
        sandboxProvider: "daytona",
        runnerTarget: undefined,
      }),
    ).not.toThrow();
  });

  test("opening dispatch refuses This machine (container)", () => {
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: descendant,
        sandboxProvider: "podman",
        runnerTarget: undefined,
      }),
    ).toThrow(/cannot run in This machine \(container\)/);
  });

  test("an incident agent without a sandbox opens in a host worktree as the agent user", () => {
    const incident = {
      incidentId: "inc-1",
      role: "investigator" as const,
      signalId: null,
      accessRevision: "r1",
      spawn: { hosts: [], credentials: [], egress: null },
    };
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: {
          ...descendant,
          incident,
          hostAgentUser: "opensession-incident",
        },
        sandboxProvider: null,
        runnerTarget: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: {
          ...descendant,
          hostAgentUser: "opensession-incident",
        },
        sandboxProvider: null,
        runnerTarget: undefined,
      }),
    ).toThrow("Host worktrees are only for incident agents without a sandbox");
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: {
          ...descendant,
          incident,
          hostAgentUser: "opensession-incident",
        },
        sandboxProvider: "daytona",
        runnerTarget: undefined,
      }),
    ).toThrow("Host worktrees are only for incident agents without a sandbox");
  });

  // The flag overrides the instance config, which on a developer box may
  // already opt untrusted runs into AWS: pin it per test, restore it after.
  const savedUntrustedRuns = process.env.AGENT_AWS_UNTRUSTED_RUNS;
  afterEach(() => {
    if (savedUntrustedRuns === undefined)
      delete process.env.AGENT_AWS_UNTRUSTED_RUNS;
    else process.env.AGENT_AWS_UNTRUSTED_RUNS = savedUntrustedRuns;
  });

  test("an instance that opts untrusted runs into AWS vends it to the opening turn", () => {
    process.env.AGENT_AWS_UNTRUSTED_RUNS = "true";
    const policy = openingCreateTrustPolicy({
      automationDescendantPolicy: descendant,
      branch: "compat/layout",
      runMcpServers: [],
      user: "Automation (automation)",
    });
    expect(policy.aws).toBe(true);
    // Only AWS moves: the automation scoping is untouched.
    expect(policy.automation).toBe(true);
    expect(policy.user).toBeUndefined();
    expect(policy.mcpServers).toEqual([]);
    expect(policy.trustProfile).toBe("automation");
  });

  test("opening turn is automation-scoped with no user, AWS, or MCP", () => {
    process.env.AGENT_AWS_UNTRUSTED_RUNS = "false";
    expect(
      openingCreateTrustPolicy({
        automationDescendantPolicy: descendant,
        branch: "compat/layout",
        runMcpServers: ["dangerous-parent-server"],
        user: "Automation (automation)",
      }),
    ).toEqual({
      automation: true,
      mcpServers: [],
      user: undefined,
      mcpGrantUser: undefined,
      aws: false,
      trustProfile: "automation",
      publicationPolicy: {
        repo: "tellahq/renderer",
        branch: "main",
        headBranch: "compat/layout",
      },
    });
  });

  test("interactive opening and sandbox runs use the verified creator login", () => {
    expect(
      openingCreateTrustPolicy({
        automationDescendantPolicy: undefined,
        branch: "preview",
        runMcpServers: ["tella-stage"],
        user: "Alex",
        createdByLogin: "alex-two",
      }).mcpGrantUser,
    ).toBe("alex-two");
    expect(
      sandboxRunSecuritySpec(
        {
          id: "os-interactive",
          startedBy: "Alex",
          createdByLogin: "alex-two",
        } as UnifiedSession,
        {
          isAutomationSession: false,
          user: "Alex",
          mcpServers: ["tella-stage"],
        },
      ).mcpGrantUser,
    ).toBe("alex-two");
  });

  test("sandbox host spec proxies the automation-bar set only for non-descendant automation turns", () => {
    const automationBar = ["opensession-papercuts", "opensession-sessions"];
    // A person's turn in an automation-owned sandbox session proxies the set
    // run-session computed (including the spawn suite) over run-rpc.
    expect(
      sandboxRunSecuritySpec(
        { id: "os-auto", automation: "Health monitor" } as UnifiedSession,
        {
          isAutomationSession: true,
          user: "Alex",
          accountUser: "Alex",
          mcpServers: ["tella-stage"],
          automationProxyMcpServers: automationBar,
        },
      ),
    ).toMatchObject({
      mcpServers: ["tella-stage"],
      proxyMcpServers: automationBar,
      user: undefined,
      accountUser: "Alex",
      trustProfile: "automation",
    });
    // A descendant proxies nothing, whatever the caller passes.
    expect(
      sandboxRunSecuritySpec(
        {
          id: "os-child",
          branch: "compat/layout",
          automationDescendantPolicy: descendant,
        } as UnifiedSession,
        {
          isAutomationSession: true,
          mcpServers: [],
          automationProxyMcpServers: automationBar,
        },
      ).proxyMcpServers,
    ).toEqual([]);
    // An interactive turn ignores it and keeps the interactive set.
    expect(
      sandboxRunSecuritySpec({ id: "os-plain" } as UnifiedSession, {
        isAutomationSession: false,
        user: "Alex",
        automationProxyMcpServers: automationBar,
      }).proxyMcpServers,
    ).toContain("opensession-sessions");
  });

  test("sandbox host spec preserves the complete descendant security boundary", () => {
    process.env.AGENT_AWS_UNTRUSTED_RUNS = "false";
    expect(
      sandboxRunSecuritySpec(
        {
          id: "os-child",
          startedBy: "human@example.com",
          branch: "compat/layout",
          automationDescendantPolicy: descendant,
        } as UnifiedSession,
        {
          isAutomationSession: true,
          user: "human@example.com",
          accountUser: "human@example.com",
          mcpServers: [],
          deniedTools: { mcp__stripe__refund: "automation policy" },
        },
      ),
    ).toEqual({
      mcpServers: [],
      proxyMcpServers: [],
      reposNote: undefined,
      deniedTools: { mcp__stripe__refund: "automation policy" },
      publicationPolicy: {
        repo: "tellahq/renderer",
        branch: "main",
        headBranch: "compat/layout",
      },
      aws: false,
      user: undefined,
      mcpGrantUser: undefined,
      // Only the person's provider subscription follows them across the
      // boundary; MCP, GitHub and trust identities stay dropped.
      accountUser: "human@example.com",
      journalKind: "automation",
      trustProfile: "automation",
    });
  });

  test("account routing keeps the automation pin for machine turns only", () => {
    const session = { accountId: "shared-triage" };
    const automation = { accountId: "shared-triage", usageCredits: true };
    const machineTurn = { isAutomationSession: true, accountUser: undefined };
    const humanTurn = {
      isAutomationSession: true,
      accountUser: "human@example.com",
    };
    const noPin = {
      accountId: undefined,
      accountStrict: undefined,
      usageCredits: undefined,
    };
    // A disposable sandbox resume hard-pins the automation's own turns.
    expect(runAccountSpec(session, machineTurn, automation)).toEqual({
      accountId: "shared-triage",
      accountStrict: true,
      usageCredits: true,
    });
    // Host, Runner and pi-host turns keep the session's soft pin for the
    // automation's own turns.
    expect(runAccountSpec(session, machineTurn)).toEqual({
      accountId: "shared-triage",
      accountStrict: undefined,
      usageCredits: undefined,
    });
    // The person who took the session over spends their own subscription
    // first with the pool as backup on every launch path: no pin (a pin is
    // tried before personal accounts), no strict cap, their own credit
    // policy.
    expect(runAccountSpec(session, humanTurn, automation)).toEqual(noPin);
    expect(runAccountSpec(session, humanTurn)).toEqual(noPin);
    // Interactive sessions keep their own soft pin.
    expect(
      runAccountSpec(
        { accountId: "mine" },
        { isAutomationSession: false, accountUser: "human@example.com" },
      ),
    ).toEqual({
      accountId: "mine",
      accountStrict: undefined,
      usageCredits: undefined,
    });
  });

  test("crash recovery preserves immutable descendant provenance", () => {
    const snapshot = snapshotOpeningCreate({
      id: "os-child",
      automationDescendantPolicy: descendant,
    });
    const restored = restoreResolvedCreate<{
      automationDescendantPolicy: typeof descendant;
    }>(snapshot);
    expect(restored.automationDescendantPolicy).toEqual(descendant);
  });
});

test("Slack opening transport survives native create recovery without changing trust", () => {
  const slackOrigin = {
    sessionKey: "C1-123.1",
    channel: "C1",
    threadTs: "123.1",
    messageTs: "123.1",
  };
  const recovered = restoreResolvedCreate<{ slackOrigin: typeof slackOrigin }>(
    snapshotOpeningCreate({ slackOrigin }),
  );
  expect(recovered.slackOrigin).toEqual(slackOrigin);
  expect(
    openingCreateTrustPolicy({
      branch: "slack-question",
      user: "Michiel",
      createdByLogin: "verified",
    }),
  ).toMatchObject({
    automation: false,
    user: "Michiel",
    mcpGrantUser: "verified",
    aws: true,
    trustProfile: "interactive",
  });
});

describe("support session opening policy", () => {
  const supportRefs = [{ kind: "support", id: "sc_1" }];

  test("the opening turn carries no user and no AWS credentials", () => {
    const previous = process.env.AGENT_AWS_UNTRUSTED_RUNS;
    process.env.AGENT_AWS_UNTRUSTED_RUNS = "false";
    try {
      const trust = openingCreateTrustPolicy({
        branch: "",
        runMcpServers: ["acme-crm"],
        user: "Sessions",
        externalRefs: supportRefs,
      });
      expect(trust.user).toBeUndefined();
      expect(trust.aws).toBe(false);
      expect(trust.mcpServers).toEqual(["acme-crm"]);
      // Another feed ref keeps today's behaviour.
      expect(
        openingCreateTrustPolicy({
          branch: "",
          runMcpServers: [],
          user: "Kent",
          externalRefs: [{ kind: "tella-video", id: "v1" }],
        }).user,
      ).toBe("Kent");
    } finally {
      if (previous === undefined) delete process.env.AGENT_AWS_UNTRUSTED_RUNS;
      else process.env.AGENT_AWS_UNTRUSTED_RUNS = previous;
    }
  });

  test("a sandboxed support turn proxies only opensession-support and passes no user", () => {
    const spec = sandboxRunSecuritySpec(
      { id: "os-1", externalRefs: supportRefs } as unknown as UnifiedSession,
      { isAutomationSession: false, user: "Kent", mcpServers: ["acme-crm"] },
    );
    expect(spec.proxyMcpServers).toEqual(["opensession-support"]);
    expect(spec.user).toBeUndefined();
  });
});

describe("support session opening mentions", () => {
  test("a support opening never resolves @session mentions", () => {
    const prompt = "Please look at @session:bks-0190aaaa-0000";
    expect(
      openingMentionsNote(prompt, [{ kind: "support", id: "sc_1" }]),
    ).toBeNull();
    expect(openingMentionsNote(prompt, undefined)).toContain(
      "@session:bks-0190aaaa-0000",
    );
  });
});
