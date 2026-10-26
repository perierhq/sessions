import { expect, test } from "bun:test";
import {
  MAILBOX_BEHAVIOURS,
  SUPPORT_AUTONOMY,
  SUPPORT_TOPICS,
} from "./support";
import * as copy from "./support-copy";
import {
  MAILBOX_BEHAVIOUR_COPY,
  SUPPORT_AUTONOMY_COPY,
  SUPPORT_PUSH,
  SUPPORT_TOPIC_LABELS,
} from "./support-copy";

test("every autonomy level has a label and a description", () => {
  for (const level of SUPPORT_AUTONOMY) {
    expect(SUPPORT_AUTONOMY_COPY[level].label.length).toBeGreaterThan(0);
    expect(SUPPORT_AUTONOMY_COPY[level].description.length).toBeGreaterThan(0);
  }
  expect(SUPPORT_AUTONOMY_COPY).toEqual({
    watch: {
      label: "Watch",
      description: "Sessions sorts new mail. No agent and no drafts",
    },
    draft: {
      label: "Draft",
      description: "The agent drafts every reply. Nothing sends until you do",
    },
    routine: {
      label: "Routine",
      description:
        "Repetitive replies backed by a source send on their own. Everything that needs judgement waits for you",
    },
  });
});

test("no copy uses a semicolon", () => {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "function") strings.push(String(value("x")));
    else if (value && typeof value === "object")
      for (const v of Object.values(value)) walk(v);
  };
  walk(copy);
  for (const text of strings) expect(text).not.toContain(";");
});

test("every topic and mailbox behaviour has copy", () => {
  for (const topic of SUPPORT_TOPICS)
    expect(SUPPORT_TOPIC_LABELS[topic].length).toBeGreaterThan(0);
  for (const behaviour of MAILBOX_BEHAVIOURS)
    expect(MAILBOX_BEHAVIOUR_COPY[behaviour].length).toBeGreaterThan(0);
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
