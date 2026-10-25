import { expect, test } from "bun:test";
import { DECISION_COPY } from "../../../shared/incident-decision-copy";
import { intentPlan } from "./intent";
import type { CardButton, NextCard } from "./next-action";

const shell = (buttons: Array<Partial<CardButton>>): NextCard => ({
  mode: "shell",
  tone: "red",
  pulse: false,
  eyebrow: "e",
  headline: "h",
  body: "",
  buttons: buttons.map((b, i) => ({
    key: `b${i}`,
    kind: "decision",
    label: "x",
    weight: "soft",
    ...b,
  })),
});

test("the lock-screen Stop and Deploy now open their confirms", () => {
  const veto = shell([
    { kind: "deploy-now", decision: "deploy-now" },
    { kind: "stop", decision: "stop", weight: "danger" },
  ]);
  expect(intentPlan(veto, "stop", "deploys 12:37")).toEqual({
    kind: "confirm",
    decision: "stop",
    title: "Stop the deploy?",
    description: "Nothing ships and the incident waits for you",
    confirmLabel: "Stop",
  });
  expect(intentPlan(veto, "deploy-now", "deploys 12:37")).toMatchObject({
    kind: "confirm",
    confirmLabel: "Deploy now",
  });
});

test("a veto that runs a rollback confirms in rollback words", () => {
  const veto = shell([
    { kind: "deploy-now", decision: "deploy-now" },
    { kind: "stop", decision: "stop", weight: "danger" },
  ]);
  expect(
    intentPlan(veto, "stop", "rolls back 12:37", { rollback: true }),
  ).toEqual({
    kind: "confirm",
    decision: "stop",
    title: "Stop the rollback?",
    description: "Nothing is rolled back and the incident waits for you",
    confirmLabel: "Stop",
  });
  expect(
    intentPlan(veto, "deploy-now", "rolls back 12:37", { rollback: true }),
  ).toEqual({
    kind: "confirm",
    decision: "deploy-now",
    title: "Roll back now?",
    description: "The rollback runs without the rest of the veto window",
    confirmLabel: "Roll back now",
  });
});

test("a needs-you top option confirms with the page's own words", () => {
  expect(
    intentPlan(
      shell([{ decision: "approve", weight: "primary" }, { decision: "stop" }]),
      "approve",
      "needs you",
    ),
  ).toEqual({
    kind: "confirm",
    decision: "approve",
    title: "Deploy the fix?",
    description: DECISION_COPY.approve.description,
    confirmLabel: "Deploy the fix",
  });
  const choice: NextCard = {
    mode: "choice",
    eyebrow: "Needs you",
    decisions: ["retry", "close"],
    question: {
      header: "Needs you",
      question: "q",
      multiSelect: false,
      options: [DECISION_COPY.retry, DECISION_COPY.close],
    },
    notes: {},
    picks: {},
    freeText: null,
  };
  expect(intentPlan(choice, "retry", "needs you")).toMatchObject({
    kind: "confirm",
    title: "Try again?",
  });
});

test("Send it back from a notification points at the card's note field", () => {
  const choice: NextCard = {
    mode: "choice",
    eyebrow: "Needs you",
    decisions: ["send-back", "close"],
    question: {
      header: "Needs you",
      question: "q",
      multiSelect: false,
      options: [DECISION_COPY["send-back"], DECISION_COPY.close],
    },
    notes: {},
    picks: {},
    freeText: null,
  };
  expect(intentPlan(choice, "send-back", "needs you")).toEqual({
    kind: "on-card",
    message: "Pick Send it back on the card and write the investigator a note",
  });
});

test("an old banner says what happened instead", () => {
  expect(intentPlan(null, "stop", "watching")).toEqual({
    kind: "stale",
    message: "Nothing to stop: watching",
  });
  expect(intentPlan(shell([]), "deploy-now", "fixed")).toEqual({
    kind: "stale",
    message: "Nothing to deploy: fixed",
  });
  expect(
    intentPlan(shell([{ decision: "retry" }]), "approve", "round 3"),
  ).toEqual({
    kind: "stale",
    message: "Already handled: round 3",
  });
});
