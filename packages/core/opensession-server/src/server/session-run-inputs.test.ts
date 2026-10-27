/**
 * The per-turn run inputs a session resolves to. These branches are the
 * security-relevant half of run-session.ts: an automation-owned session must
 * keep its allowlist and denials on an interactive resume, and must pass no
 * user so an allowedUsers-gated MCP server stays invisible to it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAccess } from "../shared/incident-access";
import {
  AgentAccessError,
  __setBindingResolverForTest,
} from "./incidents/access/resolve";
import { automationDeniedTools } from "./automations";
import { getConfigAsync, personaName } from "./config";
import { __setIncidentAuditForTest } from "./incidents/audit-sink";
import {
  type ProjectSettingsDocument,
  defaultProjectDocument,
} from "../shared/project-settings";
import { projectDocuments } from "./projects/store";
import { isMachineActor } from "./session-actors";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import { useSupportTestKernel } from "./support/testing/kernel-fixture";
import type { AutomationDescendantPolicy } from "./types";
import {
  resolveSessionRunInputs,
  runCommitAuthor,
  sessionInProcessMcpBranch,
  sessionMcpScopeSource,
  type RunInputsSession,
} from "./session-run-inputs";

// Support sessions read the project's access table from the catalog.
useSupportTestKernel();

const plain: RunInputsSession = {
  automation: undefined,
  mcpServers: undefined,
  externalRefs: undefined,
  goalId: undefined,
  startedBy: "Michiel",
  createdByLogin: "michiel",
};

const descendantPolicy: AutomationDescendantPolicy = {
  automationId: "auto-1",
  automationName: "Renderer swarm",
  mcpServers: [],
  repo: "renderer",
  publicationRepo: "tellahq/renderer",
  baseBranch: "main",
  allowedRunners: [],
  publication: "branch-pr-only",
};

const incidentAccess: AgentAccess = {
  incidentId: "inc-1",
  project: "acme",
  role: "investigator",
  signalId: null,
  overrideApplied: false,
  defaults: false,
  connections: ["sentry", "logs"],
  deniedTools: {},
  mode: "code",
  repos: ["acme"],
  runners: [],
  hosts: [],
  credentials: [],
  model: null,
  egress: null,
  narrowed: [],
  revision: "r1",
  summary: "",
};

describe("sessionMcpScopeSource", () => {
  test("an automation-owned session is scoped by its automation", () => {
    expect(
      sessionMcpScopeSource({ ...plain, automation: "Plain ticket triage" }),
    ).toBe("automation");
  });

  test("the automation wins over a stamped session allowlist", () => {
    expect(
      sessionMcpScopeSource({
        ...plain,
        automation: "Plain ticket triage",
        mcpServers: ["slack"],
      }),
    ).toBe("automation");
  });

  test("a stamped allowlist is used when there is no automation", () => {
    expect(sessionMcpScopeSource({ ...plain, mcpServers: ["slack"] })).toBe(
      "session",
    );
  });

  test("an EMPTY stamped allowlist is not an allowlist", () => {
    // [] is truthy, and reading it as a restriction is what once kicked every
    // follow-up prompt off the shared server pool (bks-019f818d).
    expect(sessionMcpScopeSource({ ...plain, mcpServers: [] })).toBe("all");
  });

  test("a feed-workspace session falls back to its feed's servers", () => {
    expect(
      sessionMcpScopeSource({
        ...plain,
        externalRefs: [{ kind: "tella-video", id: "v1" }],
      }),
    ).toBe("feed");
  });

  test("a plain session has no allowlist", () => {
    expect(sessionMcpScopeSource(plain)).toBe("all");
  });
});

describe("sessionInProcessMcpBranch", () => {
  test("automation-owned sessions never get the interactive servers", () => {
    expect(
      sessionInProcessMcpBranch({ ...plain, automation: "Health monitor" }),
    ).toBe("automation-self-improve");
  });

  test("an automation-owned GOAL session still stays on the automation branch", () => {
    expect(
      sessionInProcessMcpBranch({
        ...plain,
        automation: "Health monitor",
        goalId: "g1",
      }),
    ).toBe("automation-self-improve");
  });

  test("a person's turn in an automation-owned session adds the spawn suite", () => {
    expect(
      sessionInProcessMcpBranch(
        { ...plain, automation: "Health monitor" },
        "Michiel",
      ),
    ).toBe("automation+human-spawn");
  });

  test("a sandboxed descendant stays on the automation branch even for a person", () => {
    expect(
      sessionInProcessMcpBranch(
        {
          ...plain,
          automation: "Health monitor",
          automationDescendantPolicy: {
            automationId: "auto-1",
            automationName: "Health monitor",
            mcpServers: [],
            repo: "opensession",
            publicationRepo: "opensession",
            baseBranch: "main",
            allowedRunners: [],
            publication: "branch-pr-only",
          },
        },
        "Michiel",
      ),
    ).toBe("automation-self-improve");
  });

  test("a goal session adds its own controls", () => {
    expect(sessionInProcessMcpBranch({ ...plain, goalId: "g1" })).toBe(
      "interactive+goal-self",
    );
  });

  test("a normal session gets the interactive set", () => {
    expect(sessionInProcessMcpBranch(plain)).toBe("interactive");
  });

  test("a Plain discussion session gets only its approval server", () => {
    expect(
      sessionInProcessMcpBranch({ ...plain, plainDiscussionId: "disc_1" }),
    ).toBe("plain-discussion");
    // Even with a goal: the interactive set never reaches ticket text.
    expect(
      sessionInProcessMcpBranch({
        ...plain,
        plainDiscussionId: "disc_1",
        goalId: "g1",
      }),
    ).toBe("plain-discussion");
  });
});

describe("resolveSessionRunInputs", () => {
  test("a normal session keeps the prompter and gets no denials", async () => {
    const inputs = await resolveSessionRunInputs(plain, { user: "Kent" });
    expect(inputs.isAutomationSession).toBe(false);
    expect(inputs.mcpServers).toBeUndefined();
    expect(inputs.mcpServersSource).toBe("all");
    expect(inputs.deniedTools).toBeUndefined();
    expect(inputs.user).toBe("Kent");
    expect(inputs.mcpGrantUser).toBe("michiel");
    expect(inputs.accountUser).toBe("Kent");
    expect(inputs.sessionNote).toBe(true);
  });

  test("does not use the legacy starter as a grant identity", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, createdByLogin: undefined },
      { user: "Kent" },
    );
    expect(inputs.mcpGrantUser).toBeUndefined();
  });

  test("a stamped allowlist rides through verbatim", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, mcpServers: ["slack", "linear"] },
      { user: "Kent" },
    );
    expect(inputs.mcpServers).toEqual(["slack", "linear"]);
    expect(inputs.mcpServersSource).toBe("session");
  });

  test("an automation-owned session drops the user and carries the denials", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Kent" },
    );
    expect(inputs.isAutomationSession).toBe(true);
    // The gate that keeps allowedUsers-scoped servers invisible to untrusted
    // text: an automation run passes no user at all.
    expect(inputs.user).toBeUndefined();
    expect(inputs.deniedTools).toBeDefined();
    expect(inputs.deniedTools).toHaveProperty("mcp__plain__reply_to_thread");
    // No memory / repos / personal-prompt note for an automation run.
    expect(inputs.sessionNote).toBe(false);
    // Kent is a person, so this turn may spawn work for him; the allowlist,
    // denials and dropped user above are unchanged by that.
    expect(inputs.accountUser).toBe("Kent");
    expect(inputs.inProcessMcpBranch).toBe("automation+human-spawn");
  });

  test("an automation's own tick never gets the spawn suite", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Plain ticket triage (automation)" },
    );
    expect(inputs.accountUser).toBeUndefined();
    expect(inputs.humanPrompter).toBeUndefined();
    expect(inputs.inProcessMcpBranch).toBe("automation-self-improve");
  });

  test("a Plain discussion session drops the user and denies customer and money writes", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, plainDiscussionId: "disc_1" },
      { user: "Kent" },
    );
    expect(inputs.isAutomationSession).toBe(false);
    // Untrusted ticket text: no user for the allowedUsers gate, same as an
    // automation run, even when a person prompts it from the UI.
    expect(inputs.user).toBeUndefined();
    expect(inputs.accountUser).toBe("Kent");
    expect(inputs.deniedTools).toHaveProperty("mcp__plain__reply_to_thread");
    expect(inputs.deniedTools).toHaveProperty("mcp__stripe__create_refund");
    expect(inputs.deniedTools).toHaveProperty(
      "mcp__workos__get_impersonation_url",
    );
    expect(inputs.inProcessMcpBranch).toBe("plain-discussion");
  });

  test("an auto-triage session that reports into a discussion keeps its automation branch with the wider deny-set", async () => {
    const session = {
      ...plain,
      automation: "Plain ticket triage",
      plainDiscussionId: "thd_1",
    };
    // A follow-up relayed from the discussion: the sender is the channel,
    // not a person, so no spawn suite and no subscription to bill.
    const relayed = await resolveSessionRunInputs(session, { user: "Plain" });
    expect(relayed.isAutomationSession).toBe(true);
    expect(relayed.user).toBeUndefined();
    expect(relayed.accountUser).toBeUndefined();
    expect(relayed.humanPrompter).toBeUndefined();
    expect(relayed.inProcessMcpBranch).toBe("automation-self-improve");
    expect(relayed.deniedTools).toHaveProperty("mcp__stripe__create_refund");
    expect(relayed.deniedTools).toHaveProperty("mcp__plain__reply_to_thread");
    // A person steering the same session from the UI keeps what #399 gives
    // an automation-owned session.
    const steered = await resolveSessionRunInputs(session, { user: "Kent" });
    expect(steered.humanPrompter).toBe("Kent");
    expect(steered.inProcessMcpBranch).toBe("automation+human-spawn");
    expect(steered.deniedTools).toHaveProperty("mcp__stripe__create_refund");
  });

  test("the wake of a person's wait gets the continuation branch, not the spawn suite", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Kent (wait)" },
    );
    expect(inputs.humanPrompter).toBe("Kent (wait)");
    expect(inputs.inProcessMcpBranch).toBe("automation+wait-continuation");
    expect(inputs.user).toBeUndefined();
  });

  test("a scheduled loop tick in a person's name never gets the spawn suite", async () => {
    // Kent set the loop, so the turn is still billed to him, but nobody
    // pressed send: scheduled prompt text must not start person-owned
    // sessions on every tick.
    for (const user of ["Kent (loop)", "loop"]) {
      const inputs = await resolveSessionRunInputs(
        { ...plain, automation: "Plain ticket triage" },
        { user },
      );
      expect(inputs.humanPrompter).toBeUndefined();
      expect(inputs.inProcessMcpBranch).toBe("automation-self-improve");
    }
    expect(
      (
        await resolveSessionRunInputs(
          { ...plain, automation: "Plain ticket triage" },
          { user: "Kent (loop)" },
        )
      ).accountUser,
    ).toBe("Kent (loop)");
  });

  test("a person taking over an automation-owned session keeps their provider account", async () => {
    // Johnny switched a Plain triage session back to Fable and prompted it;
    // every turn still ran pool-only and bounced to the fallback while his
    // own subscription had headroom. The identity reaches account selection
    // only: `user` (the MCP gate) stays dropped.
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Johnny" },
    );
    expect(inputs.user).toBeUndefined();
    expect(inputs.accountUser).toBe("Johnny");
  });

  test("machine senders never become an account user", async () => {
    for (const user of [
      "Plain ticket triage (automation)",
      "GitHub",
      "auto-continue",
      "Anonymous",
      undefined,
    ]) {
      const inputs = await resolveSessionRunInputs(
        { ...plain, automation: "Plain ticket triage" },
        { user },
      );
      expect(inputs.accountUser).toBeUndefined();
    }
  });

  test("an automation descendant keeps immutable empty scope on resume", async () => {
    const inputs = await resolveSessionRunInputs(
      {
        ...plain,
        automation: undefined,
        mcpServers: ["dangerous-later-config"],
        automationDescendantPolicy: descendantPolicy,
      },
      { user: "Kent" },
    );
    expect(inputs.isAutomationSession).toBe(true);
    expect(inputs.mcpServers).toEqual([]);
    expect(inputs.mcpServersSource).toBe("automation");
    expect(inputs.deniedTools).toBeDefined();
    expect(inputs.user).toBeUndefined();
    expect(inputs.sessionNote).toBe(false);
  });

  test("an allowlist that resolves to nothing reports itself as unscoped", async () => {
    // An automation record that is gone (or names no servers) leaves the run
    // unscoped — say so rather than claiming an allowlist that isn't there.
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "no-such-automation-xyz" },
      { user: "Kent" },
    );
    expect(inputs.mcpServers).toBeUndefined();
    expect(inputs.mcpServersSource).toBe("all");
  });

  test("an incident agent's turn is scoped by its re-resolved access", async () => {
    const previousAudit = __setIncidentAuditForTest(() => {});
    __setBindingResolverForTest(async () => ({
      ...incidentAccess,
      connections: ["sentry"],
      deniedTools: { mcp__sentry__delete_issue: "off" },
    }));
    try {
      const inputs = await resolveSessionRunInputs(
        {
          ...plain,
          id: "os-1",
          mode: "code",
          repo: "acme",
          automationDescendantPolicy: {
            ...descendantPolicy,
            repo: "acme",
            mcpServers: ["sentry", "logs"],
            incident: {
              incidentId: "inc-1",
              role: "investigator",
              signalId: null,
              accessRevision: "r1",
              spawn: { hosts: [], credentials: [], egress: null },
            },
          },
        },
        { user: "Kent" },
      );
      expect(inputs).toMatchObject({
        isAutomationSession: true,
        mcpServers: ["sentry"],
        deniedTools: { mcp__sentry__delete_issue: "off" },
        user: undefined,
        incidentProxyMcpServers: ["opensession-incident-access"],
      });
    } finally {
      __setBindingResolverForTest(undefined);
      __setIncidentAuditForTest(previousAudit);
    }
  });

  test("an incident agent's egress hosts become its web_fetch allowlist", async () => {
    const previousAudit = __setIncidentAuditForTest(() => {});
    const session: RunInputsSession = {
      ...plain,
      id: "os-1",
      mode: "code",
      repo: "acme",
      automationDescendantPolicy: {
        ...descendantPolicy,
        repo: "acme",
        mcpServers: ["sentry"],
        incident: {
          incidentId: "inc-1",
          role: "investigator" as const,
          signalId: null,
          accessRevision: "r1",
          spawn: { hosts: [], credentials: [], egress: null },
        },
      },
    };
    try {
      __setBindingResolverForTest(async () => ({
        ...incidentAccess,
        egress: { route: "server", hosts: ["status.example.test"] },
      }));
      expect((await resolveSessionRunInputs(session)).webFetchHosts).toEqual([
        "status.example.test",
      ]);
      // No egress in the profile: no allowlist, so the run gets no web_fetch.
      __setBindingResolverForTest(async () => incidentAccess);
      expect(
        (await resolveSessionRunInputs(session)).webFetchHosts,
      ).toBeUndefined();
      expect(
        (await resolveSessionRunInputs(plain)).webFetchHosts,
      ).toBeUndefined();
    } finally {
      __setBindingResolverForTest(undefined);
      __setIncidentAuditForTest(previousAudit);
    }
  });

  test("a refused incident turn throws instead of running unscoped", async () => {
    const previousAudit = __setIncidentAuditForTest(() => {});
    __setBindingResolverForTest(async () => {
      throw new AgentAccessError(
        "Incident inc-1 is paused; its agents have no access",
        "incident",
      );
    });
    try {
      await expect(
        resolveSessionRunInputs({
          ...plain,
          id: "os-1",
          automationDescendantPolicy: {
            ...descendantPolicy,
            incident: {
              incidentId: "inc-1",
              role: "verifier",
              signalId: null,
              accessRevision: "r1",
              spawn: { hosts: [], credentials: [], egress: null },
            },
          },
        }),
      ).rejects.toThrow("is paused");
    } finally {
      __setBindingResolverForTest(undefined);
      __setIncidentAuditForTest(previousAudit);
    }
  });

  test("viewing a refused incident agent's inputs neither throws nor audits", async () => {
    const audits: unknown[] = [];
    const previousAudit = __setIncidentAuditForTest((e) => audits.push(e));
    __setBindingResolverForTest(async () => {
      throw new AgentAccessError(
        "Incident inc-1 is paused; its agents have no access",
        "incident",
      );
    });
    try {
      const inputs = await resolveSessionRunInputs(
        {
          ...plain,
          id: "os-1",
          automationDescendantPolicy: {
            ...descendantPolicy,
            mcpServers: ["sentry"],
            incident: {
              incidentId: "inc-1",
              role: "verifier",
              signalId: null,
              accessRevision: "r1",
              spawn: { hosts: [], credentials: [], egress: null },
            },
          },
        },
        { audit: false },
      );
      expect(inputs).toMatchObject({
        mcpServers: [],
        incidentProxyMcpServers: [],
        incidentRefusal: "Incident inc-1 is paused; its agents have no access",
      });
      expect(inputs.deniedTools).toMatchObject(automationDeniedTools());
      expect(audits).toEqual([]);
    } finally {
      __setBindingResolverForTest(undefined);
      __setIncidentAuditForTest(previousAudit);
    }
  });

  test("other descendants keep their empty scope and no incident server", async () => {
    const inputs = await resolveSessionRunInputs({
      ...plain,
      automationDescendantPolicy: descendantPolicy,
    });
    expect(inputs.incidentProxyMcpServers).toEqual([]);
    expect(
      (await resolveSessionRunInputs(plain)).incidentProxyMcpServers,
    ).toEqual([]);
  });
});

describe("support sessions", () => {
  const support: RunInputsSession = {
    ...plain,
    repo: "acme",
    mcpServers: ["acme-crm"],
    externalRefs: [{ kind: "support", id: "sc_1" }],
  };

  async function storeProject(
    change: (doc: ProjectSettingsDocument) => void,
  ): Promise<void> {
    const doc = defaultProjectDocument("acme", "2026-10-01T09:00:00.000Z");
    change(doc);
    await projectDocuments().set("acme", doc);
  }

  test("run under the support branch, with no user and the deny-set", async () => {
    await storeProject((doc) => {
      doc.access.connections = [
        { server: "acme-crm", roles: ["support"] },
        { server: "acme-billing", roles: ["automations"] },
      ];
    });
    expect(sessionInProcessMcpBranch(support)).toBe("support");
    const inputs = await resolveSessionRunInputs(support, { user: "Kent" });
    expect(inputs.inProcessMcpBranch).toBe("support");
    expect(inputs.user).toBeUndefined();
    expect(inputs.isAutomationSession).toBe(false);
    expect(inputs.mcpServers).toEqual(["acme-crm"]);
    for (const key of Object.keys(automationDeniedTools()))
      expect(inputs.deniedTools).toHaveProperty(key);
    expect(inputs.deniedTools).toHaveProperty("mcp__gmail__send_email");
    expect(inputs.deniedTools).toHaveProperty("mcp__stripe__create_refund");
    expect(inputs.sessionNote).toBe(false);
  });

  test("the persona that owns a support session gets no person's rights", async () => {
    await storeProject(() => {});
    // As routing.ts creates it: started by the persona, no login, and the
    // opening turn sent under the persona's name.
    const owned: RunInputsSession = {
      ...support,
      startedBy: personaName(),
      createdByLogin: undefined,
    };
    const inputs = await resolveSessionRunInputs(owned, {
      user: personaName(),
    });
    expect(inputs.inProcessMcpBranch).toBe("support");
    expect(inputs.user).toBeUndefined();
    expect(inputs.accountUser).toBeUndefined();
    expect(inputs.humanPrompter).toBeUndefined();
    expect(inputs.mcpGrantUser).toBeUndefined();
    expect(inputs.sessionNote).toBe(false);
  });

  /** Run `body` with persona "Pat" and a roster holding "Pat Smith", so the
   *  persona reads as her (isMachineActor gives a teammate precedence). */
  async function withPersonaCollision(body: () => Promise<void>) {
    const restoreTeam = __setIdentitiesForTest([
      { name: "Pat Smith", email: "pat@example.test", github: "pat-smith" },
    ]);
    const previousConfig = process.env.OPENSESSION_CONFIG;
    const dir = mkdtempSync(join(tmpdir(), "run-inputs-persona-"));
    try {
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ persona: { name: "Pat" } }),
      );
      process.env.OPENSESSION_CONFIG = join(dir, "config.json");
      await getConfigAsync();
      expect(personaName()).toBe("Pat");
      expect(isMachineActor("Pat")).toBe(false);
      await body();
    } finally {
      restoreTeam();
      if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
      else process.env.OPENSESSION_CONFIG = previousConfig;
      await getConfigAsync();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a persona named like a teammate gives the support turn none of her rights", async () => {
    await storeProject(() => {});
    await withPersonaCollision(async () => {
      // A support session credited to the colliding persona, and a turn
      // sent as the persona or straight under the teammate's own name.
      const owned: RunInputsSession = {
        ...support,
        startedBy: "Pat",
        createdByLogin: "pat-smith",
      };
      for (const user of ["Pat", "Pat Smith", "pat-smith"]) {
        const inputs = await resolveSessionRunInputs(owned, { user });
        expect(inputs.inProcessMcpBranch).toBe("support");
        expect(inputs.user).toBeUndefined();
        expect(inputs.accountUser).toBeUndefined();
        expect(inputs.humanPrompter).toBeUndefined();
        expect(inputs.mcpGrantUser).toBeUndefined();
        expect(inputs.sessionNote).toBe(false);
      }
      // The same sender on an ordinary session is the teammate.
      const ordinary = await resolveSessionRunInputs(plain, { user: "Pat" });
      expect(ordinary.accountUser).toBe("Pat");
      expect(ordinary.humanPrompter).toBe("Pat");
    });
  });

  test("a support session's commits carry no teammate's identity", async () => {
    await withPersonaCollision(async () => {
      expect(runCommitAuthor(support, "Pat", "Pat")).toBeNull();
      expect(runCommitAuthor(support, "Pat Smith", "Pat Smith")).toBeNull();
      expect(runCommitAuthor(support, undefined, personaName())).toBeNull();
      // An ordinary session still credits the person behind the turn.
      expect(runCommitAuthor(plain, "Pat", undefined)).toEqual({
        name: "Pat Smith",
        email: "pat@example.test",
      });
    });
  });

  test("a support session with no connectors gets none, never every server", async () => {
    await storeProject(() => {});
    const inputs = await resolveSessionRunInputs(
      { ...support, mcpServers: undefined },
      { user: "Kent" },
    );
    expect(inputs.mcpServers).toEqual([]);
  });

  test("web search follows the Support cell, read every turn", async () => {
    await storeProject(() => {});
    const off = await resolveSessionRunInputs(support, {});
    expect(off.deniedTools?.web_search).toBeDefined();
    await storeProject((doc) => {
      doc.access.webSearch = [...doc.access.webSearch, "support"];
      doc.access.websites = [
        { host: "docs.example.test", roles: ["support"] },
        { host: "status.example.test", roles: ["automations"] },
      ];
    });
    const on = await resolveSessionRunInputs(support, {});
    expect(on.deniedTools?.web_search).toBeUndefined();
    expect(on.webFetchHosts).toContain("docs.example.test");
    expect(on.webFetchHosts).not.toContain("status.example.test");
  });

  test("an interactive session is unchanged", async () => {
    const inputs = await resolveSessionRunInputs(plain, { user: "Kent" });
    expect(inputs.inProcessMcpBranch).toBe("interactive");
    expect(inputs.deniedTools).toBeUndefined();
    expect(inputs.webFetchHosts).toBeUndefined();
  });
});
