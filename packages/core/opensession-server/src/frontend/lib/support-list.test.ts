import { describe, expect, test } from "bun:test";
import type { SupportListItem } from "../../shared/support";
import {
  filterByChannel,
  liveSessionFor,
  supportItemRoute,
  supportLanes,
  supportPageItem,
} from "./support-list";
import type { UnifiedSession } from "./types";

function item(
  over: Partial<SupportListItem> & { id: string },
): SupportListItem {
  const channel = over.id.slice(0, over.id.indexOf(":"));
  return {
    channel,
    title: "Subject",
    preview: "",
    customer: { name: null, email: "ada@example.test" },
    priority: null,
    status: "open",
    at: "2026-10-25T09:00:00.000Z",
    inbox: null,
    project: null,
    draftState: null,
    vetoDeadline: null,
    sessionId: null,
    ...over,
  };
}

// SAFETY: liveSessionFor reads only id, archived, plainThreadId and
// lastActivity, which every fixture sets.
const session = (over: Partial<UnifiedSession>): UnifiedSession =>
  ({
    id: "s_1",
    archived: false,
    lastActivity: "2026-10-25T08:00:00.000Z",
    ...over,
  }) as UnifiedSession;

describe("supportLanes", () => {
  test("needs you comes first, above an urgent Plain item", () => {
    const lanes = supportLanes([
      item({ id: "plain:th_1", priority: 0 }),
      item({ id: "email:sc_1", draftState: "needs-person" }),
      item({ id: "email:sc_2" }),
      item({ id: "plain:th_2", priority: 2 }),
    ]);
    expect(lanes.map((l) => [l.key, l.items.map((i) => i.id)])).toEqual([
      ["needs-you", ["email:sc_1"]],
      [0, ["plain:th_1"]],
      [2, ["email:sc_2", "plain:th_2"]],
    ]);
    expect(lanes[0]!.label).toBe("Needs you");
  });

  test("veto and failed drafts need you too; sent ones do not", () => {
    const lanes = supportLanes([
      item({ id: "email:sc_1", draftState: "veto" }),
      item({ id: "email:sc_2", draftState: "failed" }),
      item({ id: "email:sc_3", draftState: "sent" }),
    ]);
    expect(lanes.map((l) => [l.key, l.items.map((i) => i.id)])).toEqual([
      ["needs-you", ["email:sc_1", "email:sc_2"]],
      [2, ["email:sc_3"]],
    ]);
  });

  test("newest first within a lane, across channels", () => {
    const lanes = supportLanes([
      item({ id: "email:sc_1", at: "2026-10-25T08:00:00.000Z" }),
      item({ id: "plain:th_1", priority: 2, at: "2026-10-25T10:00:00.000Z" }),
      item({ id: "email:sc_2", at: null }),
    ]);
    expect(lanes[0]!.items.map((i) => i.id)).toEqual([
      "plain:th_1",
      "email:sc_1",
      "email:sc_2",
    ]);
  });

  test("no items, no lanes", () => {
    expect(supportLanes([])).toEqual([]);
  });
});

test("filterByChannel", () => {
  const items = [item({ id: "email:sc_1" }), item({ id: "plain:th_1" })];
  expect(filterByChannel(items, "email").map((i) => i.id)).toEqual([
    "email:sc_1",
  ]);
  expect(filterByChannel(items, "all")).toEqual(items);
});

describe("liveSessionFor", () => {
  test("email: the conversation's session, unless archived", () => {
    const email = item({ id: "email:sc_1", sessionId: "s_2" });
    expect(
      liveSessionFor(email, [session({ id: "s_1" }), session({ id: "s_2" })])
        ?.id,
    ).toBe("s_2");
    expect(
      liveSessionFor(email, [session({ id: "s_2", archived: true })]),
    ).toBeNull();
    expect(
      liveSessionFor(item({ id: "email:sc_2" }), [session({})]),
    ).toBeNull();
  });

  test("plain: the newest live session on the thread", () => {
    const plain = item({ id: "plain:th_1" });
    expect(
      liveSessionFor(plain, [
        session({
          id: "s_1",
          plainThreadId: "th_1",
          lastActivity: "2026-10-25T01:00:00.000Z",
        }),
        session({
          id: "s_2",
          plainThreadId: "th_1",
          lastActivity: "2026-10-25T03:00:00.000Z",
        }),
        session({
          id: "s_3",
          plainThreadId: "th_1",
          lastActivity: "2026-10-25T09:00:00.000Z",
          archived: true,
        }),
        session({
          id: "s_4",
          plainThreadId: "th_2",
          lastActivity: "2026-10-25T09:00:00.000Z",
        }),
      ])?.id,
    ).toBe("s_2");
  });
});

test("supportItemRoute: Plain items keep their page, email items open under /support", () => {
  expect(supportItemRoute("plain:th_1")).toEqual({
    view: "plain",
    threadId: "th_1",
  });
  expect(supportItemRoute("email:sc_1")).toEqual({
    view: "support",
    threadId: "email:sc_1",
  });
});

test("supportPageItem: which routes are the Support page, and what is open", () => {
  expect(supportPageItem({ view: "plain" })).toBeNull();
  expect(supportPageItem({ view: "plain", threadId: "th_1" })).toBe(
    "plain:th_1",
  );
  expect(supportPageItem({ view: "support", threadId: "email:sc_1" })).toBe(
    "email:sc_1",
  );
  // A Plain ticket's /support link opens its workspace instead.
  expect(
    supportPageItem({ view: "support", threadId: "plain:th_1" }),
  ).toBeUndefined();
  expect(
    supportPageItem({ view: "support", threadId: "th_1" }),
  ).toBeUndefined();
  expect(supportPageItem({ view: "prs" })).toBeUndefined();
});
