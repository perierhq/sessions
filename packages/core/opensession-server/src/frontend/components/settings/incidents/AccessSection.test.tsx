import { expect, test } from "bun:test";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultIncidentAccessSettings,
  type IncidentAccessSettingsView,
} from "../../../../shared/incident-access";
import type { SignalView } from "../../../../shared/incidents";
import { grantedChoices } from "../../../lib/incidents/access-form";

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

const { AccessRows, RoleFields } = await import("./AccessSection");

const base = defaultIncidentAccessSettings("acme", "2026-10-20T10:00:00Z");
const view: IncidentAccessSettingsView = {
  ...base,
  revision: 3,
  grants: {
    ...base.grants,
    connections: ["sentry", "logs"],
    hosts: [{ runner: "rn-prod", access: "read-only" }],
  },
  overrides: [
    {
      signalId: "sig-a",
      role: "investigator",
      fields: { connections: ["sentry"], hosts: [] },
      updatedBy: "Ada",
      updatedAt: "x",
    },
  ],
  isDefault: false,
  credentialInfo: {},
};
// SAFETY: only the id, name and project are read from a signal here.
const signals = [
  { id: "sig-a", name: "Search", project: "acme" },
] as SignalView[];

const rows = (over: Partial<React.ComponentProps<typeof AccessRows>> = {}) =>
  renderToStaticMarkup(
    <AccessRows
      label="acme"
      view={view}
      error={null}
      previews={{
        investigator: {
          access: null,
          tools: [],
          warnings: [],
          error: "Connection sentry is not configured",
        },
        verifier: undefined,
      }}
      models={{
        investigator: { model: "pi/a/x", provider: "a", label: "Model X" },
        verifier: {
          model: "pi/b/y",
          provider: "b",
          label: "Model Y",
          independence: "other-provider",
        },
      }}
      agents={{}}
      modelOptions={[{ value: "auto", label: "Automatic" }]}
      signals={signals}
      runnerName={(id) => id}
      onOpenGrants={() => {}}
      onOpenRole={() => {}}
      onOpenOverride={() => {}}
      onAddOverride={() => {}}
      onModel={() => {}}
      onReset={() => {}}
      onRetry={() => {}}
      {...over}
    />,
  );

test("the six row kinds, in order", () => {
  const html = rows();
  const order = [
    "What this project may grant",
    "2 connections · 1 repository · 1 host",
    ">Investigator<",
    "Connection sentry is not configured",
    ">Verifier<",
    "Investigator model",
    "Model X",
    "Verifier model",
    "Model Y · different provider",
    "Search · Investigator",
    "Connections, Hosts",
    "Reset to defaults",
  ];
  let at = -1;
  for (const text of order) {
    const next = html.indexOf(text, at + 1);
    expect({ text, found: next > at }).toEqual({ text, found: true });
    at = next;
  }
});

test("without the fix loop the model rows are left out", () => {
  expect(rows({ models: null })).not.toContain("Investigator model");
});

test("a models error shows in place of the label", () => {
  expect(rows({ models: { error: "No model is configured" } })).toContain(
    "No model is configured",
  );
});

test("unreadable settings: the server's message and a reset", () => {
  const html = rows({
    view: undefined,
    error: {
      message: "Stored access settings for acme are unreadable: bad",
      unreadable: true,
    },
  });
  expect(html).toContain("Stored access settings for acme are unreadable");
  expect(html).toContain("Reset to defaults");
  expect(html).not.toContain("What this project may grant");
});

test("without access profiles on the server: one info notice", () => {
  const html = rows({ view: null });
  expect(html).toContain("Access profiles need incident agent access");
  expect(html).not.toContain(
    'role="alert" class="flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm border-red',
  );
});

const fields = (role: "investigator" | "verifier", partial = false) =>
  renderToStaticMarkup(
    <RoleFields
      role={role}
      partial={partial}
      fields={partial ? {} : view.profiles[role]}
      roleProfile={view.profiles[role]}
      choices={grantedChoices(view.grants)}
      onChange={() => {}}
      runnerName={(id) => id}
      credentialName={(id) => id}
      modelOptions={[{ value: "auto", label: "Automatic" }]}
    />,
  );

test("the verifier's mode is fixed to read-only", () => {
  const html = fields("verifier");
  expect(html).toContain("The verifier may not edit the candidate");
  const group = html.match(/<div[^>]*aria-label="Mode"[^>]*>/)?.[0] ?? "";
  expect(group).toContain("data-disabled");
});

test("choices come from the grants only", () => {
  const html = fields("investigator");
  expect(html).toContain("sentry");
  expect(html).toContain("logs");
  expect(html).not.toContain("Model");
});

test("an override's fields follow the role until changed", () => {
  const html = fields("investigator", true);
  expect(html.match(/Use the role&#x27;s setting/g)?.length).toBeGreaterThan(5);
  expect(html).toContain("Model");
});
