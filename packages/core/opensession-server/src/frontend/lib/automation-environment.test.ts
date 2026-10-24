import { describe, expect, test } from "bun:test";
import {
  LEGACY_SANDBOX_COPY,
  automationDefaultModelLabel,
  automationPlaceCopy,
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
    ).toBe("Runs on Daytona eu · set by acme-web → Where agents run");
  });

  test("says why it can't start", () => {
    expect(
      automationPlaceCopy(
        { repo: "acme-web" },
        { state: "cant-start", reason: "no sandbox can run it unattended" },
      ),
    ).toBe(
      "Can't start: no sandbox can run it unattended · set by acme-web → Where agents run",
    );
  });

  test("an old per-automation sandbox keeps its disposable profile", () => {
    expect(
      automationPlaceCopy({ repo: "acme-web", sandbox: true }, undefined),
    ).toBe(LEGACY_SANDBOX_COPY);
  });

  test("without a project, the global default", () => {
    expect(automationPlaceCopy({}, undefined)).toContain("Projects → Defaults");
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
