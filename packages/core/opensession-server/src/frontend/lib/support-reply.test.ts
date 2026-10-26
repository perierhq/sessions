import { describe, expect, test } from "bun:test";
import type { KnowledgeVerdict } from "../../shared/knowledge";
import type { SupportConversation } from "../../shared/support";
import { AT, conversation, draft, message } from "../tools/support-fixture";
import {
  draftHeader,
  draftSendLabel,
  draftSources,
  knowledgeChip,
  pendingIssueCopy,
  waitingFixedNote,
  sendingDiscardable,
  replyBoxMode,
  replyDraftKey,
  supportIntentPlan,
  timelineEntries,
  vetoLabel,
} from "./support-reply";

describe("replyBoxMode", () => {
  test("no draft composes", () => {
    expect(replyBoxMode(conversation())).toEqual({ kind: "compose" });
  });

  test("a settled draft composes", () => {
    expect(replyBoxMode(conversation({ draft: draft("sent") }))).toEqual({
      kind: "compose",
    });
    expect(replyBoxMode(conversation({ draft: draft("discarded") }))).toEqual({
      kind: "compose",
    });
  });

  test("each live draft state maps to its mode", () => {
    const review = draft("needs-person");
    expect(replyBoxMode(conversation({ draft: review }))).toEqual({
      kind: "review",
      draft: review,
    });
    const veto = draft("veto");
    expect(replyBoxMode(conversation({ draft: veto }))).toEqual({
      kind: "veto",
      draft: veto,
      deadline: Date.parse("2026-10-25T10:15:00.000Z"),
    });
    const sending = draft("sending");
    expect(replyBoxMode(conversation({ draft: sending }))).toEqual({
      kind: "sending",
      draft: sending,
    });
    const failed = draft("failed");
    expect(replyBoxMode(conversation({ draft: failed }))).toEqual({
      kind: "failed",
      draft: failed,
    });
  });

  test("a veto without a deadline waits for a person", () => {
    const odd = draft("veto", { vetoDeadline: null });
    expect(replyBoxMode(conversation({ draft: odd }))).toEqual({
      kind: "review",
      draft: odd,
    });
  });
});

describe("vetoLabel", () => {
  test("counts down under ten minutes", () => {
    const now = Date.parse(AT);
    expect(vetoLabel(now + 299_000, now)).toBe("Sends in 4:59");
    expect(vetoLabel(now + 599_000, now)).toBe("Sends in 9:59");
  });

  test("names the clock time from ten minutes out", () => {
    const deadline = new Date(2026, 9, 25, 14, 5).getTime();
    expect(vetoLabel(deadline, deadline - 3_600_000)).toBe("Sends at 14:05");
  });

  test("a passed deadline is sending", () => {
    const now = Date.parse(AT);
    expect(vetoLabel(now - 1, now)).toBe("Sending soon");
  });
});

describe("timelineEntries", () => {
  test("messages and events in time order", () => {
    const c = conversation({
      messages: [
        message({ id: "sm_1", at: "2026-10-25T10:00:00.000Z" }),
        message({
          id: "sm_2",
          direction: "out",
          at: "2026-10-25T10:05:00.000Z",
          from: { name: null, address: "help@acme.example.test" },
          sentBy: { kind: "agent", sessionId: "s1" },
          text: "Try resetting your password",
        }),
      ],
      events: [
        {
          at: "2026-10-25T10:02:00.000Z",
          kind: "agent-started",
          actor: { kind: "sessions" },
          detail: "Support agent started",
        },
      ],
    });
    const entries = timelineEntries(c);
    expect(entries.map((e) => e.id)).toEqual(["sm_1", "event:0", "sm_2"]);
    expect(entries[0]).toMatchObject({
      kind: "email",
      actorType: "customer",
      actorName: "Grace",
      text: "I can't sign in",
    });
    expect(entries[1]).toMatchObject({
      kind: "note",
      actorType: "system",
      actorName: "Sessions",
      text: "Support agent started",
    });
    expect(entries[2]).toMatchObject({
      kind: "email",
      actorType: "bot",
      actorName: "Support agent",
    });
  });

  test("a person's reply is ours, and retention-removed text says so", () => {
    const c = conversation({
      messages: [
        message({ text: null }),
        message({
          id: "sm_2",
          direction: "out",
          at: "2026-10-25T10:05:00.000Z",
          sentBy: { kind: "person", name: "Ada" },
        }),
      ],
    });
    const [first, second] = timelineEntries(c);
    expect(first!.text).toBe("(Removed after the retention period)");
    expect(second).toMatchObject({ actorType: "support", actorName: "Ada" });
  });

  test("attachments link to the conversation's download route until they expire", () => {
    const c = conversation({
      messages: [
        message({
          attachments: [
            {
              id: "att_1",
              fileName: "shot.png",
              mimeType: "image/png",
              sizeBytes: 10,
              stored: true,
              expiresAt: null,
            },
            {
              id: "att_2",
              fileName: "old.pdf",
              mimeType: "application/pdf",
              sizeBytes: 10,
              stored: false,
              expiresAt: null,
            },
          ],
        }),
      ],
    });
    const [entry] = timelineEntries(c);
    expect(entry!.attachments![0]!.href).toEndWith(
      "/api/support/conversations/sc_0001/attachments/att_1",
    );
    expect(entry!.attachments![1]!.href).toBeNull();
  });
});

describe("draft copy", () => {
  test("the header names who drafted and why", () => {
    const now = Date.parse(AT);
    expect(
      draftHeader({ kind: "review", draft: draft("needs-person") }, now),
    ).toBe("Draft by the agent · Draft: a person sends");
    expect(
      draftHeader(
        { kind: "veto", draft: draft("veto"), deadline: now + 299_000 },
        now,
      ),
    ).toBe("Draft by the agent · Sends in 4:59");
    expect(
      draftHeader(
        {
          kind: "review",
          draft: draft("needs-person", {
            author: { kind: "person", name: "Ada" },
          }),
        },
        now,
      ),
    ).toBe("Draft by Ada · Draft: a person sends");
  });

  test("a draft's local edits live under its own key", () => {
    expect(replyDraftKey("sc_1", "sd_1")).toBe("support-reply:sc_1:sd_1");
    expect(replyDraftKey("sc_1")).toBe("support-reply:sc_1");
  });
});

describe("supportIntentPlan", () => {
  const now = Date.parse(AT);
  test("stop asks first while the veto window is open", () => {
    expect(
      supportIntentPlan("stop", {
        kind: "veto",
        draft: draft("veto"),
        deadline: now + 60_000,
      }),
    ).toEqual({ kind: "confirm-stop" });
  });

  test("review focuses Send on a draft waiting for a person", () => {
    expect(
      supportIntentPlan("review", {
        kind: "review",
        draft: draft("needs-person"),
      }),
    ).toEqual({ kind: "focus", target: "send" });
    expect(
      supportIntentPlan("review", { kind: "failed", draft: draft("failed") }),
    ).toEqual({ kind: "focus", target: "send" });
    expect(
      supportIntentPlan("review", {
        kind: "veto",
        draft: draft("veto"),
        deadline: now + 60_000,
      }),
    ).toEqual({ kind: "focus", target: "stop" });
  });

  test("an intent with nothing left to act on says so", () => {
    expect(supportIntentPlan("stop", { kind: "compose" })).toEqual({
      kind: "stale",
      message: "Nothing to stop: the reply was already handled",
    });
    expect(
      supportIntentPlan("stop", {
        kind: "review",
        draft: draft("needs-person"),
      }),
    ).toEqual({
      kind: "stale",
      message: "Nothing to stop: the reply is waiting for you",
    });
    expect(supportIntentPlan("review", { kind: "compose" })).toEqual({
      kind: "stale",
      message: "Nothing to review: the reply was already handled",
    });
  });
});

describe("pendingIssueCopy", () => {
  const held = (heldFor?: string) => {
    const issue: NonNullable<SupportConversation["pendingIssue"]> = {
      title: "Login fails",
      body: "Steps",
      requestedBy: { kind: "agent", sessionId: "s1" },
    };
    if (heldFor) issue.heldFor = heldFor;
    return issue;
  };
  const prepared =
    "The agent prepared an issue. Nothing is posted until you create it.";
  test("a public repository needs the owner to post", () => {
    expect(pendingIssueCopy(held(), true)).toEqual({
      text: prepared,
      canApprove: true,
    });
    expect(
      pendingIssueCopy(
        held("Waiting for a person: the repository is public"),
        false,
      ),
    ).toEqual({
      text: prepared,
      canApprove: false,
      why: "The repository is public. Only the instance owner can post the issue",
    });
  });
  test("any other hold says why as the server wrote it", () => {
    expect(
      pendingIssueCopy(
        held("Waiting for a person: too many issues today"),
        false,
      ),
    ).toEqual({
      text: prepared,
      canApprove: true,
      why: "Waiting for a person: too many issues today",
    });
  });
});

describe("draft sources", () => {
  test("a public link opens; a path and a record read as they are", () => {
    const rows = draftSources(
      draft("needs-person", {
        sources: [
          { kind: "url", ref: "https://docs.acme.example.test/reset?x=1" },
          { kind: "repo", ref: "docs/sign-in.md" },
          { kind: "record", ref: "stripe:cus_123" },
          { kind: "url", ref: "javascript:alert(1)" },
          { kind: "repo", ref: "  " },
        ],
      }),
      "acme",
    );
    expect(rows).toEqual([
      {
        kind: "url",
        label: "docs.acme.example.test/reset?x=1",
        href: "https://docs.acme.example.test/reset?x=1",
      },
      { kind: "repo", label: "docs/sign-in.md", href: null },
      { kind: "record", label: "stripe:cus_123", href: null },
      { kind: "url", label: "javascript:alert(1)", href: null },
    ]);
  });
  test("a draft without sources has none", () => {
    expect(draftSources(draft("needs-person"), "acme")).toEqual([]);
  });
});

describe("knowledge sources", () => {
  const SHA = "3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a";
  const EXPORT = `articles/export.md@${SHA}`;
  const REFUNDS = `articles/refunds.md@${SHA}`;
  const exportHref =
    "/settings/projects/acme/knowledge/articles/articles%2Fexport.md";
  const verdict = (over: Partial<KnowledgeVerdict> = {}): KnowledgeVerdict => ({
    backing: [],
    blocked: [],
    internalQuoted: null,
    failed: false,
    at: AT,
    ...over,
  });
  const cited = (knowledge?: KnowledgeVerdict, refs = [EXPORT]) => {
    const d = draft("needs-person", {
      sources: refs.map((ref) => ({ kind: "knowledge" as const, ref })),
    });
    if (knowledge)
      d.check = {
        verified: [],
        topics: [],
        promises: false,
        knowledge,
        at: AT,
      };
    return d;
  };

  test("a backing citation shows its title and reads as fresh", () => {
    const rows = draftSources(
      cited(
        verdict({
          backing: [{ kind: "knowledge", ref: EXPORT, title: "Export" }],
        }),
      ),
      "acme",
    );
    expect(rows).toEqual([
      {
        kind: "knowledge",
        label: "knowledge:articles/export.md@3f2a1b0",
        href: exportHref,
        knowledge: { title: "Export", state: "backing", reason: null },
      },
    ]);
  });

  test("a blocked citation carries its reason", () => {
    const rows = draftSources(
      cited(
        verdict({
          backing: [{ kind: "knowledge", ref: EXPORT, title: "Export" }],
          blocked: [
            {
              ref: `knowledge:${REFUNDS}`,
              path: "articles/refunds.md",
              title: "Refunds",
              reason: "docs/billing.md changed in 9c1d2e0",
            },
          ],
        }),
        [EXPORT, `knowledge:${REFUNDS}`],
      ),
      "acme",
    );
    expect(rows.map((r) => [r.label, r.knowledge])).toEqual([
      [
        "knowledge:articles/export.md@3f2a1b0",
        { title: "Export", state: "backing", reason: null },
      ],
      [
        "knowledge:articles/refunds.md@3f2a1b0",
        {
          title: "Refunds",
          state: "blocked",
          reason: "docs/billing.md changed in 9c1d2e0",
        },
      ],
    ]);
  });

  test("a draft without a knowledge check shows the row without state", () => {
    expect(draftSources(cited(), "acme")).toEqual([
      {
        kind: "knowledge",
        label: "knowledge:articles/export.md@3f2a1b0",
        href: exportHref,
      },
    ]);
  });

  test("an item read but not cited that holds the draft is its own row", () => {
    const rows = draftSources(
      cited(
        verdict({
          backing: [{ kind: "knowledge", ref: EXPORT, title: "Export" }],
          blocked: [
            {
              ref: REFUNDS,
              path: "articles/refunds.md",
              title: "Refunds",
              reason: "Review date passed (2026-10-01)",
              uncited: true,
            },
          ],
        }),
      ),
      "acme",
    );
    expect(rows[1]).toEqual({
      kind: "knowledge",
      label: "knowledge:articles/refunds.md@3f2a1b0",
      href: "/settings/projects/acme/knowledge/articles/articles%2Frefunds.md",
      knowledge: {
        title: "Refunds",
        state: "blocked",
        reason: "Review date passed (2026-10-01)",
        uncited: true,
      },
    });
  });

  test("an internal note the reply quotes is named", () => {
    const rows = draftSources(
      cited(
        verdict({
          internalQuoted: { path: "articles/ops.md", title: "Ops" },
        }),
        [],
      ),
      "acme",
    );
    expect(rows).toEqual([
      {
        kind: "knowledge",
        label: "knowledge:articles/ops.md",
        href: "/settings/projects/acme/knowledge/articles/articles%2Fops.md",
        knowledge: {
          title: "Ops",
          state: "blocked",
          reason: "The reply quotes an internal note",
          uncited: true,
        },
      },
    ]);
  });

  test("a cited note the reply quotes holds the draft on its own row", () => {
    const rows = draftSources(
      cited(
        verdict({
          backing: [{ kind: "knowledge", ref: EXPORT, title: "Export" }],
          internalQuoted: { path: "articles/export.md", title: "Export" },
        }),
      ),
      "acme",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.knowledge).toEqual({
      title: "Export",
      state: "blocked",
      reason: "The reply quotes an internal note",
    });
  });

  test("a check that failed leaves every citation unchecked", () => {
    const rows = draftSources(cited(verdict({ failed: true })), "acme");
    expect(rows[0]?.knowledge).toEqual({
      title: "articles/export.md",
      state: "unchecked",
      reason: "Knowledge couldn't be checked",
    });
  });

  test("each state reads as a word and a dot", () => {
    const chip = (state: "backing" | "blocked" | "unchecked") =>
      knowledgeChip({ title: "Export", state, reason: null });
    expect(chip("backing")).toEqual({ label: "Fresh", dot: "var(--green)" });
    expect(chip("blocked")).toEqual({
      label: "Out of date",
      dot: "var(--yellow)",
    });
    expect(chip("unchecked")).toEqual({
      label: "Not checked",
      dot: "var(--text-faint)",
    });
  });

  test("a citation that doesn't parse reads as written and links nowhere", () => {
    expect(draftSources(cited(undefined, ["notes/x.md"]), "acme")).toEqual([
      { kind: "knowledge", label: "notes/x.md", href: null },
    ]);
  });
});

describe("fixed note", () => {
  const note = (draftId: string | null) => ({
    at: "2026-10-25T11:00:00.000Z",
    because: "pr-merged" as const,
    url: "https://github.example.test/acme/acme/pull/7",
    text: "It's fixed now",
    draftId,
  });
  test("a fixed note in the reply box sends as one", () => {
    const d = draft("needs-person", { purpose: "fixed-note" });
    expect(draftSendLabel({ kind: "review", draft: d })).toBe(
      "Send fixed note",
    );
    expect(draftHeader({ kind: "review", draft: d }, 0)).toBe(
      "Fixed note · Draft: a person sends",
    );
    expect(
      draftSendLabel({ kind: "review", draft: draft("needs-person") }),
    ).toBe("Send");
    expect(draftSendLabel({ kind: "failed", draft: d })).toBe("Try again");
  });
  test("a note outside the reply box waits until a reply goes out", () => {
    expect(waitingFixedNote(conversation({ fixedNote: note("sd_9") }))).toBe(
      null,
    );
    const waiting = conversation({ fixedNote: note(null) });
    expect(waitingFixedNote(waiting)?.text).toBe("It's fixed now");
    const answered = conversation({
      fixedNote: note(null),
      messages: [
        message(),
        message({
          id: "sm_2",
          direction: "out",
          at: "2026-10-25T11:05:00.000Z",
        }),
      ],
    });
    expect(waitingFixedNote(answered)).toBe(null);
  });
});

describe("quiet events", () => {
  test("Sessions closing a conversation on its own is a quiet line", () => {
    const c = conversation({
      events: [
        {
          at: "2026-10-25T10:05:00.000Z",
          kind: "closed",
          actor: { kind: "sessions" },
          detail: "The customer only said thanks. Closed without a reply",
        },
        {
          at: "2026-10-25T10:06:00.000Z",
          kind: "closed",
          actor: { kind: "person", name: "Ada" },
          detail: "Ada closed this",
        },
      ],
    });
    const [, quiet, person] = timelineEntries(c);
    expect(quiet?.quiet).toBe(true);
    expect(quiet?.text).toBe(
      "The customer only said thanks. Closed without a reply",
    );
    expect(person?.quiet).toBeUndefined();
  });
});

describe("sendingDiscardable", () => {
  const now = Date.parse(AT) + 10 * 60_000;
  test("a send waiting for its retry can be discarded", () => {
    expect(
      sendingDiscardable(
        draft("sending", {
          attemptStartedAt: new Date(now - 1000).toISOString(),
          nextAttemptAt: new Date(now + 60_000).toISOString(),
        }),
        now,
      ),
    ).toBe(true);
  });
  test("a send cut off over two minutes ago can be discarded", () => {
    const at = (ms: number) =>
      draft("sending", { attemptStartedAt: new Date(now - ms).toISOString() });
    expect(sendingDiscardable(at(121_000), now)).toBe(true);
    expect(sendingDiscardable(at(30_000), now)).toBe(false);
  });
});
