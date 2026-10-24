import { describe, expect, test } from "bun:test";
import {
  DEFAULTS_VIEW,
  PROJECT_LIST,
} from "../../../shared/project-settings-fixtures";
import {
  modelOverrides,
  modelOverridesFromDocuments,
  roleScopeCopyFor,
  newSessionSandboxDefault,
  newSessionSandboxPreselect,
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

  test("every project setting its own says so, not \"No project\"", () => {
    const all = Object.fromEntries(
      PROJECT_LIST.map((p) => [p.id, ["reviews" as const]]),
    );
    expect(roleScopeCopy("reviews", PROJECT_LIST, all)).toBe(
      "Every project sets its own",
    );
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
    ).toBe("acme-web sets its own");
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

describe("newSessionSandboxDefault", () => {
  const status = (repos: Record<string, string>, workspace = "box") => ({
    defaults: { workspace, personal: "tart", effective: "tart", repos },
  });

  test("the project's sandbox wins over the global default", () => {
    expect(
      newSessionSandboxDefault(status({ "acme-web": "daytona" }), "acme-web"),
    ).toBe("daytona");
  });

  test("a project on the default uses the global default, never a personal one", () => {
    expect(newSessionSandboxDefault(status({}), "acme-web")).toBe("box");
    expect(
      newSessionSandboxDefault(status({ "acme-web": "default" }), "acme-web"),
    ).toBe("box");
    expect(
      newSessionSandboxDefault(status({ "acme-web": "workspace" }), "acme-web"),
    ).toBe("box");
  });

  test("this machine is the empty choice", () => {
    expect(
      newSessionSandboxDefault(status({ "acme-web": "none" }), "acme-web"),
    ).toBe("");
    expect(newSessionSandboxDefault(status({}, "none"), "acme-web")).toBe("");
    expect(newSessionSandboxDefault(null, "acme-web")).toBe("");
  });
});

// New Session preselects where a session starts: its own pick, else the
// project's sandbox, else the global default. The picker marks the same
// value "Default".
describe("newSessionSandboxPreselect", () => {
  const status = (
    repos: Record<string, string>,
    workspace = "daytona",
    ready = ["daytona", "box"],
  ) => ({
    defaults: { workspace, personal: "box", effective: "box", repos },
    connections: ready.map((provider) => ({ provider, state: "ready" })),
  });

  test("a project on the global default starts there, not on this machine", () => {
    const s = status({});
    expect(newSessionSandboxPreselect(s, "acme-web")).toBe("daytona");
    expect(newSessionSandboxPreselect(s, "acme-web")).toBe(
      newSessionSandboxDefault(s, "acme-web"),
    );
  });

  test("the project's own sandbox is marked and preselected", () => {
    const s = status({ "acme-web": "box" });
    expect(newSessionSandboxDefault(s, "acme-web")).toBe("box");
    expect(newSessionSandboxPreselect(s, "acme-web")).toBe("box");
  });

  test("a project set to this machine starts on this machine", () => {
    expect(
      newSessionSandboxPreselect(status({ "acme-web": "none" }), "acme-web"),
    ).toBe("");
  });

  test("a stored personal default has no effect", () => {
    const s = status({}, "none");
    expect(newSessionSandboxPreselect(s, "acme-web")).toBe("");
  });

  test("a default that isn't ready falls back to this machine", () => {
    const s = status({}, "daytona", ["box"]);
    expect(newSessionSandboxPreselect(s, "acme-web")).toBe("");
  });
});

describe("model overrides from the project documents", () => {
  test("every role a project sets is an override, not just You", () => {
    expect(
      modelOverridesFromDocuments([
        { project: "acme-web", models: { reviews: "pi/openai/gpt-5.5" } },
        { project: "acme-api", models: {} },
        {
          project: "docs-site",
          models: { you: "pi/anthropic/claude-sonnet-5", verifier: "" },
        },
      ]),
    ).toEqual({ "acme-web": ["reviews"], "docs-site": ["you"] });
  });

  test("a role the page can't know yet says so neutrally", () => {
    expect(roleScopeCopyFor("reviews", PROJECT_LIST, null)).toBe(
      "Used by every project that doesn't set its own",
    );
    expect(
      roleScopeCopyFor("reviews", PROJECT_LIST, { "acme-web": ["reviews"] }),
    ).toBe("acme-api and docs-site. acme-web sets its own");
  });
});
