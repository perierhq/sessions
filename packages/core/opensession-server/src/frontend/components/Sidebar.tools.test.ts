import { expect, test } from "bun:test";

const sidebarSource = await Bun.file(
  new URL("./Sidebar.tsx", import.meta.url),
).text();
const sidebarChromeSource = await Bun.file(
  new URL("./sidebar/SidebarChrome.tsx", import.meta.url),
).text();
const toolsNavSource = await Bun.file(
  new URL("./sidebar/SidebarToolsNav.tsx", import.meta.url),
).text();

test("the tools nav owns tool-row rendering", () => {
  expect(sidebarSource).toContain("<SidebarChrome");
  expect(sidebarChromeSource).toContain("<SidebarToolsNav");
  expect(sidebarSource).not.toContain("{visibleTools.map((tool)");
  expect(toolsNavSource).toContain("{listed.map((tool)");
  // A short viewport folds the strip behind a More row; the rows still
  // render here, from the same tools.
  expect(toolsNavSource).toContain("foldSidebarTools(tools");
  expect(toolsNavSource).toContain("<OrganizationSwitcher");
  expect(toolsNavSource).toContain("<SidebarToolRows");
  expect(toolsNavSource).toContain("<TeamLensMenu");
});
