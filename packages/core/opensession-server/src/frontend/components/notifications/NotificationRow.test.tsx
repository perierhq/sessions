// NotificationRow reaches lib/notifications, whose imports touch
// localStorage, fetch, window and document at module load. There is no DOM
// preload in this repo, so the shims go here, file-locally, and the import is
// dynamic to land after them.

import { beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotificationThread } from "../../lib/api/notifications";
import {
  INBOX_KIND_ICON_INK,
  INBOX_ROW_NEXT,
  INBOX_ROW_REASON,
} from "../../lib/inbox-classes";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  window: {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  },
  document: {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
    hasFocus: () => true,
  },
  Event: class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
  fetch: () => Promise.reject(new Error("offline in tests")),
});

let NotificationRow: typeof import("./NotificationRow").NotificationRow;

beforeAll(async () => {
  NotificationRow = (await import("./NotificationRow")).NotificationRow;
});

const incidentThread = (
  over: Partial<NotificationThread> = {},
): NotificationThread => ({
  id: "incident:inc-1",
  subject: { type: "incident", id: "inc-1", title: "Search", context: "acme" },
  kind: "incident_veto",
  reason: "Search is down",
  body: "The fix is verified and deploys at 12:37 unless you stop it",
  url: "/incidents/inc-1",
  updatedAt: 1_000,
  unread: true,
  done: false,
  ...over,
});

test("an incident row says the state and what happens next", () => {
  const html = renderToStaticMarkup(
    <NotificationRow thread={incidentThread()} />,
  );
  expect(html).toContain("acme");
  expect(html).toContain("Search is down");
  expect(html).toContain(
    "The fix is verified and deploys at 12:37 unless you stop it",
  );
  expect(html).toContain(
    'aria-label="Unread. Search is down. The fix is verified and deploys at 12:37 unless you stop it"',
  );
  expect(html).toContain(INBOX_KIND_ICON_INK.incident_veto);
  // The next step wraps rather than losing "unless you stop it".
  expect(html).toContain(INBOX_ROW_NEXT);
});

test("every incident kind has a tone", () => {
  expect(INBOX_KIND_ICON_INK.incident_opened).toBe("text-red");
  expect(INBOX_KIND_ICON_INK.incident_rolled_back).toBe("text-red");
  expect(INBOX_KIND_ICON_INK.incident_heads_up).toBe("text-yellow");
  expect(INBOX_KIND_ICON_INK.incident_veto).toBe("text-yellow");
  expect(INBOX_KIND_ICON_INK.incident_needs_you).toBe("text-accent");
  expect(INBOX_KIND_ICON_INK.incident_resolved).toBe("text-green");
  expect(INBOX_KIND_ICON_INK.incident_update).toBe("text-dim");
});

test("other rows are unchanged", () => {
  const html = renderToStaticMarkup(
    <NotificationRow
      thread={{
        ...incidentThread(),
        id: "session:s1",
        kind: "mention",
        subject: { type: "session", id: "s1", title: "Fix login" },
        reason: "Ada mentioned you",
        body: "look",
      }}
    />,
  );
  expect(html).toContain("Fix login");
  expect(html).toContain("Ada mentioned you: look");
  expect(html).toContain(INBOX_ROW_REASON);
  expect(html).not.toContain(INBOX_ROW_NEXT);
  expect(html).toContain(
    'aria-label="Unread. Fix login. Ada mentioned you: look"',
  );
});
