import { describe, expect, test } from "bun:test";
import { BASE_PATH } from "./base";
import {
  firstMileRequested,
  isSettingsRoute,
  parseRoute,
  parseRouteWithSearch,
  routePath,
  samePanel,
  type Route,
} from "./app-route";

describe("parseRoute", () => {
  test("parses workspace, session, and sub-agent routes", () => {
    expect(parseRoute("/workspace/work%201/review")).toEqual({
      view: "workspace",
      id: "work 1",
      tab: "review",
    });
    expect(
      parseRoute("/workspace/work-1/session/os-1/subagent/agent-a"),
    ).toEqual({
      view: "session",
      id: "os-1",
      subagent: ["agent-a"],
    });
    expect(
      parseRoute("/workspace/work-1/session/os-1/asset/report.html"),
    ).toEqual({ view: "session", id: "os-1", asset: "report.html" });
    expect(parseRoute("/session/legacy/slashed-id")).toEqual({
      view: "session",
      id: "legacy/slashed-id",
    });
  });

  test("distinguishes pull request numbers from branches", () => {
    expect(parseRoute("/pr/tellahq%2Fopensession/123")).toEqual({
      view: "pr",
      repo: "tellahq/opensession",
      number: 123,
    });
    expect(parseRoute("/pr/tellahq%2Fopensession/feature%2Froute")).toEqual({
      view: "pr",
      repo: "tellahq/opensession",
      branch: "feature/route",
    });
  });

  test("keeps aliases and legacy settings links working", () => {
    expect(parseRoute("/people")).toEqual({ view: "feed" });
    expect(parseRoute("/connections")).toEqual({
      view: "settings",
      section: "connections",
    });
    expect(parseRoute("/settings/modelProviders")).toEqual({
      view: "settings",
      section: "providers",
    });
    expect(parseRoute("/settings/automations")).toEqual({
      view: "automations",
    });
    expect(parseRoute("/unknown")).toEqual({ view: "prs" });
  });
});

describe("routePath", () => {
  const routes: Route[] = [
    { view: "session", id: "os/1", subagent: ["agent/a"] },
    { view: "session", id: "os-1", asset: "reports/summary.html" },
    { view: "workspace", id: "workspace 1", tab: "conversation" },
    { view: "pr", repo: "tellahq/opensession", branch: "feature/route" },
    { view: "pr", repo: "tellahq/opensession", number: 42 },
    { view: "support", threadId: "thread/1" },
    { view: "plain", threadId: "thread/1" },
    { view: "reports", automationId: "daily check", reportId: "report/1" },
    { view: "databases", databaseId: "tickets-4f3a", table: "open/tickets" },
    { view: "automations", id: "daily check" },
    { view: "goals", id: "goal/1" },
    { view: "settings", section: "preferences" },
    { view: "reviews", id: "review/1" },
  ];

  test("round-trips every parameterized route", () => {
    for (const route of routes) {
      expect(parseRoute(routePath(route))).toEqual(route);
    }
  });

  test("writes the root and prompt routes", () => {
    expect(routePath({ view: "prs" })).toBe(`${BASE_PATH}/`);
    expect(routePath({ view: "new", prompt: "Fix this" })).toBe(
      `${BASE_PATH}/new?prompt=Fix%20this`,
    );
  });
});

describe("route helpers", () => {
  test("recognizes first-mile requests", () => {
    expect(firstMileRequested("/welcome", "")).toBe(true);
    expect(firstMileRequested("/", "?firstmile=1")).toBe(true);
    expect(firstMileRequested("/", "?firstmile=0")).toBe(false);
  });

  test("recognizes settings surfaces and refinements of the same panel", () => {
    expect(isSettingsRoute({ view: "settings" })).toBe(true);
    expect(isSettingsRoute({ view: "automations" })).toBe(true);
    expect(isSettingsRoute({ view: "session", id: "one" })).toBe(false);
    expect(
      samePanel(
        { view: "workspace", id: "one" },
        { view: "workspace", id: "one", tab: "review" },
      ),
    ).toBe(true);
    expect(
      samePanel(
        { view: "workspace", id: "one" },
        { view: "workspace", id: "two" },
      ),
    ).toBe(false);
  });
});

describe("issues route", () => {
  test("round-trips the Issues page", () => {
    expect(parseRoute("/issues")).toEqual({ view: "issues" });
    expect(routePath({ view: "issues" })).toBe(`${BASE_PATH}/issues`);
  });
});

describe("incident routes", () => {
  test("home, page and settings", () => {
    expect(parseRoute("/incidents")).toEqual({ view: "incidents" });
    expect(parseRoute("/incidents/inc-1")).toEqual({
      view: "incidents",
      id: "inc-1",
    });
    expect(parseRoute("/settings/incidents")).toEqual({
      view: "incidentSettings",
    });
    expect(parseRoute("/settings/incidents/acme-api")).toEqual({
      view: "incidentSettings",
      project: "acme-api",
    });
    expect(routePath({ view: "incidents" })).toBe(`${BASE_PATH}/incidents`);
    expect(routePath({ view: "incidents", id: "inc 1" })).toBe(
      `${BASE_PATH}/incidents/inc%201`,
    );
    expect(routePath({ view: "incidentSettings" })).toBe(
      `${BASE_PATH}/settings/incidents`,
    );
    expect(routePath({ view: "incidentSettings", project: "acme" })).toBe(
      `${BASE_PATH}/settings/incidents/acme`,
    );
    expect(isSettingsRoute({ view: "incidentSettings" })).toBe(true);
    expect(isSettingsRoute({ view: "incidents" })).toBe(false);
  });

  test("push intents are owner decisions", () => {
    expect(parseRouteWithSearch("/incidents/inc-1", "?intent=stop")).toEqual({
      view: "incidents",
      id: "inc-1",
      intent: "stop",
    });
    expect(parseRouteWithSearch("/incidents/inc-1", "?intent=approve")).toEqual(
      { view: "incidents", id: "inc-1", intent: "approve" },
    );
    expect(parseRouteWithSearch("/incidents/inc-1", "?intent=rm")).toEqual({
      view: "incidents",
      id: "inc-1",
    });
    expect(parseRouteWithSearch("/incidents", "?intent=stop")).toEqual({
      view: "incidents",
    });
    expect(parseRouteWithSearch("/goals", "?intent=stop")).toEqual({
      view: "goals",
    });
    expect(routePath({ view: "incidents", id: "inc-1", intent: "retry" })).toBe(
      `${BASE_PATH}/incidents/inc-1?intent=retry`,
    );
  });
});
