import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
  type IncidentAction,
} from "../../../../shared/incident-response";
import type {
  ProductionRunnerView,
  ProjectSettingsView,
} from "../../../lib/api/incidents";
import { draftFromAction, newAction } from "../../../lib/incidents/action-form";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { ActionsSection, ActionFields, ProductionHostsList } =
  await import("./ActionsSection");

const prod: ProductionRunnerView = {
  id: "rn-prod",
  name: "prod-1",
  label: "Production · acme",
  platform: "linux",
  online: true,
  bound: true,
  problem: null,
};

function view(
  actions: IncidentAction[],
  runners: ProductionRunnerView[],
): ProjectSettingsView {
  return {
    settings: {
      project: "acme",
      agentsPaused: false,
      incidentsPaused: false,
      autonomy: DEFAULT_AUTONOMY,
      vetoMs: DEFAULT_VETO_MS,
      watchMs: DEFAULT_WATCH_MS,
      maxRounds: DEFAULT_MAX_ROUNDS,
      neverWithoutYou: DEFAULT_NEVER_WITHOUT_YOU,
      budget: DEFAULT_BUDGET,
      agents: {},
      productionRunners: runners.filter((r) => r.bound).map((r) => r.id),
      actions,
      releases: [],
    },
    runners,
    models: { error: "No models" },
    spend: { month: "2026-10", monthUsd: 0, perMonthUsd: 200 },
  };
}

const section = (v: ProjectSettingsView) =>
  renderToStaticMarkup(
    <ActionsSection
      project="acme"
      view={v}
      onSave={async () => {}}
      onRevalidate={() => {}}
    />,
  );

test("no actions: the empty state and one way to add one", () => {
  const html = section(view([], []));
  expect(html).toContain(
    "No actions yet. Agents can only propose a fix until there is a deploy or rollback action",
  );
  expect(html.match(/Add an action/g)?.length).toBe(1);
  expect(html).toContain("Production hosts");
  expect(html).toContain("None paired");
  expect(html).toContain(
    "Agents propose actions; Sessions checks the policy and runs them",
  );
});

test("a deploy action: label, host, first command line and badges", () => {
  const deploy = {
    ...newAction("deploy", "rn-prod", []),
    label: "Deploy API",
    command: "./deploy.sh {{ref}}\n./notify.sh",
  };
  const html = section(view([deploy], [prod]));
  expect(html).toContain("Deploy API");
  expect(html).toContain("Can be undone");
  expect(html).toContain("Production · acme");
  expect(html).toContain("./deploy.sh {{ref}}");
  expect(html).not.toContain("./notify.sh");
  // The host row lists the bound Runner.
  expect(html).not.toContain("None paired");
});

test("the hosts list: state words, problems, warnings, switches", () => {
  const html = renderToStaticMarkup(
    <ProductionHostsList
      label="acme"
      runners={[
        prod,
        {
          ...prod,
          id: "rn-lab",
          name: "lab",
          label: undefined,
          online: false,
          bound: false,
          confirm: "Runner lab serves every repository",
        },
        {
          ...prod,
          id: "rn-win",
          name: "win",
          label: undefined,
          bound: false,
          problem: "Runner win runs Windows",
        },
      ]}
      busy={null}
      onToggle={() => {}}
    />,
  );
  expect(html).toContain("Online");
  expect(html).toContain("Offline");
  expect(html).toContain("Runner lab serves every repository");
  expect(html).toContain("Runner win runs Windows");
  expect(html).toContain('aria-label="Use lab for acme"');
  // A Runner with a problem cannot be switched on.
  expect(html).toMatch(
    /aria-label="Use win for acme"[^>]*disabled|disabled[^>]*aria-label="Use win for acme"/,
  );
});

const fields = (
  draft = draftFromAction(newAction("deploy", "rn-prod", []), true),
  runners = [prod],
  actions: IncidentAction[] = [],
) =>
  renderToStaticMarkup(
    <ActionFields
      draft={draft}
      onChange={() => {}}
      error={null}
      idFor={(f) => `a-${f}`}
      runners={runners}
      others={actions}
      onOpenHosts={() => {}}
    />,
  );

test("the action fields: placeholders, quoting and phone text size", () => {
  const html = fields();
  expect(html).toContain("{{ref}}, {{previousRef}}, {{incident}}, {{project}}");
  expect(html).toContain("Sessions quotes their values");
  for (const input of html.match(/<(input|textarea)\b[^>]*>/g) ?? [])
    if (!input.includes('type="checkbox"') && !input.includes("hidden"))
      expect(input).toContain("phone:text-input-phone");
});

test("an unknown placeholder shows under the command", () => {
  const draft = {
    ...draftFromAction(newAction("deploy", "rn-prod", []), true),
    command: "./deploy.sh {{branch}}",
  };
  expect(fields(draft)).toContain("Unknown placeholder {{branch}}");
});

test("no bound host: the alert points at production hosts", () => {
  const html = fields(undefined, []);
  expect(html).toContain("Pair a production host first");
});
