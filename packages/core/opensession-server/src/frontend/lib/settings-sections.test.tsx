import { describe, expect, test } from "bun:test";
import { PROJECT_LIST } from "../../shared/project-settings-fixtures";
import {
  SECTIONS,
  TOOL_SECTIONS,
  projectPaletteActions,
  settingsPaletteActions,
} from "./settings-sections";
import { SETTINGS_KEYWORDS } from "./settings-search";

// The palette and the Settings nav used to keep separate lists of where you
// can go, and the palette's had three of the nav's twenty-five entries. These
// assert the two cannot drift apart again: the palette's set is derived from
// the nav table, so every section the nav offers has to come out the other end.

const navSections = SECTIONS.filter((s) => !TOOL_SECTIONS.has(s.key));

describe("settingsPaletteActions", () => {
  test("groups settings by personal and organization ownership", () => {
    expect(
      SECTIONS.find((section) => section.key === "myAccounts")?.group,
    ).toBe("Personal");
    expect(SECTIONS.find((section) => section.key === "general")?.group).toBe(
      "Organization",
    );
    expect(SECTIONS.find((section) => section.key === "memory")?.label).toBe(
      "Memories",
    );
  });

  test("keeps identity settings inside General", () => {
    expect(SECTIONS.map((section) => String(section.key))).not.toContain(
      "identity",
    );
    expect(SETTINGS_KEYWORDS.general).toContain("identity");
  });

  test("combines model and usage settings under Providers", () => {
    const sections = SECTIONS.map((section) => ({
      key: String(section.key),
      label: section.label,
    }));
    expect(sections).toContainEqual({ key: "providers", label: "Providers" });
    expect(sections.map((section) => section.key)).not.toContain("models");
    expect(sections.map((section) => section.key)).not.toContain("usage");
    expect(SETTINGS_KEYWORDS.providers).toEqual(
      expect.arrayContaining(["models", "usage", "quota"]),
    );
  });

  test("covers every non-tool section", () => {
    const actions = settingsPaletteActions();
    expect(actions.map((a) => a.section).sort()).toEqual(
      navSections.map((s) => s.key).sort(),
    );
  });

  test("leaves the tool sections to their own palette entries", () => {
    const sections = settingsPaletteActions().map((a) => a.section);
    for (const key of TOOL_SECTIONS) expect(sections).not.toContain(key);
  });

  test("ids are unique and namespaced so they cannot collide with other actions", () => {
    const ids = settingsPaletteActions().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("settings-")).toBe(true);
  });

  test("carries the section's label, group and keywords", () => {
    const actions = settingsPaletteActions();
    for (const action of actions) {
      const section = navSections.find((s) => s.key === action.section);
      expect(section).toBeTruthy();
      expect(action.label).toBe(section!.label);
      expect(action.description).toBe(`Settings · ${section!.group}`);
      expect(action.keywords).toEqual(SETTINGS_KEYWORDS[action.section] ?? []);
      // House style: a middle dot, never an em dash.
      expect(action.description).not.toContain("—");
    }
  });

  test("every non-tool section has search keywords", () => {
    const missing = navSections
      .filter((s) => !SETTINGS_KEYWORDS[s.key]?.length)
      .map((s) => s.key);
    expect(missing).toEqual([]);
  });
});

test("Projects sits between Personal and Organization, with Defaults", () => {
  const groups = [...new Set(SECTIONS.map((section) => section.group))];
  expect(groups.slice(0, 3)).toEqual(["Personal", "Projects", "Organization"]);
  expect(SECTIONS.find((s) => s.key === "projectDefaults")).toMatchObject({
    label: "Defaults",
    group: "Projects",
  });
  expect(TOOL_SECTIONS.has("projectDefaults")).toBe(false);
});

test("the old Incidents item is gone", () => {
  const keys = SECTIONS.map((section) => String(section.key));
  expect(keys).not.toContain("incidentSettings");
  expect([...TOOL_SECTIONS].map(String)).not.toContain("incidentSettings");
  expect(SECTIONS.map((s) => s.label)).not.toContain("Incidents");
});

test("the palette reaches Defaults and every project", () => {
  expect(settingsPaletteActions().map((a) => a.section)).toContain(
    "projectDefaults",
  );
  const actions = projectPaletteActions(PROJECT_LIST);
  expect(actions.map((a) => [a.label, a.description, a.project])).toEqual([
    ["acme-web settings", "Settings · Projects", "acme-web"],
    ["acme-api settings", "Settings · Projects", "acme-api"],
    ["docs-site settings", "Settings · Projects", "docs-site"],
  ]);
  const ids = actions.map((a) => a.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id.startsWith("settings-project-")).toBe(true);
});
