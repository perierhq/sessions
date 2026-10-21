import { expect, test } from "bun:test";
import {
  type CompleteAccessProfile,
  egressRouteKey,
  type HostGrant,
  hostGrantKey,
  type ProjectAccessGrants,
} from "../../../shared/incident-access";
import {
  describeField,
  effectiveProfile,
  egressLabel,
  grantedChoices,
  grantsSummary,
  independenceText,
  listToText,
  modelChoices,
  overrideSummary,
  previewDraft,
  summaryWithoutRole,
  textToList,
  toggleIn,
  inheritField,
} from "./access-form";

const grants: ProjectAccessGrants = {
  connections: ["sentry", "logs"],
  repos: ["acme"],
  runners: ["rn-prod"],
  hosts: [{ runner: "rn-prod", access: "read-only" }],
  credentials: [
    { credential: "kc-proxy", mode: "once", grantedBy: "Ada", grantedAt: "x" },
  ],
  egress: [{ route: "server" }, { route: "runner", runner: "rn-prod" }],
  maxMode: "code",
};

test("choices never exceed the grants", () => {
  const c = grantedChoices(grants);
  expect(c.connections).toEqual(["sentry", "logs"]);
  expect(c.credentials).toEqual([{ credential: "kc-proxy", maxMode: "once" }]);
  expect(c.egress.map(egressRouteKey)).toEqual(["server", "runner:rn-prod"]);
  expect(c.maxMode).toBe("code");
});

test("override summary names the fields it sets", () => {
  expect(
    overrideSummary({
      signalId: "sig-a",
      role: "investigator",
      fields: { connections: ["sentry"], hosts: [] },
      updatedBy: "Ada",
      updatedAt: "x",
    }),
  ).toBe("Connections, Hosts");
  expect(
    overrideSummary({
      signalId: "sig-a",
      role: "verifier",
      fields: {},
      updatedBy: "Ada",
      updatedAt: "x",
    }),
  ).toBe("Nothing yet");
});

test("toggle by key", () => {
  const h: HostGrant = { runner: "rn-prod", access: "read-only" };
  expect(toggleIn([h], { ...h }, hostGrantKey)).toEqual([]);
  expect(toggleIn([], h, hostGrantKey)).toEqual([h]);
});

test("grants summary counts what is granted", () => {
  expect(grantsSummary(grants)).toBe(
    "2 connections · 1 repository · 1 Runner · 1 host · 1 credential",
  );
  expect(
    grantsSummary({
      ...grants,
      connections: [],
      repos: [],
      runners: [],
      hosts: [],
      credentials: [],
    }),
  ).toBe("Nothing beyond its own server");
});

test("comma lists", () => {
  expect(textToList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
  expect(listToText(["a", "b"])).toBe("a, b");
});

test("egress labels", () => {
  const name = (id: string) => (id === "rn-prod" ? "prod-1" : id);
  expect(egressLabel({ route: "server" }, name)).toBe("This server");
  expect(egressLabel({ route: "runner", runner: "rn-prod" }, name)).toBe(
    "Through prod-1",
  );
  expect(
    egressLabel(
      { route: "proxy", url: "https://proxy.example.test:8080" },
      name,
    ),
  ).toBe("Proxy proxy.example.test:8080");
});

const role: CompleteAccessProfile = {
  connections: ["sentry"],
  deniedTools: [],
  mode: "code",
  repos: ["acme"],
  runners: [],
  hosts: [],
  credentials: [],
  model: null,
  egress: { route: "server" },
};

test("an override field follows the role or holds its own value", () => {
  expect(inheritField({ connections: [] }, "connections", true, role)).toEqual(
    {},
  );
  expect(inheritField({}, "connections", false, role)).toEqual({
    connections: ["sentry"],
  });
  expect(inheritField({}, "egress", false, role)).toEqual({
    egress: { route: "server" },
  });
});

test("preview drafts", () => {
  expect(previewDraft("verifier", null, { mode: "ask" })).toEqual({
    profiles: { verifier: { mode: "ask" } },
  });
  expect(previewDraft("investigator", "sig-a", { hosts: [] })).toEqual({
    overrides: [
      { role: "investigator", signalId: "sig-a", fields: { hosts: [] } },
    ],
  });
});

test("model choices: automatic first, the stored one kept", () => {
  expect(
    modelChoices(
      [
        { id: "pi/a/x", label: "X" },
        { id: "pi/b/y", label: "Y" },
      ],
      "pi/c/z",
    ),
  ).toEqual([
    { value: "auto", label: "Automatic" },
    { value: "pi/a/x", label: "X" },
    { value: "pi/b/y", label: "Y" },
    { value: "pi/c/z", label: "pi/c/z" },
  ]);
});

test("independence without the role prefix", () => {
  expect(independenceText("other-provider")).toBe("different provider");
});

test("an override's effective profile: its fields over the role's", () => {
  expect(
    effectiveProfile(role, { hosts: [], model: "pi/a/x", egress: null }),
  ).toEqual({
    ...role,
    hosts: [],
    model: "pi/a/x",
    egress: null,
  });
  expect(effectiveProfile(role, {})).toEqual(role);
});

test("a role's summary under its own title", () => {
  expect(
    summaryWithoutRole("Verifier · logs · read-only on acme", "verifier"),
  ).toBe("Logs · read-only on acme");
  expect(summaryWithoutRole("logs", "verifier")).toBe("logs");
});

test("a field left to the role, in words", () => {
  const names = {
    runner: (id: string) => (id === "rn-prod" ? "prod-1" : id),
    credential: (id: string) => (id === "kc-proxy" ? "proxy" : id),
    repo: (id: string) => id,
    model: (id: string) => id,
  };
  const p = {
    ...role,
    hosts: [{ runner: "rn-prod", access: "read-only" as const }],
    credentials: [{ credential: "kc-proxy", mode: "once" as const }],
  };
  expect(describeField("connections", p, names)).toBe("sentry");
  expect(describeField("deniedTools", p, names)).toBe("None");
  expect(describeField("mode", p, names)).toBe("Can edit");
  expect(describeField("hosts", p, names)).toBe("prod-1");
  expect(describeField("credentials", p, names)).toBe("proxy (once)");
  expect(describeField("model", p, names)).toBe("Automatic");
  expect(describeField("egress", p, names)).toBe("This server");
});
