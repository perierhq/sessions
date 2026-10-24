import { describe, expect, test } from "bun:test";
import { PROJECT_LIST } from "../../shared/project-settings-fixtures";
import { matchProjectSections, SETTINGS_KEYWORDS } from "./settings-search";

describe("matchProjectSections", () => {
  test("a word from a project page offers that section of every project", () => {
    const hits = matchProjectSections(PROJECT_LIST, "veto");
    expect(hits.map((h) => [h.label, h.project, h.section])).toEqual([
      ["acme-web · Incidents", "acme-web", "incidents"],
      ["acme-api · Incidents", "acme-api", "incidents"],
      ["docs-site · Incidents", "docs-site", "incidents"],
    ]);
    expect(hits[0]!.hint).toBe("veto");
  });

  test("production words find Production, access words find access", () => {
    expect(
      matchProjectSections(PROJECT_LIST.slice(0, 1), "rollback").map(
        (h) => h.section,
      ),
    ).toEqual(["production"]);
    expect(
      matchProjectSections(PROJECT_LIST.slice(0, 1), "keychain").map(
        (h) => h.section,
      ),
    ).toEqual(["access"]);
  });

  test("a project's own name narrows to it", () => {
    const hits = matchProjectSections(PROJECT_LIST, "acme-api budget");
    expect(hits.map((h) => h.label)).toEqual(["acme-api · Incidents"]);
  });

  test("an empty query offers nothing", () => {
    expect(matchProjectSections(PROJECT_LIST, " ")).toEqual([]);
  });
});

test("Defaults is found by its words, the old Incidents entry is gone", () => {
  expect(SETTINGS_KEYWORDS.projectDefaults).toEqual(
    expect.arrayContaining([
      "defaults",
      "default model",
      "default sandbox",
      "websites",
      "previews",
    ]),
  );
  expect(Object.keys(SETTINGS_KEYWORDS)).not.toContain("incidentSettings");
});
