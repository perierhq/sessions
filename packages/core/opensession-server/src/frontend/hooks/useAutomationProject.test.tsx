// The project an automation form is on, and what follows from it: the
// default model the project gives automations, and the `repo` the save sends.
// The hooks it reads are mocked; nothing fetches during a static render.
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let repos: Array<{ id: string; default?: boolean }> | undefined;
let lens = "all";
const MODELS = new Map([
  ["acme-web", "Opus 5"],
  ["acme-api", "Sonnet 5"],
]);

mock.module("./useSettingsResources", () => ({
  useRepoList: () => ({ data: repos }),
}));
mock.module("./useProjects", () => ({
  useProjectSettings: (project: string | null) => ({
    data: project
      ? {
          effective: {
            models: { automations: { label: MODELS.get(project) } },
          },
        }
      : undefined,
  }),
}));
mock.module("../lib/sidebar-filter", () => ({
  useSidebarFilter: () => ({ repo: lens }),
}));

const { useAutomationProject } = await import("./useAutomationProject");

function Probe({
  initial,
  prefillRepo,
}: {
  initial: { repo?: string; sandbox?: boolean } | null;
  prefillRepo?: string;
}) {
  const state = useAutomationProject(initial, prefillRepo);
  return (
    <output>
      {JSON.stringify({
        project: state.project,
        projectModel: state.projectModel ?? null,
        payload: state.repoPayload(),
      })}
    </output>
  );
}

function read(
  initial: { repo?: string; sandbox?: boolean } | null,
  prefillRepo?: string,
) {
  const html = renderToStaticMarkup(
    <Probe initial={initial} prefillRepo={prefillRepo} />,
  );
  // SAFETY: Probe renders exactly this JSON shape and nothing else.
  return JSON.parse(
    html.replace(/^<output>|<\/output>$/g, "").replaceAll("&quot;", '"'),
  ) as {
    project: string | null;
    projectModel: string | null;
    payload: { repo?: string };
  };
}

describe("useAutomationProject", () => {
  test("a new automation starts on the project the person is in", () => {
    repos = [{ id: "acme-web", default: true }, { id: "acme-api" }];
    lens = "acme-api";
    expect(read(null)).toEqual({
      project: "acme-api",
      projectModel: "Sonnet 5",
      payload: { repo: "acme-api" },
    });
  });

  test("with no project in view, the default project and its model", () => {
    repos = [{ id: "acme-web", default: true }, { id: "acme-api" }];
    lens = "all";
    expect(read(null)).toEqual({
      project: "acme-web",
      projectModel: "Opus 5",
      payload: { repo: "acme-web" },
    });
  });

  test("a draft that names a project starts there", () => {
    repos = [{ id: "acme-web", default: true }, { id: "acme-api" }];
    lens = "all";
    expect(read(null, "acme-api").project).toBe("acme-api");
  });

  test("editing keeps the automation's project and sends nothing new", () => {
    repos = [{ id: "acme-web", default: true }, { id: "acme-api" }];
    lens = "acme-web";
    expect(read({ repo: "acme-api" })).toEqual({
      project: "acme-api",
      projectModel: "Sonnet 5",
      payload: {},
    });
  });

  test("a kept disposable sandbox still reads its project's model", () => {
    repos = [{ id: "acme-web", default: true }, { id: "acme-api" }];
    expect(read({ repo: "acme-api", sandbox: true }).projectModel).toBe(
      "Sonnet 5",
    );
  });
});
