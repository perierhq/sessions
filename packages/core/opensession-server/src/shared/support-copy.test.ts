import { expect, test } from "bun:test";
import { AUTONOMY_LEVELS } from "./incident-response";
import { BUG_HANDLING, MAILBOX_BEHAVIOURS, SUPPORT_TOPICS } from "./support";
import * as copy from "./support-copy";
import {
  BUG_HANDLING_COPY,
  MAILBOX_BEHAVIOUR_COPY,
  SUPPORT_AUTONOMY_COPY,
  SUPPORT_PUSH,
  SUPPORT_TOPIC_LABELS,
} from "./support-copy";

test("every autonomy level has a label and a description", () => {
  for (const level of AUTONOMY_LEVELS) {
    expect(SUPPORT_AUTONOMY_COPY[level].label.length).toBeGreaterThan(0);
    expect(SUPPORT_AUTONOMY_COPY[level].description.length).toBeGreaterThan(0);
  }
  expect(SUPPORT_AUTONOMY_COPY.propose.label).toBe("Draft");
  expect(SUPPORT_AUTONOMY_COPY.watch.label).toBe("Watch only");
});

test("every topic, mailbox behaviour and bug handling has copy", () => {
  for (const topic of SUPPORT_TOPICS)
    expect(SUPPORT_TOPIC_LABELS[topic].length).toBeGreaterThan(0);
  for (const behaviour of MAILBOX_BEHAVIOURS)
    expect(MAILBOX_BEHAVIOUR_COPY[behaviour].length).toBeGreaterThan(0);
  for (const handling of BUG_HANDLING)
    expect(BUG_HANDLING_COPY[handling].length).toBeGreaterThan(0);
});

test("the veto push names only the clock", () => {
  expect(SUPPORT_PUSH.vetoBody("14:05")).toBe(
    "Sends at 14:05 unless you stop it",
  );
});

test("no string in the module contains an em dash", () => {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "function") strings.push(String(value("0:00")));
    else if (value && typeof value === "object")
      for (const child of Object.values(value)) walk(child);
  };
  walk(copy);
  expect(strings.length).toBeGreaterThan(10);
  for (const text of strings) expect(text).not.toContain("\u2014");
});
