import { describe, expect, test } from "bun:test";
import { BASE_PATH } from "./base";
import {
  firstMileRequested,
  incidentSettingsRoute,
  legacyRoutePath,
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
    { view: "support", threadId: "plain:thread/1" },
    { view: "support", threadId: "email:sc_1" },
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

  test("support item ids keep their colon in the path", () => {
    expect(routePath({ view: "support", threadId: "email:sc_1" })).toBe(
      `${BASE_PATH}/support/email:sc_1`,
    );
    // Only known channels prefix an id; anything else is a bare Plain id.
    expect(parseRoute("/support/sms:x1")).toEqual({
      view: "support",
      threadId: "plain:sms:x1",
    });
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
  test("home and page", () => {
    expect(parseRoute("/incidents")).toEqual({ view: "incidents" });
    expect(parseRoute("/incidents/inc-1")).toEqual({
      view: "incidents",
      id: "inc-1",
    });
    expect(routePath({ view: "incidents" })).toBe(`${BASE_PATH}/incidents`);
    expect(routePath({ view: "incidents", id: "inc 1" })).toBe(
      `${BASE_PATH}/incidents/inc%201`,
    );
    expect(isSettingsRoute({ view: "incidents" })).toBe(false);
  });

  test("an incident's settings links open its project's page", () => {
    expect(incidentSettingsRoute("acme-web")).toEqual({
      view: "projectSettings",
      project: "acme-web",
      section: "incidents",
    });
    expect(incidentSettingsRoute("acme-web", { section: "access" })).toEqual({
      view: "projectSettings",
      project: "acme-web",
      section: "access",
    });
    expect(incidentSettingsRoute("acme-web", { fix: "sandboxes" })).toEqual({
      view: "projectSettings",
      project: "acme-web",
      section: "where",
    });
    expect(incidentSettingsRoute("acme-web", { fix: "providers" })).toEqual({
      view: "settings",
      section: "providers",
    });
  });

  test("old incident settings links name their current path", () => {
    expect(legacyRoutePath("/settings/incidents/acme-web")).toBe(
      `${BASE_PATH}/settings/projects/acme-web/incidents`,
    );
    expect(legacyRoutePath("/settings/incidents")).toBe(
      routePath({ view: "settings", section: "projectDefaults" }),
    );
    expect(legacyRoutePath("/settings/projects/acme-web")).toBeNull();
  });

  test("old incident settings links open the project pages", () => {
    expect(parseRoute("/settings/incidents")).toEqual({
      view: "settings",
      section: "projectDefaults",
    });
    expect(parseRoute("/settings/incidents/acme-web")).toEqual({
      view: "projectSettings",
      project: "acme-web",
      section: "incidents",
    });
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

  test("support push intents open an email conversation", () => {
    expect(parseRouteWithSearch("/support/email:sc_1", "?intent=stop")).toEqual(
      { view: "support", threadId: "email:sc_1", intent: "stop" },
    );
    expect(
      parseRouteWithSearch("/support/email:sc_1", "?intent=review"),
    ).toEqual({ view: "support", threadId: "email:sc_1", intent: "review" });
    expect(parseRouteWithSearch("/support/email:sc_1", "?intent=send")).toEqual(
      { view: "support", threadId: "email:sc_1" },
    );
    expect(parseRouteWithSearch("/support/th_1", "?intent=stop")).toEqual({
      view: "support",
      threadId: "plain:th_1",
    });
    expect(
      routePath({ view: "support", threadId: "email:sc_1", intent: "stop" }),
    ).toBe(`${BASE_PATH}/support/email:sc_1?intent=stop`);
  });
});

describe("project settings routes", () => {
  test("Defaults", () => {
    expect(parseRoute("/settings/projects")).toEqual({
      view: "settings",
      section: "projectDefaults",
    });
    expect(parseRoute("/settings/projectDefaults")).toEqual({
      view: "settings",
      section: "projectDefaults",
    });
    expect(routePath({ view: "settings", section: "projectDefaults" })).toBe(
      `${BASE_PATH}/settings/projects`,
    );
  });

  test("a project and its sections", () => {
    expect(parseRoute("/settings/projects/acme-web")).toEqual({
      view: "projectSettings",
      project: "acme-web",
    });
    expect(parseRoute("/settings/projects/acme%20web/access")).toEqual({
      view: "projectSettings",
      project: "acme web",
      section: "access",
    });
    // An unknown section still opens the project.
    expect(parseRoute("/settings/projects/acme-web/nope")).toEqual({
      view: "projectSettings",
      project: "acme-web",
    });
    expect(
      routePath({
        view: "projectSettings",
        project: "acme-web",
        section: "access",
      }),
    ).toBe(`${BASE_PATH}/settings/projects/acme-web/access`);
    expect(routePath({ view: "projectSettings", project: "acme web" })).toBe(
      `${BASE_PATH}/settings/projects/acme%20web`,
    );
    expect(
      isSettingsRoute({ view: "projectSettings", project: "acme-web" }),
    ).toBe(true);
  });

  test("the Knowledge page and its tabs", () => {
    expect(parseRoute("/settings/projects/acme/knowledge")).toEqual({
      view: "projectSettings",
      project: "acme",
      section: "knowledge",
    });
    expect(parseRoute("/settings/projects/acme/knowledge/needs-check")).toEqual(
      {
        view: "projectSettings",
        project: "acme",
        section: "knowledge",
        knowledge: { tab: "needs-check" },
      },
    );
    // An unknown tab opens the articles.
    expect(parseRoute("/settings/projects/acme/knowledge/nope")).toEqual({
      view: "projectSettings",
      project: "acme",
      section: "knowledge",
      knowledge: { tab: "articles" },
    });
    expect(
      parseRoute(
        "/settings/projects/acme/knowledge/articles/articles/export.md",
      ),
    ).toEqual({
      view: "projectSettings",
      project: "acme",
      section: "knowledge",
      knowledge: { tab: "articles", path: "articles/export.md" },
    });
  });

  test("an item path with slashes round-trips", () => {
    const route: Route = {
      view: "projectSettings",
      project: "acme web",
      section: "knowledge",
      knowledge: {
        tab: "suggestions",
        path: "sources/mail/2026-10/<a1@mail.example.test>.md",
      },
    };
    const path = routePath(route);
    expect(path).toBe(
      `${BASE_PATH}/settings/projects/acme%20web/knowledge/suggestions/sources%2Fmail%2F2026-10%2F%3Ca1%40mail.example.test%3E.md`,
    );
    expect(parseRoute(path.slice(BASE_PATH.length))).toEqual(route);
  });

  test("round trips", () => {
    const routes: Route[] = [
      { view: "settings", section: "projectDefaults" },
      { view: "projectSettings", project: "acme-web" },
      { view: "projectSettings", project: "docs-site", section: "incidents" },
      { view: "projectSettings", project: "acme", section: "knowledge" },
      {
        view: "projectSettings",
        project: "acme",
        section: "knowledge",
        knowledge: { tab: "import" },
      },
      {
        view: "projectSettings",
        project: "acme",
        section: "knowledge",
        knowledge: { tab: "history", path: "articles/export.md" },
      },
    ];
    for (const route of routes) {
      expect(parseRoute(routePath(route).slice(BASE_PATH.length))).toEqual(
        route,
      );
    }
  });
});
