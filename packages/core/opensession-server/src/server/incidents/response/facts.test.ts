import { expect, test } from "bun:test";
import type { IncidentAction } from "../../../shared/incident-response";
import { KNOWLEDGE_GLOB, changeFacts, globMatch } from "./facts";
import { defaultProjectSettings } from "./project-settings";

const action = (over: Partial<IncidentAction>): IncidentAction => ({
  id: "deploy",
  kind: "deploy",
  label: "Deploy",
  runner: "runner-prod",
  command: "./deploy.sh {{ref}}",
  timeoutMs: 600_000,
  reversible: true,
  cost: { kind: "none" },
  needsSecret: false,
  scope: { services: [], paths: [], migrationPaths: [] },
  ...over,
});
const settings = (actions: IncidentAction[]) => ({
  ...defaultProjectSettings("acme"),
  actions,
});
const deploy = action({
  scope: {
    services: ["web"],
    paths: ["src/**", "package.json"],
    migrationPaths: ["src/db/migrations/**"],
  },
});
const pause = action({
  id: "pause-worker",
  kind: "pause",
  label: "Pause worker",
});
const raise = action({
  id: "raise-budget",
  kind: "run-once",
  label: "Raise budget",
  reversible: false,
  cost: { kind: "amount", usd: 50 },
});

test("globs", () => {
  expect(KNOWLEDGE_GLOB).toBe("docs/incidents/**/*.md");
  expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
  expect(globMatch("src/**", "infra/main.tf")).toBe(false);
  expect(globMatch(KNOWLEDGE_GLOB, "docs/incidents/runbooks/search.md")).toBe(
    true,
  );
});
test("a code fix inside scope has no facts; the note never counts", () => {
  expect(
    changeFacts({
      plan: { pr: true, actions: [] },
      settings: settings([deploy]),
      prFiles: [
        "src/search.ts",
        "docs/incidents/2026-10-20-search.md",
        "docs/incidents/runbook.md",
      ],
    }),
  ).toMatchObject({ facts: new Set(), steps: [deploy] });
});
test("migration and outside scope", () => {
  const out = changeFacts({
    plan: { pr: true, actions: [] },
    settings: settings([deploy]),
    prFiles: ["src/db/migrations/0042.sql", "infra/main.tf"],
  });
  expect("error" in out ? null : [...out.facts].sort()).toEqual([
    "migration",
    "outside-scope",
  ]);
  expect("error" in out ? [] : out.details).toEqual([
    "src/db/migrations/0042.sql matches a migration path",
    "infra/main.tf is outside Deploy's scope",
  ]);
  const unread = changeFacts({
    plan: { pr: true, actions: [] },
    settings: settings([deploy]),
    prFiles: null,
  });
  expect("error" in unread ? null : [...unread.facts]).toEqual([
    "outside-scope",
  ]);
  expect("error" in unread ? null : unread.details).toEqual([
    "Could not read the PR's files",
  ]);
});
test("outside-scope names at most five files; empty paths mean anywhere", () => {
  const files = ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"];
  const out = changeFacts({
    plan: { pr: true, actions: [] },
    settings: settings([deploy]),
    prFiles: files,
  });
  expect("error" in out ? null : out.details).toHaveLength(5);
  const anywhere = changeFacts({
    plan: { pr: true, actions: [] },
    settings: settings([action({})]),
    prFiles: files,
  });
  expect("error" in anywhere ? null : [...anywhere.facts]).toEqual([]);
});
test("a spend spike: pausing is free and reversible, raising a budget costs money", () => {
  expect(
    changeFacts({
      plan: { pr: false, actions: ["pause-worker"] },
      settings: settings([pause]),
      prFiles: ["docs/incidents/x.md"],
    }),
  ).toMatchObject({ facts: new Set() });
  const raised = changeFacts({
    plan: { pr: false, actions: ["raise-budget"] },
    settings: settings([raise]),
    prFiles: [],
  });
  expect("error" in raised ? null : [...raised.facts].sort()).toEqual([
    "costs-money",
    "not-reversible",
  ]);
  const secret = changeFacts({
    plan: { pr: true, actions: ["pause-worker"] },
    settings: settings([action({ needsSecret: true }), pause]),
    prFiles: ["src/x.ts"],
  });
  expect("error" in secret ? null : secret.steps.map((s) => s.id)).toEqual([
    "deploy",
    "pause-worker",
  ]);
  expect("error" in secret ? null : [...secret.facts]).toEqual([
    "needs-secret",
  ]);
});
test("errors", () => {
  expect(
    changeFacts({
      plan: { pr: true, actions: [] },
      settings: settings([pause]),
      prFiles: [],
    }),
  ).toEqual({
    error: "No deploy action is declared for acme",
  });
  expect(
    changeFacts({
      plan: { pr: false, actions: ["nope"] },
      settings: settings([pause]),
      prFiles: [],
    }),
  ).toEqual({
    error: 'Unknown action "nope"',
  });
  expect(
    changeFacts({
      plan: { pr: false, actions: [] },
      settings: settings([pause]),
      prFiles: [],
    }),
  ).toEqual({
    error: "The candidate has nothing to run",
  });
  expect(
    changeFacts({
      plan: { pr: true, actions: ["deploy"] },
      settings: settings([deploy]),
      prFiles: [],
    }),
  ).toEqual({ error: "Deploy runs only with the PR" });
  expect(
    changeFacts({
      plan: { pr: false, actions: ["pause-worker", "pause-worker"] },
      settings: settings([pause]),
      prFiles: [],
    }),
  ).toEqual({ error: 'List each action once: "pause-worker"' });
});
test("only markdown under docs/incidents is knowledge; odd paths are refused", () => {
  const out = changeFacts({
    plan: { pr: true, actions: [] },
    settings: settings([deploy]),
    prFiles: ["docs/incidents/fix.sh"],
  });
  expect("error" in out ? out : [...out.facts]).toEqual(["outside-scope"]);
  for (const path of [
    "docs/incidents/../../infra/main.tf",
    "./src/a.ts",
    "/etc/passwd",
    "src//a.ts",
  ])
    expect(
      changeFacts({
        plan: { pr: true, actions: [] },
        settings: settings([deploy]),
        prFiles: [path],
      }),
    ).toEqual({
      error: `PR path ${JSON.stringify(path)} is not a plain repository path`,
    });
});
test("a rename counts both its old and its new path", () => {
  const moved = changeFacts({
    plan: { pr: true, actions: [] },
    settings: settings([deploy]),
    prFiles: [
      {
        filename: "src/a.sql",
        previous_filename: "src/db/migrations/0042.sql",
      },
    ],
  });
  expect("error" in moved ? moved : [...moved.facts]).toEqual(["migration"]);
  const hidden = changeFacts({
    plan: { pr: true, actions: [] },
    settings: settings([deploy]),
    prFiles: [
      {
        filename: "docs/incidents/old-infra.md",
        previous_filename: "infra/main.md",
      },
    ],
  });
  expect("error" in hidden ? hidden : hidden.details).toEqual([
    "infra/main.md is outside Deploy's scope",
  ]);
});
