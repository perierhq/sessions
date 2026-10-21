import { expect, test } from "bun:test";
import {
  actorName,
  clockLabel,
  COPY,
  decisionLabel,
  deployingBody,
  firstLine,
  incidentHeadline,
  reopenedTitle,
  resolvedBody,
  vetoBody,
  vetoLabels,
} from "./notify-copy";

test("headlines never say down for a heads-up", () => {
  expect(incidentHeadline("Search", "investigating", "failing")).toBe(
    "Search is down",
  );
  expect(incidentHeadline("Search", "veto", "slow")).toBe("Search is slow");
  expect(incidentHeadline("Search", "heads-up", "flaky")).toBe(
    "Search is failing on and off",
  );
  expect(incidentHeadline("Search", "heads-up", "upcoming")).toBe(
    "Search needs attention soon",
  );
  expect(incidentHeadline("Search", "heads-up", "failing")).toBe(
    "Search needs attention soon",
  );
  expect(incidentHeadline("Search", "investigating", "external")).toBe(
    "Search is down at the provider",
  );
  expect(incidentHeadline("Search", "waiting-on-provider", "failing")).toBe(
    "Search is down at the provider",
  );
  expect(incidentHeadline("Search", "investigating", "flaky")).toBe(
    "Search is failing on and off",
  );
  expect(incidentHeadline("Search", "watching", "ok")).toBe(
    "Search has an open incident",
  );
  expect(incidentHeadline("Search", "investigating", null)).toBe(
    "Search has an open incident",
  );
  expect(reopenedTitle("Search", "failing")).toBe("Search is failing again");
  expect(reopenedTitle("Search", "slow")).toBe("Search is slow again");
  expect(reopenedTitle("Search", null)).toBe("Search has a problem again");
});

test("the lock-screen veto line", () => {
  const clock = clockLabel("2026-10-20T10:37:00.000Z", "Europe/Warsaw");
  expect(clock).toBe("12:37");
  expect(clockLabel("2026-10-20T10:37:00.000Z", "Not/AZone")).toBe("10:37");
  expect(clockLabel("2026-10-20T22:05:00.000Z", "UTC")).toBe("22:05");
  expect(vetoBody({ kind: "deploy" }, clock)).toBe(
    "The fix is verified and deploys at 12:37 unless you stop it",
  );
  expect(vetoBody({ kind: "rollback" }, clock)).toBe(
    "Rolls back to the last release at 12:37 unless you stop it",
  );
  expect(vetoBody({ kind: "action", label: "Pause the worker" }, clock)).toBe(
    "Pause the worker at 12:37 unless you stop it",
  );
  expect(vetoLabels({ kind: "deploy" })).toEqual({
    stop: "Stop the deploy",
    now: "Deploy now",
  });
  expect(vetoLabels({ kind: "rollback" })).toEqual({
    stop: "Stop the rollback",
    now: "Roll back now",
  });
  expect(vetoLabels({ kind: "action", label: "Pause the worker" })).toEqual({
    stop: "Stop",
    now: "Run now",
  });
  expect(deployingBody({ kind: "deploy" })).toBe("Deploying the fix now");
  expect(deployingBody({ kind: "rollback" })).toBe("Rolling back now");
  expect(deployingBody(null)).toBe("Running the action now");
});

test("resolved, decisions, actors, lines", () => {
  expect(resolvedBody("agents", "Ada")).toBe(
    "Fixed by agents and verified in production",
  );
  expect(resolvedBody("agents-with-you", "Ada")).toBe(
    "Fixed with you and verified in production",
  );
  expect(resolvedBody("provider-recovered", "Ada")).toBe(
    "The provider recovered",
  );
  expect(resolvedBody(undefined, "Ada")).toBe("Closed");
  expect(resolvedBody("by-hand", actorName("ada", "Ada"))).toBe(
    "You closed it as fixed",
  );
  expect(resolvedBody("by-hand", actorName("Bo", "Ada"))).toBe(
    "Bo closed it as fixed",
  );
  expect(decisionLabel("approve", null)).toBe("Deploy the fix");
  expect(decisionLabel("retry", null)).toBe("Try again");
  expect(decisionLabel("roll-back", null)).toBe("Roll back");
  expect(decisionLabel("stop", { kind: "rollback" })).toBe("Stop the rollback");
  expect(decisionLabel("stop", null)).toBe("Stop the deploy");
  expect(decisionLabel("deploy-now", { kind: "rollback" })).toBe(
    "Roll back now",
  );
  expect(firstLine("Raise today's budget?\nIt is at $20")).toBe(
    "Raise today's budget?",
  );
  expect(firstLine("x".repeat(200))).toHaveLength(120);
  expect(firstLine("x".repeat(200)).endsWith("…")).toBe(true);
});

test("no copy uses an em dash or ends with a period", () => {
  for (const text of Object.values(COPY)) {
    expect(text).not.toContain("—");
    expect(text.endsWith(".")).toBe(false);
  }
});
