// The Project field of the automation form, as markup: a picker when there is
// more than one project, the project's name when there is only one, and the
// place line under it following whichever project is picked. The hooks it
// reads are mocked; nothing fetches during a static render.
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunPlace } from "../../shared/project-settings";

const PLACES = new Map<string, RunPlace>([
  [
    "acme-web",
    {
      state: "ok",
      provider: "daytona",
      label: "Daytona eu",
      source: "default",
    },
  ],
  [
    "acme-api",
    {
      state: "ok",
      provider: "podman",
      label: "This machine",
      source: "project",
    },
  ],
]);

mock.module("../hooks/useSettingsResources", () => ({
  useRepoList: () => ({ data: undefined }),
}));
mock.module("../hooks/useProjects", () => ({
  useProjectSettings: (project: string | null) => ({
    data: project
      ? { effective: { sandbox: { automations: PLACES.get(project) } } }
      : undefined,
  }),
}));
mock.module("../hooks/useNavigation", () => ({
  useNavigation: () => ({ openProjectSettings: () => {} }),
}));

const { AutomationProjectField } = await import("./AutomationProject");

const TWO = [
  {
    id: "acme-web",
    default: true,
    defaultBranch: "main",
    sharedCheckout: false,
  },
  { id: "acme-api", defaultBranch: "main", sharedCheckout: false },
];

function render(props: {
  value: string | null;
  repos: typeof TWO | undefined;
  sandbox?: boolean;
}): string {
  return renderToStaticMarkup(
    <AutomationProjectField
      value={props.value}
      repos={props.repos}
      sandbox={props.sandbox ?? false}
      onChange={() => {}}
    />,
  );
}

describe("AutomationProjectField", () => {
  test("more than one project: a picker labelled Project", () => {
    const html = render({ value: "acme-web", repos: TWO });
    expect(html).toContain(">Project<");
    expect(html).toContain('aria-label="Project"');
    expect(html).toContain("acme-web");
  });

  test("the place line follows the picked project", () => {
    expect(render({ value: "acme-web", repos: TWO })).toContain(
      "Runs on Daytona eu. Set in acme-web → Where agents run",
    );
    expect(render({ value: "acme-api", repos: TWO })).toContain(
      "Runs on This machine. Set in acme-api → Where agents run",
    );
  });

  test("one project: its name as text, no picker", () => {
    const html = render({ value: "acme-web", repos: [TWO[0]!] });
    expect(html).toContain(">Project<");
    expect(html).not.toContain('aria-label="Project"');
    expect(html).toContain("acme-web");
    expect(html).toContain("Runs on Daytona eu");
  });

  test("a kept disposable sandbox shows its place as before", () => {
    const html = render({ value: "acme-api", repos: TWO, sandbox: true });
    expect(html).toContain(
      "Disposable sandbox (set before projects had their own)",
    );
  });
});
