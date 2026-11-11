// opensession-lead's tools against the real supervisor inbox on the
// in-memory kernel, with the overview's sources replaced.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  defaultProjectDocument,
  type ProjectSettingsDocument,
} from "../../shared/project-settings";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { catalogDocuments } from "../catalog-documents";
import {
  SUPERVISOR_ITEMS_NAMESPACE,
  __resetSupervisorInboxForTest,
  __setSupervisorInboxDepsForTest,
  listSupervisorItems,
  postSupervisorItem,
  supervisorInboxKey,
} from "../supervisor-inbox";
import { __setLeadApprovalsDepsForTest, listForProject } from "./approvals";
import { createLeadMcpServer } from "./mcp";
import { __setLeadOverviewDepsForTest } from "./overview";
import { __setLeadAuditForTest } from "./report";
import { NOW, PROJECT, SIGNALS, fixtureIncidents } from "./testing/fixture";

useIncidentTestKernel();
let doc: ProjectSettingsDocument;
let clock = NOW;
let pushes: string[] = [];
const audits: Array<Record<string, unknown>> = [];
let restoreInbox: () => void = () => {};
let restoreApprovals: () => void = () => {};
let ids = 0;

beforeEach(() => {
  clock = NOW;
  pushes = [];
  audits.length = 0;
  doc = defaultProjectDocument(PROJECT, "");
  doc = { ...doc, lead: { ...doc.lead, enabled: true } };
  __setOwnerRosterForTest(
    [
      { name: "Ada Lovelace", github: "ada" },
      { name: "Grace Hopper", github: "grace" },
    ] as never,
    "Ada",
  );
  __setLeadAuditForTest((e) => {
    audits.push(e);
  });
  __setLeadOverviewDepsForTest({
    now: () => clock,
    projectDocument: async () => doc,
    listSignals: async () => SIGNALS,
    getConversation: async () => null,
    listIncidents: async () => fixtureIncidents(),
    listInboxes: async () => [],
    openSupportRows: async () => [],
    openPrs: async () => null,
    getGoal: async () => null,
    projectLabel: () => "Acme",
    projectGhRepos: () => ["acme/app"],
  });
  ids = 0;
  restoreApprovals = __setLeadApprovalsDepsForTest({
    now: () => clock,
    newId: () => `lp-${++ids}`,
  });
  restoreInbox = __setSupervisorInboxDepsForTest({
    now: () => clock,
    // Banners only: an update of a pushed item changes its row quietly.
    notify: async (user, event) => {
      if (event.delivery === "alert") pushes.push(user);
      return {};
    },
    markDone: async () => {},
    supervisorSessionId: async (user) => `os-sup-${user}`,
    timeZone: () => "UTC",
  });
});

afterEach(() => {
  restoreApprovals();
  restoreInbox();
  __resetSupervisorInboxForTest();
  __setOwnerRosterForTest(undefined);
  __setLeadAuditForTest(undefined);
  __setLeadOverviewDepsForTest(undefined);
});

async function client() {
  const server = createLeadMcpServer(PROJECT);
  const c = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(b);
  await c.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await c.callTool({ name, arguments: args });
    return {
      text: (result.content as Array<{ text?: string }>)
        .map((p) => p.text ?? "")
        .join("\n"),
      isError: result.isError === true,
    };
  };
  return { c, call };
}

const flapProposal = {
  category: "signal-rule-change",
  title: "Status page flaps",
  body: "16 incidents closed by themselves within 6 minutes.",
  options: ["Raise to 8 failures in a row", "Leave it"],
  subject: "sig-status consecutive.failures",
};

describe("opensession-lead", () => {
  test("Blob's GitHub tools refuse while the lead may not report", async () => {
    doc = { ...doc, lead: { ...doc.lead, enabled: false } };
    const { call } = await client();
    const off = await call("blob_comment", {
      repo: "acme/app",
      number: 1,
      body: "Hi",
    });
    expect(off).toEqual({
      isError: true,
      text: "The lead is off in the project settings",
    });
    // On, the call reaches Blob's account checks (github-blob.ts), which
    // refuse here: Blob's account isn't set up.
    doc = { ...doc, lead: { ...doc.lead, enabled: true } };
    const on = await call("blob_comment", {
      repo: "acme/app",
      number: 1,
      body: "Hi",
    });
    expect(on.isError).toBe(true);
    expect(on.text).toContain("Blob's GitHub account is off");
  });

  test("lists its tools", async () => {
    const { c } = await client();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "blob_comment",
      "blob_label",
      "blob_open_issue",
      "blob_review",
      "flap_report",
      "lead_apply",
      "post_digest_note",
      "project_overview",
      "propose",
    ]);
  });

  test("project_overview and flap_report read", async () => {
    const { call } = await client();
    expect((await call("project_overview", {})).text).toStartWith(
      `# ${PROJECT} at `,
    );
    const json = JSON.parse(
      (await call("project_overview", { format: "json" })).text,
    );
    expect(json.project).toBe(PROJECT);
    expect((await call("flap_report", {})).text).toContain(
      'Proposed: `{"provider":true}`',
    );
    const narrow = JSON.parse(
      (await call("flap_report", { windowDays: 1, format: "json" })).text,
    );
    expect(narrow.counts.flapping).toBe(0);
  });

  test("propose raises a needs-you item for the instance owner, with its rule", async () => {
    const { call } = await client();
    const result = await call("propose", flapProposal);
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(
      /^Queued for the owner as a proposal \(si-[^)]+\)\. Rule: Asks first: Signal rule changes, from the project settings\.$/,
    );
    const [item] = await listSupervisorItems("Ada");
    expect(item).toMatchObject({
      kind: "needs-you",
      source: "lead:acme",
      project: PROJECT,
      // The server writes the title. The body leads with what Blob says
      // (the lead's say fence or first paragraph), then the rule that applied, the
      // lead's title and the rest.
      title: "Acme: Signal rule changes",
      options: ["Raise to 8 failures in a row", "Leave it"],
      dedupeKey: "lead:acme:signal-rule-change:sig-status consecutive.failures",
    });
    expect(item!.body).toBe(
      "16 incidents closed by themselves within 6 minutes.\n\nRule: Asks first: Signal rule changes, from the project settings.\n\nStatus page flaps",
    );
    expect(pushes).toEqual(["Ada"]);
    expect(audits[0]).toMatchObject({
      actor: "Blob",
      kind: "lead_proposal",
      delivered: true,
      owner: "Ada",
      effective: "ask",
      created: true,
    });
    expect(JSON.stringify(audits)).not.toContain("16 incidents");
    expect(JSON.stringify(audits)).not.toContain("Status page flaps");
    expect(audits[0]!.titleDigest).toEqual(expect.any(String));
  });

  test("a repeat about the same subject updates the item, no second push", async () => {
    const { call } = await client();
    await call("propose", flapProposal);
    clock += 6 * 3_600_000;
    const again = await call("propose", {
      ...flapProposal,
      title: "Status page still flaps",
    });
    expect(again.text).toStartWith("Updated for the owner as a proposal");
    const items = await listSupervisorItems("Ada");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Acme: Signal rule changes");
    expect(items[0]!.body).toEndWith("\n\nStatus page still flaps");
    expect(pushes).toEqual(["Ada"]);
  });

  test("the body's say fence is what Blob says; the rest is shown", async () => {
    const { call } = await client();
    await call("propose", {
      ...flapProposal,
      body: "```say\nThe status signal keeps flapping.\n\nI'd raise its threshold.\n```\n| Opened | Closed alone |\n| --- | --- |\n| 16 | 16 |",
    });
    const [item] = await listSupervisorItems("Ada");
    expect(item!.body.split("\n\n")).toEqual([
      "```say\nThe status signal keeps flapping.",
      "I'd raise its threshold.\n```",
      "Rule: Asks first: Signal rule changes, from the project settings.",
      "Status page flaps",
      "| Opened | Closed alone |\n| --- | --- |\n| 16 | 16 |",
    ]);
  });

  test("without a say fence, the first paragraph is what Blob says", async () => {
    const { call } = await client();
    await call("propose", {
      ...flapProposal,
      body: "The status signal keeps flapping; I'd raise its threshold.\n\n| Opened | Closed alone |\n| --- | --- |\n| 16 | 16 |\n\nAll within 6 minutes.",
    });
    const [item] = await listSupervisorItems("Ada");
    expect(item!.body.split("\n\n")).toEqual([
      "The status signal keeps flapping; I'd raise its threshold.",
      "Rule: Asks first: Signal rule changes, from the project settings.",
      "Status page flaps",
      "| Opened | Closed alone |\n| --- | --- |\n| 16 | 16 |",
      "All within 6 minutes.",
    ]);
  });

  test("propose and post_digest_note tell the lead how Blob presents the body", async () => {
    const { c } = await client();
    const { tools } = await c.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const param = (tool: string, name: string) =>
      (
        byName.get(tool)?.inputSchema.properties?.[name] as
          | { description?: string }
          | undefined
      )?.description;
    expect(byName.get("propose")?.description).toContain(
      "a leading ```say fence is spoken, the rest is shown, in the owner's report style",
    );
    expect(param("propose", "body")).toContain(
      "A ```say fence first: what Blob says aloud when it presents the decision",
    );
    expect(param("post_digest_note", "text")).toContain(
      "A ```say fence first: what Blob says aloud",
    );
  });

  test("the lead's owner gets it, and the default options put approve first", async () => {
    doc = { ...doc, lead: { ...doc.lead, owner: "Grace" } };
    const { call } = await client();
    await call("propose", {
      category: "dependency-major",
      title: "Upgrade the web framework",
      body: "Two majors behind.",
    });
    expect(await listSupervisorItems("Ada")).toEqual([]);
    const [item] = await listSupervisorItems("Grace");
    expect(item!.options).toEqual(["Approve", "Not now"]);
  });

  test("with nobody to report to, propose says so", async () => {
    __setOwnerRosterForTest([], "");
    const { call } = await client();
    expect(await call("propose", flapProposal)).toEqual({
      text: "Nobody to report to: set the lead's owner in the project settings",
      isError: true,
    });
    expect(audits[0]).toMatchObject({ delivered: false });
  });

  test("a lead that is off, or a project with agents paused, reports nothing", async () => {
    for (const [next, reason] of [
      [
        { ...doc, lead: { ...doc.lead, enabled: false } },
        "The lead is off in the project settings",
      ],
      [
        { ...doc, incidents: { ...doc.incidents, agentsPaused: true } },
        "Agents are paused for this project: the lead reports nothing until they run again",
      ],
    ] as const) {
      doc = next;
      const { call } = await client();
      expect(await call("propose", flapProposal)).toEqual({
        text: reason,
        isError: true,
      });
      expect(await call("post_digest_note", { text: "Quiet." })).toEqual({
        text: reason,
        isError: true,
      });
    }
    expect(await listSupervisorItems("Ada")).toEqual([]);
    expect(pushes).toEqual([]);
  });

  test("watch turns an alone category into a proposal", async () => {
    const { call } = await client();
    const result = await call("propose", {
      category: "ci-repair",
      title: "Fix the lint job",
      body: "It fails on main.",
    });
    expect(result.text).toEndWith(
      "Rule: Watch: every action is a proposal, from the project settings.",
    );
  });

  test("only-you categories are refused unless they come as needs you", async () => {
    const { call } = await client();
    const refused = await call("propose", {
      category: "refund",
      title: "Refund order 123",
      body: "Charged twice.",
    });
    expect(refused).toEqual({
      text: "Only the owner decides refunds (Only you: Refunds, always). Prepare it and ask the owner: call propose again with kind needs-you and what you prepared.",
      isError: true,
    });
    expect(await listSupervisorItems("Ada")).toEqual([]);
    const asked = await call("propose", {
      category: "refund",
      title: "Refund order 123",
      body: "Charged twice; the refund is drafted in the payment dashboard.",
      kind: "needs-you",
    });
    expect(asked.text).toMatch(/^Queued for the owner as needs you/);
    const [item] = await listSupervisorItems("Ada");
    expect(item!.options).toEqual(["I'll do it", "Not now"]);
  });

  test("a category the project keeps for the owner is refused too", async () => {
    doc = {
      ...doc,
      lead: {
        ...doc.lead,
        rules: { ...doc.lead.rules, "rotate-key": "only-you" },
      },
    };
    const { call } = await client();
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

  test("post_digest_note keeps one quiet note per day", async () => {
    const { call } = await client();
    const first = await call("post_digest_note", { text: "Two flaps." });
    expect(first.text).toMatch(/^Saved for today's digest \(si-/);
    await call("post_digest_note", { text: "Two flaps, one proposal." });
    let notes = await listSupervisorItems("Ada", { kind: "fyi" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      body: "Two flaps, one proposal.",
      dedupeKey: "lead:acme:digest:2026-11-10",
      title: "Acme: what the lead saw today",
    });
    expect(pushes).toEqual([]);
    clock += 86_400_000;
    await call("post_digest_note", { text: "Quiet day." });
    notes = await listSupervisorItems("Ada", { kind: "fyi" });
    expect(notes.map((n) => n.dedupeKey).sort()).toEqual([
      "lead:acme:digest:2026-11-10",
      "lead:acme:digest:2026-11-11",
    ]);
  });

  test("post_digest_note finds today's note behind a full inbox", async () => {
    const { call } = await client();
    await call("post_digest_note", { text: "Two flaps." });
    // That note went out in a digest: a later one starts a new item.
    await catalogDocuments(SUPERVISOR_ITEMS_NAMESPACE).update(
      supervisorInboxKey("Ada"),
      (doc) => {
        const d = doc as { items: Array<Record<string, unknown>> };
        return {
          ...d,
          items: d.items.map((item) => ({ ...item, digestedAt: clock })),
        };
      },
    );
    for (let i = 0; i < 101; i++) {
      clock += 1_000;
      await postSupervisorItem({
        user: "Ada",
        source: "supervisor",
        kind: "fyi",
        title: `Note ${i}`,
        body: "x",
        dedupeKey: `other:${i}`,
      });
    }
    await call("post_digest_note", { text: "Two flaps, one proposal." });
    const notes = await listSupervisorItems("Ada", {
      kind: "fyi",
      dedupeKeyPrefix: "lead:acme:digest:",
    });
    // The digested note is kept as it was; the new one is its own item.
    expect(
      notes
        .map((n) => [n.dedupeKey, n.body])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ["lead:acme:digest:2026-11-10", "Two flaps."],
      ["lead:acme:digest:2026-11-10:2", "Two flaps, one proposal."],
    ]);
  });

  describe("propose with steps", () => {
    const SHA = "abc1234".padEnd(40, "0");
    const merge = {
      kind: "merge-pr",
      ghRepo: "acme/app",
      number: 533,
      headSha: SHA,
    } as const;
    const fix = {
      category: "fix-verified",
      title: "Checkout fix is verified",
      body: "The verifier reproduced the bug and confirmed the fix.",
      subject: "PR 533",
    };
    const patch = {
      kind: "signal-patch",
      signalId: "sig-status",
      before: { rule: { kind: "consecutive", failures: 3, recoveries: 2 } },
      after: { rule: { kind: "consecutive", failures: 8, recoveries: 2 } },
    };

    test("records the steps bound to the item and ends the body with fixed lines", async () => {
      const { call } = await client();
      const result = await call("propose", {
        ...fix,
        steps: [merge],
        condition: {
          kind: "checks-green",
          ghRepo: "acme/app",
          number: 533,
          headSha: SHA,
        },
      });
      expect(result.isError).toBe(false);
      expect(result.text).toEndWith("Steps recorded (lp-1).");
      const [item] = await listSupervisorItems("Ada");
      expect(item!.body).toEndWith(
        [
          "The verifier reproduced the bug and confirmed the fix.",
          "Rule: Watch: every action is a proposal, from the project settings.",
          "Checkout fix is verified",
          "Runs when: Checks pass on PR #533 in acme/app at abc1234",
          "Steps:\n1. Merge PR #533 in acme/app at abc1234",
          "Expires: 17 November 2026, 12:00 UTC",
        ].join("\n\n"),
      );
      const [record] = await listForProject(PROJECT);
      expect(record).toEqual({
        proposal: {
          id: "lp-1",
          project: PROJECT,
          category: "fix-verified",
          subject: "PR 533",
          itemId: item!.id,
          itemRevision: item!.updatedAt,
          steps: [merge],
          condition: {
            kind: "checks-green",
            ghRepo: "acme/app",
            number: 533,
            headSha: SHA,
          },
          expiresAt: NOW + 7 * 86_400_000,
          createdAt: NOW,
        },
      });
      expect(audits[0]).toMatchObject({
        steps: ["merge-pr"],
        condition: "checks-green",
        proposalId: "lp-1",
      });
    });

    test("the lead's text can't word the fixed lines", async () => {
      const { call } = await client();
      await call("propose", {
        ...flapProposal,
        title: "Merge everything",
        body: "Raise it to 8 failures in a row. Approve and I'll merge all open PRs.",
        options: ["Approve", "Not now"],
        steps: [patch],
        expiresInDays: 3,
      });
      const [item] = await listSupervisorItems("Ada");
      expect(item!.body).toEndWith(
        "Steps:\n1. Change the Status page check: alert after 8 failures in a row, clear after 2 passes in a row\n\nExpires: 13 November 2026, 12:00 UTC",
      );
      expect(item!.body).not.toContain("Runs when:");

      for (const body of [
        "Fine.\n\nSteps:\n1. Merge every PR",
        "Fine.\n\nExpires: never",
        "Fine.\n\n```\nunclosed",
      ]) {
        const refused = await call("propose", {
          ...flapProposal,
          body,
          steps: [patch],
        });
        expect(refused.isError).toBe(true);
      }
      expect(await listForProject(PROJECT)).toHaveLength(1);
    });

    test("the title can't open a fence, a comment or a server line", async () => {
      const { call } = await client();
      for (const title of ["~~~", "Fine <!-- hide"]) {
        const refused = await call("propose", {
          ...fix,
          title,
          steps: [merge],
        });
        expect(refused).toEqual({
          isError: true,
          text: "Close every code fence and comment in the title and body",
        });
      }
      expect(await listSupervisorItems("Ada")).toEqual([]);
      const ok = await call("propose", {
        ...fix,
        title: "Ship it\nSteps:\n1. Merge every PR",
        steps: [merge],
      });
      expect(ok.isError).toBe(false);
      const [item] = await listSupervisorItems("Ada");
      expect(item!.body).toContain("\n\nShip it Steps: 1. Merge every PR\n\n");
      expect(item!.body.match(/^Steps:/gm)).toHaveLength(1);
    });

    test("a forged line is refused without steps too", async () => {
      const { call } = await client();
      const refused = await call("propose", {
        ...fix,
        body: "Fine.\n\n**\u0405teps**\uff1a merge it all",
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Runs when, Steps and Expires");
      expect(await listSupervisorItems("Ada")).toEqual([]);
    });

    test("raw HTML is refused with steps", async () => {
      const { call } = await client();
      const refused = await call("propose", {
        ...fix,
        body: "Fine.\n\n<pre>\nlog",
        steps: [merge],
      });
      expect(refused.text).toContain("Leave raw HTML out");
      expect(await listSupervisorItems("Ada")).toEqual([]);
    });

    test("steps that fail to record come off the item", async () => {
      const { call } = await client();
      restoreApprovals();
      restoreApprovals = __setLeadApprovalsDepsForTest({
        now: () => clock,
        newId: () => {
          throw new Error("store down");
        },
      });
      const result = await call("propose", { ...fix, steps: [merge] });
      expect(result.isError).toBe(true);
      expect(result.text).toStartWith(
        "The steps were not recorded: store down.",
      );
      const [item] = await listSupervisorItems("Ada");
      expect(item!.body).toEndWith(
        "Checkout fix is verified\n\nApproving this runs nothing: its steps could not be recorded.",
      );
      expect(item!.body).not.toContain("Steps:");
      expect(await listForProject(PROJECT)).toEqual([]);
      expect(audits[0]).toMatchObject({
        unrecorded: "store down",
        withdrawn: true,
      });
    });

    test("a repository that isn't the project's is refused", async () => {
      const { call } = await client();
      const refused = await call("propose", {
        ...fix,
        steps: [{ ...merge, ghRepo: "example/other" }],
      });
      expect(refused).toEqual({
        isError: true,
        text: "Step 1: example/other is not this project's repository (acme/app)",
      });
      const condition = await call("propose", {
        ...fix,
        steps: [merge],
        condition: { kind: "pr-merged", ghRepo: "example/other", number: 1 },
      });
      expect(condition.text).toBe(
        "Condition: example/other is not this project's repository (acme/app)",
      );
      expect(await listSupervisorItems("Ada")).toEqual([]);
      expect(await listForProject(PROJECT)).toEqual([]);
    });

    test("a step that doesn't fit the category is refused", async () => {
      const { call } = await client();
      const refused = await call("propose", {
        ...flapProposal,
        steps: [merge],
      });
      expect(refused).toEqual({
        isError: true,
        text: "Step 1: merge-pr doesn't fit signal rule changes; it serves only fixes verified by a second agent, public releases or ci repair",
      });
      const send = await call("propose", {
        ...fix,
        steps: [
          { kind: "support-send", conversationId: "sc-1", draftId: "d-1" },
        ],
      });
      expect(send.isError).toBe(true);
      const autofix = await call("propose", {
        ...fix,
        steps: [{ ...merge, kind: "autofix-pr" }],
      });
      expect(autofix.text).toStartWith("Step 1: autofix-pr doesn't fit");
      const signal = await call("propose", {
        ...flapProposal,
        steps: [{ ...patch, signalId: "sig-elsewhere" }],
      });
      expect(signal.text).toBe(
        "Step 1: sig-elsewhere is not a signal of this project",
      );
      expect(await listSupervisorItems("Ada")).toEqual([]);
    });

    test("lead_apply runs nothing at the watch stage", async () => {
      const { call } = await client();
      await call("propose", { ...fix, steps: [merge] });
      const result = await call("lead_apply", { proposalId: "lp-1" });
      expect(result).toEqual({
        isError: true,
        text: "Watch stage: the lead proposes and nothing runs. Nothing ran.",
      });
      expect(
        (await listForProject(PROJECT)).map((r) => r.approval?.state),
      ).toEqual([undefined]);
    });

    test("a condition or expiry without steps is refused", async () => {
      const { call } = await client();
      const refused = await call("propose", { ...fix, expiresInDays: 3 });
      expect(refused.isError).toBe(true);
      expect(await listSupervisorItems("Ada")).toEqual([]);
    });

    test("without steps nothing is recorded, and an update voids the old steps", async () => {
      const { call } = await client();
      await call("propose", { ...fix, steps: [merge] });
      const [first] = await listSupervisorItems("Ada");
      clock += 60_000;
      const plain = await call("propose", fix);
      expect(plain.text).not.toContain("Steps recorded");
      const [item] = await listSupervisorItems("Ada");
      expect(item!.id).toBe(first!.id);
      expect(item!.body).toBe(
        "The verifier reproduced the bug and confirmed the fix.\n\nRule: Watch: every action is a proposal, from the project settings.\n\nCheckout fix is verified",
      );
      const [record] = await listForProject(PROJECT);
      expect(record!.proposal.voidReason).toBe("superseded");
      expect(audits[1]).not.toHaveProperty("steps");
    });
  });
});
