import { describe, expect, test } from "bun:test";
import {
  DEFAULTS_VIEW,
  PROJECT_LIST,
} from "../../../shared/project-settings-fixtures";
import {
  modelOverrides,
  parseWebsite,
  projectStatusPhrase,
  roleScopeCopy,
  sandboxUsedByCopy,
} from "./defaults-model";

describe("projectStatusPhrase", () => {
  test("is the project's one status label", () => {
    const [web, , docs] = PROJECT_LIST;
    expect(projectStatusPhrase(web!)).toBe("4 of 6 ready");
    expect(projectStatusPhrase(docs!)).toBe("Incidents off");
  });

  test("never says a second phrase", () => {
    for (const item of PROJECT_LIST) {
      expect(projectStatusPhrase(item)).not.toContain("Uses every default");
      expect(projectStatusPhrase(item)).not.toContain("to do");
    }
  });
});

describe("roleScopeCopy", () => {
  test("every project on the default", () => {
    expect(roleScopeCopy("verifier", PROJECT_LIST, {})).toBe("All 3 projects");
  });

  test("names who sets its own", () => {
    expect(roleScopeCopy("you", PROJECT_LIST, { "acme-web": ["you"] })).toBe(
      "acme-api and docs-site. acme-web sets its own",
    );
  });

  test("several projects set their own", () => {
    expect(
      roleScopeCopy("you", PROJECT_LIST, {
        "acme-web": ["you"],
        "acme-api": ["you"],
      }),
    ).toBe("docs-site. acme-web and acme-api set their own");
  });

  test("nobody on the default", () => {
    expect(
      roleScopeCopy("reviews", PROJECT_LIST.slice(0, 1), {
        "acme-web": ["reviews"],
      }),
    ).toBe("No project. acme-web sets its own");
  });

  test("one project", () => {
    expect(roleScopeCopy("you", PROJECT_LIST.slice(0, 1), {})).toBe("acme-web");
  });

  test("no projects yet", () => {
    expect(roleScopeCopy("you", [], {})).toBe("No projects yet");
  });

  test("lists of three or more use a serial comma", () => {
    const four = [
      ...PROJECT_LIST,
      { ...PROJECT_LIST[0]!, id: "shop", label: "shop" },
    ];
    expect(roleScopeCopy("you", four, { shop: ["you"] })).toBe(
      "acme-web, acme-api, and docs-site. shop sets its own",
    );
  });
});

describe("modelOverrides", () => {
  test("a project whose You model differs from the default sets its own", () => {
    const projects = [
      { ...PROJECT_LIST[0]!, modelForYou: "pi/openai/gpt-5.5" },
      ...PROJECT_LIST.slice(1),
    ];
    expect(modelOverrides({ ...DEFAULTS_VIEW, projects })).toEqual({
      "acme-web": ["you"],
    });
    expect(modelOverrides(DEFAULTS_VIEW)).toEqual({});
  });
});

describe("sandboxUsedByCopy", () => {
  test("is the server's sentence verbatim", () => {
    expect(sandboxUsedByCopy(DEFAULTS_VIEW)).toBe(
      "Used by acme-api, docs-site, and acme-web's automations",
    );
  });

  test("falls back to a count", () => {
    expect(sandboxUsedByCopy({ ...DEFAULTS_VIEW, sandboxUsedBy: "" })).toBe(
      "Used by 3 projects",
    );
    expect(
      sandboxUsedByCopy({
        ...DEFAULTS_VIEW,
        sandboxUsedBy: "",
        projects: PROJECT_LIST.slice(0, 1),
      }),
    ).toBe("Used by 1 project");
  });
});

describe("parseWebsite", () => {
  test("keeps a hostname, lower-cased", () => {
    expect(parseWebsite(" Status.Example.TEST ")).toEqual({
      host: "status.example.test",
    });
  });

  test("takes the host of a URL", () => {
    expect(parseWebsite("https://docs.example.test")).toEqual({
      host: "docs.example.test",
    });
  });

  test("refuses what is not a website", () => {
    for (const bad of ["bad host", "", "10.0.0.1", "*", "example"]) {
      expect(parseWebsite(bad)).toHaveProperty("error");
    }
  });
});
