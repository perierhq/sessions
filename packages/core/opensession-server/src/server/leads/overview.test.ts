import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Incident } from "../../shared/incidents";
import {
  defaultProjectDocument,
  type ProjectSettingsDocument,
} from "../../shared/project-settings";
import type { InboxConfig, SupportIndexRow } from "../../shared/support";
import { createLeadMcpServer } from "./mcp";
import {
  OVERVIEW_ITEMS,
  type OverviewPr,
  __setLeadOverviewDepsForTest,
  buildLeadOverview,
  waitsForPerson,
} from "./overview";
import { __setLeadAuditForTest } from "./report";
import {
  NOW,
  PROJECT,
  SIGNALS,
  fixtureIncidents,
  incident,
} from "./testing/fixture";

const DAY = 86_400_000;

let doc: ProjectSettingsDocument;
let incidents: Incident[];
let prs: OverviewPr[] | null;
const audits: Array<Record<string, unknown>> = [];

function inbox(id: string, project: string): InboxConfig {
  return {
    id,
    label: `${project} help`,
    project,
    enabled: true,
    autonomy: "draft",
    vetoMs: 600_000,
  } as InboxConfig;
}

function row(
  id: string,
  fields: Partial<SupportIndexRow> = {},
): SupportIndexRow {
  return {
    id,
    channel: "email",
    inboxId: "inb_acme",
    project: PROJECT,
    subject: `Question ${id}`,
    preview: "",
    customer: { address: "customer@example.test" },
    status: "open",
    owner: null,
    lastMessageAt: "2026-11-09T10:00:00.000Z",
    closedAt: null,
    draftState: null,
    vetoDeadline: null,
    sessionId: null,
    unansweredSince: "2026-11-09T10:00:00.000Z",
    attachmentsExpireAt: null,
    ...fields,
  } as SupportIndexRow;
}

function pr(number: number, fields: Partial<OverviewPr> = {}): OverviewPr {
  return {
    repo: PROJECT,
    number,
    title: `Change ${number}`,
    url: `https://github.example.test/acme/acme/pull/${number}`,
    isDraft: false,
    updatedAt: new Date(NOW - DAY).toISOString(),
    checks: { total: 3, passed: 3, failed: 0, pending: 0 },
    ...fields,
  };
}

beforeEach(() => {
  doc = defaultProjectDocument(PROJECT, "");
  incidents = [
    ...fixtureIncidents(),
    incident({
      signalId: "sig-site",
      openedAt: NOW - 3_600_000,
      openMinutes: null,
      state: "investigating",
      title: "Site slow",
    }),
  ];
  // One agent run this month.
  incidents[incidents.length - 1]!.response = {
    agents: [
      {
        status: "done",
        costUsd: 1.25,
        startedAt: new Date(NOW - 3_000_000).toISOString(),
        endedAt: new Date(NOW - 2_000_000).toISOString(),
      },
    ],
  } as unknown as Incident["response"];
  prs = [
    pr(1),
    pr(2, { checks: { total: 3, passed: 1, failed: 2, pending: 0 } }),
    pr(3, { updatedAt: new Date(NOW - 10 * DAY).toISOString(), isDraft: true }),
    pr(4, { repo: "other" }),
  ];
  audits.length = 0;
  __setLeadAuditForTest((e) => {
    audits.push(e);
  });
  __setLeadOverviewDepsForTest({
    now: () => NOW,
    projectDocument: async () => doc,
    listSignals: async () => SIGNALS,
    listIncidents: async () => incidents,
    listInboxes: async () => [
      inbox("inb_acme", PROJECT),
      inbox("inb_other", "other"),
    ],
    openSupportRows: async () => [
      row("sc_1"),
      row("sc_2", { draftState: "needs-person" }),
      row("sc_3", { draftState: "veto" }),
      row("sc_4", { unansweredSince: null }),
      row("sc_5", { inboxId: "inb_other", project: "other" }),
    ],
    openPrs: async () => prs,
  });
});

afterEach(() => {
  __setLeadOverviewDepsForTest(undefined);
  __setLeadAuditForTest(undefined);
});

describe("buildLeadOverview", () => {
  test("collects the project's incidents, flaps, support, PRs and spend", async () => {
    const { json, markdown } = await buildLeadOverview(PROJECT);
    expect(json.lead).toEqual({
      enabled: false,
      stage: "watch",
      owner: null,
      budgetUsdPerMonth: 50,
    });
    expect(json.incidents.open).toBe(1);
    expect(json.incidents.items[0]).toMatchObject({
      title: "Site slow",
      state: "investigating",
      signalId: "sig-site",
    });
    expect(json.flaps.counts.flapping).toBe(2);
    expect(json.flaps.flapping.map((f) => f.signalId)).toEqual([
      "sig-rail",
      "sig-status",
    ]);
    expect(json.support.inboxes).toEqual([
      {
        id: "inb_acme",
        label: "acme help",
        enabled: true,
        autonomy: "draft",
        vetoMinutes: 10,
      },
    ]);
    expect(json.support.waiting).toBe(2);
    expect(json.support.items.map((i) => i.id)).toEqual(["sc_1", "sc_2"]);
    expect(json.pullRequests).toEqual({
      open: 3,
      drafts: 1,
      failingChecks: 1,
      stale: 1,
      items: [
        expect.objectContaining({ number: 2, failed: 2 }),
        expect.objectContaining({ number: 1, stale: false }),
        expect.objectContaining({ number: 3, stale: true }),
      ],
    });
    expect(json.ci.unavailable).toContain("isn't indexed");
    expect(json.spend).toEqual({
      incidentAgentsUsd: 1.25,
      leadUsd: null,
      leadBudgetUsdPerMonth: 50,
    });
    expect(markdown).toContain("## Incidents: 1 open");
    expect(markdown).toContain("## Support: 2 waiting for a person");
    expect(markdown).toContain(
      "## Pull requests: 3 open, 1 with failing checks, 1 stale, 1 drafts",
    );
    // Customer addresses never reach the overview.
    expect(JSON.stringify(json)).not.toContain("customer@example.test");
  });

  test("lists are capped, counts stay whole", async () => {
    prs = Array.from({ length: 20 }, (_, k) => pr(k + 1));
    const { json, markdown } = await buildLeadOverview(PROJECT);
    if ("unavailable" in json.pullRequests) throw new Error("no PRs");
    expect(json.pullRequests.open).toBe(20);
    expect(json.pullRequests.items).toHaveLength(OVERVIEW_ITEMS);
    expect(markdown).toContain(`- and ${20 - OVERVIEW_ITEMS} more`);
  });

  test("without a PR cache it says so", async () => {
    prs = null;
    const { json, markdown } = await buildLeadOverview(PROJECT);
    expect(json.pullRequests).toEqual({
      unavailable: "No pull request cache on this server",
    });
    expect(markdown).toContain("No pull request cache on this server");
  });
});

test("waitsForPerson", () => {
  expect(waitsForPerson(row("sc_a"))).toBe(true);
  expect(waitsForPerson(row("sc_b", { draftState: "failed" }))).toBe(true);
  expect(waitsForPerson(row("sc_c", { draftState: "sending" }))).toBe(false);
  expect(waitsForPerson(row("sc_d", { status: "closed" }))).toBe(false);
  expect(
    waitsForPerson(row("sc_e", { status: "spam", draftState: "needs-person" })),
  ).toBe(false);
});

describe("opensession-lead", () => {
  async function client() {
    const server = createLeadMcpServer(PROJECT);
    const c = new Client({ name: "test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(b);
    await c.connect(a);
    return async (name: string, args: Record<string, unknown>) => {
      const result = await c.callTool({ name, arguments: args });
      return {
        text: (result.content as Array<{ text?: string }>)
          .map((p) => p.text ?? "")
          .join("\n"),
        isError: result.isError === true,
      };
    };
  }

  test("lists its three tools", async () => {
    const server = createLeadMcpServer(PROJECT);
    const c = new Client({ name: "test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(b);
    await c.connect(a);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "flap_report",
      "project_overview",
      "propose",
    ]);
  });

  test("project_overview and flap_report read", async () => {
    const call = await client();
    const overview = await call("project_overview", {});
    expect(overview.text).toStartWith(`# ${PROJECT} at `);
    const json = JSON.parse(
      (await call("project_overview", { format: "json" })).text,
    );
    expect(json.project).toBe(PROJECT);
    const flaps = await call("flap_report", { windowDays: 14 });
    expect(flaps.text).toContain('Proposed: `{"provider":true}`');
    const narrow = JSON.parse(
      (await call("flap_report", { windowDays: 1, format: "json" })).text,
    );
    expect(narrow.counts.flapping).toBe(0);
  });

  test("propose queues a proposal with its rule", async () => {
    const call = await client();
    const result = await call("propose", {
      category: "signal-rule-change",
      title: "Status page flaps",
      body: "16 incidents closed by themselves.",
      options: ["Raise to 8 failures", "Leave it"],
    });
    expect(result).toEqual({
      text: "Queued for the owner as a proposal. Rule: Asks first: Signal rule changes, from the project settings.",
      isError: false,
    });
    expect(audits).toEqual([
      {
        kind: "lead_proposal",
        project: PROJECT,
        proposalKind: "proposal",
        category: "signal-rule-change",
        level: "asks-first",
        effective: "ask",
        rule: "Asks first: Signal rule changes, from the project settings",
        title: "Status page flaps",
        bodyDigest: expect.any(String),
        options: 2,
      },
    ]);
  });

  test("watch turns an alone category into a proposal", async () => {
    doc = { ...doc, lead: { ...doc.lead, enabled: true } };
    const call = await client();
    const result = await call("propose", {
      category: "ci-repair",
      title: "Fix the lint job",
      body: "It fails on main.",
    });
    expect(result.text).toBe(
      "Queued for the owner as a proposal. Rule: Watch: every action is a proposal, from the project settings.",
    );
  });

  test("only-you categories are refused unless they come as needs you", async () => {
    const call = await client();
    const refused = await call("propose", {
      category: "refund",
      title: "Refund order 123",
      body: "Charged twice.",
    });
    expect(refused).toEqual({
      text: "Only the owner decides refunds (Only you: Refunds, always). Prepare it and ask the owner: call propose again with kind needs-you and what you prepared.",
      isError: true,
    });
    expect(audits).toEqual([]);
    const asked = await call("propose", {
      category: "refund",
      title: "Refund order 123",
      body: "Charged twice; the refund is drafted in Stripe.",
      kind: "needs-you",
    });
    expect(asked.text).toBe(
      "Queued for the owner as needs you. Rule: Only you: Refunds, always.",
    );
    expect(audits[0]).toMatchObject({
      proposalKind: "needs-you",
      effective: "prepare",
    });
  });

  test("a category the project keeps for the owner is refused too", async () => {
    doc = {
      ...doc,
      lead: {
        ...doc.lead,
        rules: { ...doc.lead.rules, "rotate-key": "only-you" },
      },
    };
    const call = await client();
    const refused = await call("propose", {
      category: "rotate-key",
      title: "Rotate the API key",
      body: "It leaked in a log.",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(
      "Only you: Rotating keys, from the project settings",
    );
  });
});
