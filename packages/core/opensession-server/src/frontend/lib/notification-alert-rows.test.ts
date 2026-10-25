import { expect, test } from "bun:test";
import { DEFAULT_NOTIFICATION_ALERTS } from "./api/notifications";
import { NOTIFICATION_ALERT_ROWS } from "./notification-alert-rows";

test("one row per alert switch, incidents then support last", () => {
  expect(NOTIFICATION_ALERT_ROWS.map((r) => r.group)).toEqual([
    "reviews",
    "teamReviews",
    "mentions",
    "collaborators",
    "reminders",
    "incidents",
    "support",
  ]);
  expect(NOTIFICATION_ALERT_ROWS.map((r): string => r.group).sort()).toEqual(
    Object.keys(DEFAULT_NOTIFICATION_ALERTS).sort(),
  );
  expect(NOTIFICATION_ALERT_ROWS.at(-1)).toEqual({
    group: "support",
    title: "Support replies that need you",
    desc: "A support reply waits for you, is about to send, or could not send",
  });
  expect(NOTIFICATION_ALERT_ROWS.at(-2)).toEqual({
    group: "incidents",
    title: "Incidents",
    desc: "An incident you own opens, needs you, is about to deploy, rolls back or is fixed. At night only what can't wait",
  });
});
