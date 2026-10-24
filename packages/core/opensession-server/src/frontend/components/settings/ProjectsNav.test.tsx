// The projects in the Settings nav: one status phrase per project (the
// same one the Defaults page shows), the open project's sections under it,
// and touch-sized rows on a phone.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PROJECT_LIST } from "../../../shared/project-settings-fixtures";

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});

const { ProjectNavRows, ProjectSheetRows } = await import("./ProjectsNav");

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("each project carries its one phrase", () => {
  const html = renderToStaticMarkup(
    <ProjectNavRows
      projects={PROJECT_LIST}
      active={null}
      query=""
      onOpen={() => {}}
    />,
  );
  const text = textOf(html);
  expect(text).toContain("acme-web 4 of 6 ready");
  expect(text).toContain("acme-api Incidents off");
  expect(text).toContain("docs-site Incidents off");
  // No sections until a project is open.
  expect(text).not.toContain("Where agents run");
});

test("the open project lists its sections, the current one marked", () => {
  const html = renderToStaticMarkup(
    <ProjectNavRows
      projects={PROJECT_LIST}
      active={{ project: "acme-web", section: "access" }}
      query=""
      onOpen={() => {}}
    />,
  );
  const text = textOf(html);
  const order = [
    "acme-web",
    "Where agents run",
    "Models",
    "Production",
    "What agents may use",
    "Incidents",
    "acme-api",
  ].map((t) => text.indexOf(t));
  expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(
    true,
  );
  expect(html.match(/data-active="true"/g)).toHaveLength(1);
  expect(html).toMatch(/aria-current="location"[^>]*>What agents may use/);
});

test("a search narrows to matching projects and project sections", () => {
  const html = renderToStaticMarkup(
    <ProjectNavRows
      projects={PROJECT_LIST}
      active={null}
      query="veto"
      onOpen={() => {}}
    />,
  );
  const text = textOf(html);
  expect(text).toContain("acme-web · Incidents");
  expect(text).toContain("veto");
  expect(text).not.toContain("4 of 6 ready");

  const byName = textOf(
    renderToStaticMarkup(
      <ProjectNavRows
        projects={PROJECT_LIST}
        active={null}
        query="docs"
        onOpen={() => {}}
      />,
    ),
  );
  expect(byName).toContain("docs-site Incidents off");
  expect(byName).not.toContain("acme-web");
});

test("phone rows: the same phrase, 44px rows", () => {
  const html = renderToStaticMarkup(
    <ProjectSheetRows projects={PROJECT_LIST} query="" onOpen={() => {}} />,
  );
  expect(textOf(html)).toContain("acme-web 4 of 6 ready");
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) expect(button).toContain("min-h-11");
});

test("the current section scrolls again when clicked after scrolling away", async () => {
  const { find } = await import("../../tools/hook-harness");
  const { PlainButton } = await import("../../ui/plain-button");
  const scrolled: string[] = [];
  const opened: Array<[string, string | undefined]> = [];
  const realDocument = globalThis.document;
  Object.assign(globalThis, {
    document: {
      getElementById: (id: string) => ({
        scrollIntoView: () => scrolled.push(id),
      }),
    },
  });
  try {
    const tree = ProjectNavRows({
      projects: PROJECT_LIST,
      active: { project: "acme-web", section: "models" },
      query: "",
      onOpen: (project, section) => opened.push([project, section]),
    });
    const models = find(
      tree,
      PlainButton,
      (p: { children?: unknown }) => p.children === "Models",
    );
    (models!.props as { onClick: () => void }).onClick();
    expect(opened).toEqual([["acme-web", "models"]]);
    expect(scrolled).toEqual(["project-models"]);
  } finally {
    Object.assign(globalThis, { document: realDocument });
  }
});
