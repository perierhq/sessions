/**
 * The supervisor's briefing trim: only the newest block of each per-turn
 * briefing kind reaches the model, older ones become a fixed one-line stub,
 * the owner's answers survive, and the request prefix changes only when a
 * turn's prompt adds a newer briefing.
 */
import { describe, expect, test } from "bun:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { wrapContext } from "./prompt-context";
import {
  STALE_BRIEFING_NOTE,
  STUBBED_BRIEFING_SOURCES,
  stubStaleBriefings,
  supervisorBriefingTrimExtension,
} from "./supervisor-briefing-trim";
import {
  FIXTURE_TURNS,
  fixtureConversation,
  type FixtureMessage,
} from "./testing/supervisor-conversation-fixture";

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

function textOf(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
}

function tokens(messages: FixtureMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum + estimateTokens(message as Parameters<typeof estimateTokens>[0]),
    0,
  );
}

describe("stubStaleBriefings", () => {
  test("keeps the newest block of each kind and stubs the older ones", () => {
    const first = user(
      `${wrapContext("state one", "desk-state")}\n\n${wrapContext("clock one", "supervisor-clock")}\n\nhi`,
    );
    const second = user(
      `${wrapContext("state two", "desk-state")}\n\nand now?`,
    );
    const out = stubStaleBriefings([first, second]);
    expect(textOf(out[0]!)).toBe(
      `${wrapContext(STALE_BRIEFING_NOTE, "desk-state")}\n\n${wrapContext("clock one", "supervisor-clock")}\n\nhi`,
    );
    // The newest of each kind is untouched, and so is the turn holding it.
    expect(out[1]).toBe(second);
    // The input is not modified.
    expect(textOf(first)).toContain("state one");
  });

  test("leaves the seed, memory and the owner's own words alone", () => {
    const first = user(
      `${wrapContext("ledger facts", "supervisor-seed")}\n\n${wrapContext("recalled", "memory")}\n\n${wrapContext("state", "desk-state")}\n\nmerge #10`,
    );
    const second = user(`${wrapContext("state 2", "desk-state")}\n\nok`);
    const text = textOf(stubStaleBriefings([first, second])[0]!);
    expect(text).toContain("ledger facts");
    expect(text).toContain("recalled");
    expect(text).toContain("merge #10");
    expect(text).not.toContain(
      '<opensession:context source="desk-state">\nstate\n',
    );
  });

  test("a stubbed inbox keeps the owner's answers", () => {
    const old = wrapContext(
      [
        "## Your inbox",
        'Answered since your last turn:\n- [item-1] Ship it? (acme, lead): "yes"',
        "Waiting on the owner:\n- [item-2] Hold the release?",
      ].join("\n\n"),
      "supervisor-inbox",
    );
    const out = stubStaleBriefings([
      user(`${old}\n\nhi`),
      user(`${wrapContext("## Your inbox", "supervisor-inbox")}\n\nnext`),
    ]);
    const text = textOf(out[0]!);
    expect(text).toContain(STALE_BRIEFING_NOTE);
    expect(text).toContain('[item-1] Ship it? (acme, lead): "yes"');
    expect(text).not.toContain("Hold the release?");
  });

  test("handles string content and skips assistant and tool messages", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: wrapContext("quoted", "desk-state") }],
    };
    const out = stubStaleBriefings([
      { role: "user", content: `${wrapContext("a", "blob-surface")}\n\nx` },
      assistant,
      { role: "user", content: `${wrapContext("b", "blob-surface")}\n\ny` },
    ]);
    expect(out[0]!.content).toBe(
      `${wrapContext(STALE_BRIEFING_NOTE, "blob-surface")}\n\nx`,
    );
    expect(out[1]).toBe(assistant);
  });

  test("a turn without a newer block of a kind keeps the older one", () => {
    const owner = user(
      `${wrapContext("inbox", "supervisor-inbox")}\n\n${wrapContext("state", "desk-state")}\n\nhi`,
    );
    // A wake: live state, no inbox.
    const wake = user(`${wrapContext("state 2", "desk-state")}\n\nreport`);
    const text = textOf(stubStaleBriefings([owner, wake])[0]!);
    expect(text).toContain("inbox");
    expect(text).toContain(STALE_BRIEFING_NOTE);
  });

  test("the request prefix changes only when a new turn brings a newer briefing", () => {
    const conversation = fixtureConversation(5);
    // Every request of the last turn: its prompt, then each tool round.
    const lastTurnStart = 16;
    const requests = [17, 18, 19, 20].map((end) =>
      stubStaleBriefings(conversation.slice(0, end)),
    );
    for (const request of requests.slice(1))
      expect(JSON.stringify(request.slice(0, 17))).toBe(
        JSON.stringify(requests[0]),
      );
    // The turn before saw its own prompt in full; this turn stubs it once,
    // and the stubbed messages stay the same for later turns.
    const previous = stubStaleBriefings(conversation.slice(0, lastTurnStart));
    const now = requests[0]!;
    expect(JSON.stringify(now.slice(0, 12))).toBe(
      JSON.stringify(previous.slice(0, 12)),
    );
    expect(JSON.stringify(now[12])).not.toBe(JSON.stringify(previous[12]));
  });

  test("on a realistic conversation only the last turn keeps its briefings", () => {
    const conversation = fixtureConversation();
    const trimmed = stubStaleBriefings(conversation);
    const users = trimmed.filter((m) => m.role === "user");
    expect(users).toHaveLength(FIXTURE_TURNS);
    const stubs = users
      .map((m) => textOf(m).split(STALE_BRIEFING_NOTE).length - 1)
      .reduce((a, b) => a + b, 0);
    expect(stubs).toBe((FIXTURE_TURNS - 1) * STUBBED_BRIEFING_SOURCES.length);
    expect(textOf(users.at(-1)!)).not.toContain(STALE_BRIEFING_NOTE);
    // Answers from earlier turns are still there.
    expect(textOf(users[3]!)).toContain('"yes, ship it"');
    const before = tokens(conversation);
    const after = tokens(trimmed);
    expect(after).toBeLessThan(before * 0.7);
  });
});

describe("supervisorBriefingTrimExtension", () => {
  test("registers a context handler that returns the trimmed messages", async () => {
    let handler:
      | ((event: { type: "context"; messages: unknown[] }) => unknown)
      | undefined;
    const api = {
      on: (event: string, h: typeof handler) => {
        expect(event).toBe("context");
        handler = h;
      },
    };
    await supervisorBriefingTrimExtension(
      api as unknown as Parameters<typeof supervisorBriefingTrimExtension>[0],
    );
    const messages = [
      user(`${wrapContext("old", "desk-state")}\n\nhi`),
      user(`${wrapContext("new", "desk-state")}\n\nok`),
    ];
    const result = (await handler!({ type: "context", messages })) as {
      messages: typeof messages;
    };
    expect(textOf(result.messages[0]!)).toContain(STALE_BRIEFING_NOTE);
    expect(textOf(result.messages[1]!)).toContain("new");
  });
});
