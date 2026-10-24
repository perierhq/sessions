import { describe, expect, test } from "bun:test";
import {
  LEGACY_SANDBOX_COPY,
  automationDefaultModelLabel,
  automationPlaceCopy,
  automationProject,
  visibleAutomations,
} from "./automation-environment";

describe("visibleAutomations", () => {
  test("hides the built-in incident automation", () => {
    const list = [
      { id: "nightly" },
      { id: "incidents-acme-web", incidentResponse: { project: "acme-web" } },
      { id: "digest", repo: "acme-api" },
    ];
    expect(visibleAutomations(list).map((a) => a.id)).toEqual([
      "nightly",
      "digest",
    ]);
  });
});

describe("automationPlaceCopy", () => {
  test("names the project's place for automations", () => {
    expect(
      automationPlaceCopy(
        { repo: "acme-web" },
        {
          state: "ok",
          provider: "daytona",
          label: "Daytona eu",
          source: "default",
        },
      ),
    ).toBe("Runs on Daytona eu. Set in acme-web → Where agents run");
  });

  test("says why it can't start", () => {
    expect(
      automationPlaceCopy(
        { repo: "acme-web" },
        { state: "cant-start", reason: "no sandbox can run it unattended" },
      ),
    ).toBe(
      "Can't start: no sandbox can run it unattended. Set in acme-web → Where agents run",
    );
  });

  test("an old per-automation sandbox keeps its disposable profile", () => {
    expect(
      automationPlaceCopy({ repo: "acme-web", sandbox: true }, undefined),
    ).toBe(LEGACY_SANDBOX_COPY);
  });

  test("without a repo, the instance default repo's place", () => {
    expect(
      automationPlaceCopy({}, undefined, "acme-web"),
    ).toBe("Runs where acme-web says. Set in acme-web → Where agents run");
    expect(automationPlaceCopy({}, undefined)).toBe(
      "Runs where the default project says",
    );
  });
});

describe("automationProject", () => {
  const repos = [{ id: "acme-api" }, { id: "acme-web", default: true }];

  test("an automation's own repo", () => {
    expect(automationProject({ repo: "acme-api" }, repos)).toBe("acme-api");
  });

  test("without one, the instance default repo, as the server picks it", () => {
    expect(automationProject({}, repos)).toBe("acme-web");
    expect(automationProject({}, [{ id: "docs-site" }])).toBe("docs-site");
    expect(automationProject({}, undefined)).toBeNull();
  });

  test("an old disposable sandbox has no project place", () => {
    expect(automationProject({ sandbox: true }, repos)).toBeNull();
  });
});

test("the empty model choice names the project's default", () => {
  expect(automationDefaultModelLabel("Sonnet 5", "Opus 5.5")).toBe(
    "Project default · Sonnet 5",
  );
  expect(automationDefaultModelLabel(undefined, "Opus 5.5")).toBe(
    "Default · Opus 5.5",
  );
  expect(automationDefaultModelLabel(undefined, "")).toBe("Default");
});
