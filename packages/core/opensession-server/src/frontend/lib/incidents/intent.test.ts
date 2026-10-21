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
  };
  expect(intentPlan(choice, "retry", "needs you")).toMatchObject({
    kind: "confirm",
    title: "Try again?",
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
