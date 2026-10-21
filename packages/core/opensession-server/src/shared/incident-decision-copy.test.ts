import { expect, test } from "bun:test";
import { DECISION_COPY, parseIncidentIntent } from "./incident-decision-copy";
import { OWNER_DECISIONS } from "./incident-response";

test("every owner decision has a label and a description", () => {
  for (const decision of OWNER_DECISIONS) {
    expect(DECISION_COPY[decision].label.length).toBeGreaterThan(0);
    expect(DECISION_COPY[decision].description.length).toBeGreaterThan(0);
  }
  expect(Object.keys(DECISION_COPY).sort()).toEqual(
    [...OWNER_DECISIONS].sort(),
  );
  expect(DECISION_COPY["roll-back"].label).toBe("Roll back");
  expect(DECISION_COPY.stop).toEqual({
    label: "Stop",
    description: "Nothing ships; the incident waits for you",
  });
});

test("copy follows the UI rules", () => {
  for (const { label, description } of Object.values(DECISION_COPY)) {
    expect(label).not.toMatch(/[.…—]$/);
    expect(description).not.toMatch(/[.—]$/);
    expect(description).not.toContain("—");
  }
});

test("push intents parse to owner decisions only", () => {
  expect(parseIncidentIntent("deploy-now")).toBe("deploy-now");
  expect(parseIncidentIntent("roll-back")).toBe("roll-back");
  expect(parseIncidentIntent("rm")).toBeUndefined();
  expect(parseIncidentIntent("")).toBeUndefined();
  expect(parseIncidentIntent(null)).toBeUndefined();
  expect(parseIncidentIntent(undefined)).toBeUndefined();
  expect(parseIncidentIntent("toString")).toBeUndefined();
});
