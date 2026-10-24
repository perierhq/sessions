import { describe, expect, test } from "bun:test";
import { READY_4_OF_6 } from "../../shared/project-settings-fixtures";
import {
  buildProjectList,
  buildProjectSettingsView,
  defaultSandboxUsedBy,
  joinWithAnd,
} from "./view";
import { testProjectViewDeps } from "./view-test-deps";

describe("buildProjectSettingsView", () => {
  test("acme-web composes into the 4 of 6 design", async () => {
    const { deps } = testProjectViewDeps();
    const view = await buildProjectSettingsView(
      "acme-web",
      { person: true },
      deps,
    );
    expect(view).toEqual(READY_4_OF_6);
  });

  test("the release hook path is for a signed-in person only, the secret never", async () => {
    const { deps } = testProjectViewDeps();
    const view = await buildProjectSettingsView(
      "acme-web",
      { person: false },
      deps,
    );
    expect(view?.document.releaseHookPath).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("releaseHookSecret");
  });

  test("an unknown project is null", async () => {
    const { deps } = testProjectViewDeps();
    expect(
      await buildProjectSettingsView("nope", { person: true }, deps),
    ).toBeNull();
  });

  test("drift marks the project", async () => {
    const { deps } = testProjectViewDeps();
    const view = await buildProjectSettingsView(
      "acme-web",
      { person: true },
      { ...deps, drift: async () => ["acme-web"] },
    );
    expect(view?.drift).toBe(true);
  });

  test("a bound Runner that isn't paired any more is a production problem", async () => {
    const { deps } = testProjectViewDeps();
    const view = await buildProjectSettingsView(
      "acme-web",
      { person: true },
      { ...deps, runners: async () => [] },
    );
    expect(
      view?.readiness.steps.find((s) => s.id === "production"),
    ).toMatchObject({
      state: "todo",
      detail: "Runner rn-prod-eu-1 is not paired",
    });
  });
});

describe("project list and defaults", () => {
  test("one row per project with its status", async () => {
    const { deps } = testProjectViewDeps();
    const list = await buildProjectList(deps);
    expect(list.map((p) => [p.id, p.status.label])).toEqual([
      ["acme-web", "4 of 6 ready"],
      ["acme-api", "Incidents off"],
      ["docs-site", "Incidents off"],
    ]);
    expect(list[0]).toMatchObject({
      sandboxForYou: "podman",
      modelForYou: "pi/anthropic/claude-opus-5-5",
    });
  });

  test("who uses the default sandbox", async () => {
    const { deps } = testProjectViewDeps();
    expect(await defaultSandboxUsedBy(deps)).toBe(
      "Used by acme-api, docs-site, and acme-web's automations",
    );
  });

  test("joinWithAnd", () => {
    expect(joinWithAnd([])).toBe("");
    expect(joinWithAnd(["a"])).toBe("a");
    expect(joinWithAnd(["a", "b"])).toBe("a and b");
    expect(joinWithAnd(["a", "b", "c"])).toBe("a, b, and c");
  });
});
