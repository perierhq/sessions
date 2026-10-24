import { expect, test } from "bun:test";
import { DEFAULT_BUDGET } from "../../shared/incident-response";
import {
  documentInvariantProblem,
  loosenedFields,
  validateAction,
  validateActionList,
  validatePolicyFields,
} from "./validate";
import { defaultProjectDocument } from "../../shared/project-settings";

const deploy = {
  id: "deploy",
  kind: "deploy",
  label: "Deploy",
  runner: "runner-prod",
  command: "./deploy.sh {{ref}}",
};
const current = { budget: { ...DEFAULT_BUDGET } };

test.each([
  [{ autonomy: "yolo" }, "autonomy"],
  [{ vetoMs: 5_000 }, "vetoMs"],
  [{ night: { start: "23:00", end: "23:00", timeZone: "UTC" } }, "night"],
  [
    { night: { start: "23:00", end: "07:00", timeZone: "Mars/Olympus" } },
    "night",
  ],
  [{ budget: { perIncidentUsd: 50, perMonthUsd: 20 } }, "perMonthUsd"],
  [{ neverWithoutYou: ["migration", "migration"] }, "neverWithoutYou"],
])("rejects policy %j", (input, message) => {
  expect(validatePolicyFields(input, current)).toEqual({
    error: expect.stringContaining(message),
  });
});

test.each([
  [
    [{ ...deploy, command: "./deploy.sh {{branch}}" }],
    "Unknown placeholder {{branch}}",
  ],
  [
    [deploy, { ...deploy, id: "deploy-2" }],
    "Only one deploy action per project",
  ],
  [[{ ...deploy, scope: { paths: ["src/["] } }], "scope"],
])("rejects actions %j", (list, message) => {
  expect(validateActionList(list, ["runner-prod"])).toEqual({
    error: expect.stringContaining(message),
  });
});

test("actions must run on a production Runner", () => {
  expect(validateActionList([deploy], [])).toEqual({
    error: expect.stringContaining(
      "Pick one of the project's production Runners",
    ),
  });
});

test("validateAction", () => {
  expect(
    validateAction({ ...deploy, cwd: "relative" }, ["runner-prod"]),
  ).toEqual({ error: expect.stringContaining("cwd") });
  expect(validateAction({ ...deploy, id: "Deploy!" }, ["runner-prod"])).toEqual(
    { error: expect.stringContaining("id") },
  );
  expect(
    validateAction({ ...deploy, cost: { kind: "amount", usd: 0 } }, [
      "runner-prod",
    ]),
  ).toEqual({
    error: expect.stringContaining("cost"),
  });
  expect(
    validateAction(
      {
        ...deploy,
        cost: { kind: "amount", usd: 5 },
        needsSecret: true,
        reversible: false,
      },
      ["runner-prod"],
    ),
  ).toMatchObject({
    cost: { kind: "amount", usd: 5 },
    needsSecret: true,
    reversible: false,
  });
});

test("placeholders cannot sit inside quotes", () => {
  for (const command of [
    "./deploy.sh '{{ref}}'",
    './deploy.sh "v-{{ref}}"',
    "echo 'a' \"{{project}}\"",
  ])
    expect(validateAction({ ...deploy, command }, ["runner-prod"])).toEqual({
      error:
        "Placeholders cannot be inside quotes: Sessions quotes their values",
    });
  expect(
    validateAction({ ...deploy, command: "echo 'x' {{ref}} \\'" }, [
      "runner-prod",
    ]),
  ).toMatchObject({ id: "deploy" });
});

test("loosening is judged on the policy fields alone", () => {
  const before = defaultProjectDocument("acme-web", "t").incidents;
  expect(
    loosenedFields(before, {
      ...before,
      budget: { ...before.budget, perIncidentUsd: 40 },
    }),
  ).toEqual(["budget"]);
  expect(
    loosenedFields(before, {
      ...before,
      budget: { ...before.budget, perIncidentUsd: 5 },
    }),
  ).toEqual([]);
});

test("a document keeps its whole-record rules", () => {
  const doc = defaultProjectDocument("acme-web", "t");
  expect(documentInvariantProblem(doc)).toBeNull();
  expect(
    documentInvariantProblem({
      ...doc,
      models: {
        investigator: "pi/anthropic/claude-opus-5-5",
        verifier: "pi/openrouter/anthropic/claude-opus-5-5",
      },
    }),
  ).toBe("Pick a different model for the verifier");
});

test("an incident agent's egress is a route or off", () => {
  const doc = defaultProjectDocument("acme-web", "2026-10-01T00:00:00Z");
  doc.access.routes.verifier = null;
  expect(documentInvariantProblem(doc)).toBeNull();
  doc.access.routes.investigator = { route: "runner" } as never;
  expect(documentInvariantProblem(doc)).toBe(
    "Egress for the investigator: a Runner route needs the Runner",
  );
  doc.access.routes.investigator = { route: "anywhere" } as never;
  expect(documentInvariantProblem(doc)).toBe(
    'Egress for the investigator: unknown route "anywhere"',
  );
});
