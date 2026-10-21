import { expect, test } from "bun:test";
import type { IncidentAction } from "../../../shared/incident-response";
import {
  actionBadges,
  actionIdFrom,
  applyTemplate,
  commandProblem,
  draftFromAction,
  draftToAction,
  firstLine,
  newAction,
  placeholdersIn,
  runnerInUse,
  switchActionKind,
  withAction,
  withoutAction,
} from "./action-form";

test("ids", () => {
  expect(actionIdFrom("Deploy API!", [])).toBe("deploy-api");
  expect(actionIdFrom("Deploy API", ["deploy-api"])).toBe("deploy-api-2");
  expect(actionIdFrom("Deploy API", ["deploy-api", "deploy-api-2"])).toBe(
    "deploy-api-3",
  );
  expect(actionIdFrom("", [])).toBe("action");
  expect(actionIdFrom("Ünïcode ✓", [])).toBe("n-code");
  expect(actionIdFrom("x".repeat(60), []).length).toBe(40);
  expect(actionIdFrom("x".repeat(60), ["x".repeat(40)])).toBe(
    `${"x".repeat(38)}-2`,
  );
});

test("new actions follow the server's kind defaults", () => {
  expect(newAction("deploy", "rn-prod", []).reversible).toBe(true);
  expect(newAction("run-once", "rn-prod", [])).toMatchObject({
    id: "run-once",
    label: "Run once",
    runner: "rn-prod",
    timeoutMs: 600_000,
    reversible: false,
    cost: { kind: "none" },
    needsSecret: false,
    scope: { services: [], paths: [], migrationPaths: [] },
  });
  expect(newAction("deploy", "rn-prod", ["deploy"]).id).toBe("deploy-2");
});

test("templates fill the command for the kind", () => {
  expect(
    applyTemplate(newAction("rollback", "rn-prod", []), "docker-compose")
      .command,
  ).toBe("IMAGE_TAG={{previousRef}} docker compose up -d");
  expect(
    applyTemplate(newAction("run-once", "rn-prod", []), "script"),
  ).toMatchObject({ command: "./run-once.sh", reversible: false });
});

test("badges and placeholders", () => {
  expect(
    actionBadges({
      ...newAction("pause", "r", []),
      cost: { kind: "amount", usd: 6.5 },
      needsSecret: true,
    }),
  ).toEqual([
    { text: "Can be undone", tone: "neutral" },
    { text: "Costs $6.50", tone: "warning" },
    { text: "Needs a secret", tone: "warning" },
  ]);
  expect(actionBadges(newAction("run-once", "r", []))).toEqual([
    { text: "Can't be undone", tone: "warning" },
  ]);
  expect(placeholdersIn("./deploy.sh {{ref}} {{branch}} {{ref}}")).toEqual({
    known: ["ref"],
    unknown: ["branch"],
  });
});

test("command problems mirror the server", () => {
  expect(commandProblem("./deploy.sh {{ref}}")).toBeNull();
  expect(commandProblem("./deploy.sh {{branch}}")).toBe(
    "Unknown placeholder {{branch}}",
  );
  expect(commandProblem('echo "{{ref}}"')).toBe(
    "Keep placeholders outside quotes. Sessions quotes their values",
  );
  expect(commandProblem("echo '{{ref}}'")).toBe(
    "Keep placeholders outside quotes. Sessions quotes their values",
  );
  expect(commandProblem('echo \\"{{ref}}')).toBeNull();
  expect(commandProblem("echo 'a' {{ref}}")).toBeNull();
});

test("the first line of a command", () => {
  expect(firstLine("\n  set -e\n./deploy.sh {{ref}}")).toBe("set -e");
  expect(firstLine("")).toBe("");
});

const deploy: IncidentAction = {
  ...newAction("deploy", "rn-prod", []),
  command: "./deploy.sh {{ref}}",
  cwd: "/srv/app",
  cost: { kind: "amount", usd: 2 },
  scope: { services: ["api"], paths: ["src/**", "lib/**"], migrationPaths: [] },
};

test("a draft round trips an action", () => {
  const d = draftFromAction(deploy, false);
  expect(d).toMatchObject({
    cwd: "/srv/app",
    costs: true,
    usd: "2",
    paths: "src/**, lib/**",
  });
  expect(draftToAction(d, [deploy])).toEqual({ action: deploy });
});

test("a new draft takes its id from its label", () => {
  const d = {
    ...draftFromAction(newAction("rollback", "rn-prod", []), true),
    label: "Roll back API",
    command: "./rollback.sh {{previousRef}}",
    cwd: " ",
  };
  const out = draftToAction(d, [deploy]);
  expect(out).toMatchObject({
    action: { id: "roll-back-api", label: "Roll back API" },
  });
  expect("action" in out && "cwd" in out.action).toBe(false);
});

test.each([
  [{ label: " " }, "label", "Give the action a name"],
  [{ runner: "" }, "runner", "Pick the host it runs on"],
  [{ command: "  " }, "command", "Enter the command to run"],
  [{ command: "x {{nope}}" }, "command", "Unknown placeholder {{nope}}"],
  [{ cwd: "srv/app" }, "cwd", "Use an absolute path, like /srv/app"],
  [{ costs: true, usd: "0" }, "usd", "Enter an amount over $0"],
  [{ costs: true, usd: "abc" }, "usd", "Enter an amount over $0"],
] as const)("rejects %j", (patch, field, error) => {
  expect(
    draftToAction({ ...draftFromAction(deploy, false), ...patch }, [deploy]),
  ).toEqual({ field, error });
});

test("the actions list: replace in place, append, remove", () => {
  const pause = newAction("pause", "rn-prod", ["deploy"]);
  expect(withAction([deploy], pause).map((a) => a.id)).toEqual([
    "deploy",
    "pause",
  ]);
  expect(withAction([deploy, pause], { ...deploy, label: "Ship" })).toEqual([
    { ...deploy, label: "Ship" },
    pause,
  ]);
  expect(withoutAction([deploy, pause], "deploy")).toEqual([pause]);
});

test("a host in use names its action", () => {
  expect(runnerInUse([deploy], "rn-prod")).toBe(
    "Deploy runs on this host. Move it to another host first",
  );
  expect(runnerInUse([deploy], "rn-other")).toBeNull();
});

test("switching kind carries defaults, keeps what was typed", () => {
  const d = draftFromAction(newAction("deploy", "rn-prod", []), true);
  expect(switchActionKind(d, "run-once", null)).toMatchObject({
    kind: "run-once",
    label: "Run once",
    reversible: false,
  });
  const templated = {
    ...d,
    command: "IMAGE_TAG={{ref}} docker compose up -d",
  };
  expect(
    switchActionKind(templated, "rollback", "docker-compose"),
  ).toMatchObject({
    label: "Roll back",
    command: "IMAGE_TAG={{previousRef}} docker compose up -d",
  });
  const typed = { ...d, label: "Ship API", command: "./ship.sh" };
  expect(switchActionKind(typed, "pause", "script")).toMatchObject({
    kind: "pause",
    label: "Ship API",
    command: "./ship.sh",
  });
});
