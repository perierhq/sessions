// Which providers the default pickers offer. A Ready connection the server
// has not certified (today, This machine (container)) is refused on create,
// so no picker may offer it. The rows' own hooks run in the hook harness.
import { afterEach, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import type { SandboxStatusInfo } from "../../lib/api";
import {
  createHookHarness,
  elements,
  reactWithHarness,
  settle,
} from "../../tools/hook-harness";

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

let status: SandboxStatusInfo;
const realApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
  ...realApi,
  fetchSandboxStatus: async () => status,
}));
const realRepos = await import("../../lib/api/repos");
mock.module("../../lib/api/repos", () => ({
  ...realRepos,
  fetchRepos: async () => [{ id: "acme/app", label: "app" }],
}));

const { PersonalSandboxDefaultRow, WorkspaceSandboxDefaults } =
  await import("./SandboxDefaults");
const { Select } = await import("./shared");

afterEach(() => harness.unmountAll());

const sandboxStatus = (podmanCertified: boolean): SandboxStatusInfo => ({
  enabled: true,
  defaultProvider: "daytona",
  killSwitch: false,
  providers: [
    { id: "daytona", configured: true, certified: true },
    { id: "podman", configured: true, certified: podmanCertified },
  ],
  connections: [
    { provider: "daytona", state: "ready" },
    { provider: "podman", state: "ready" },
  ] as SandboxStatusInfo["connections"],
  defaults: {
    workspace: "none",
    personal: "workspace",
    effective: "none",
    repos: {},
    portals: {},
  },
});

/** Mount the first function component in `tree` and let its effects land. */
async function mountChild(
  tree: ReturnType<typeof harness.mount>,
  name: string,
) {
  const child = elements(tree.output()).find(
    (el) => typeof el.type === "function" && el.type.name === name,
  );
  if (!child) throw new Error(`No ${name}`);
  // SAFETY: a function component element, mounted with its own props.
  const type = child.type as (props: object) => ReactElement;
  const mounted = harness.mount(type, child.props);
  await settle();
  return mounted;
}

const selectValues = (tree: ReturnType<typeof harness.mount>) =>
  elements(tree.output())
    .filter((el) => el.type === Select)
    .map((el) => ({
      // SAFETY: Select elements carry the OptionSelect props.
      label: (el.props as { label: string }).label,
      values: (el.props as { options: Array<{ value: string }> }).options.map(
        (option) => option.value,
      ),
    }));

test("the personal default hides an uncertified Ready provider", async () => {
  status = sandboxStatus(false);
  const row = await mountChild(
    harness.mount(PersonalSandboxDefaultRow, {}),
    "SandboxDefaultRow",
  );
  expect(selectValues(row)).toEqual([
    {
      label: "Personal default environment",
      values: ["workspace", "none", "daytona"],
    },
  ]);
});

test("the workspace and project defaults hide an uncertified Ready provider", async () => {
  status = sandboxStatus(false);
  const page = harness.mount(WorkspaceSandboxDefaults, {});
  const workspace = await mountChild(page, "SandboxDefaultRow");
  expect(selectValues(workspace)).toEqual([
    { label: "Workspace default environment", values: ["none", "daytona"] },
  ]);
  const projects = await mountChild(page, "ProjectSandboxDefaults");
  expect(selectValues(projects)).toEqual([
    {
      label: "app default environment",
      values: ["workspace", "none", "daytona"],
    },
    { label: "app Portal environment", values: ["none", "daytona"] },
  ]);
});

test("a certified Ready provider is offered", async () => {
  status = sandboxStatus(true);
  const row = await mountChild(
    harness.mount(PersonalSandboxDefaultRow, {}),
    "SandboxDefaultRow",
  );
  expect(selectValues(row)[0]?.values).toEqual([
    "workspace",
    "none",
    "daytona",
    "podman",
  ]);
});

test("New session reads Ready providers only through readySandboxProviders", async () => {
  // NewSession is too large to mount here; its picker and the project
  // default it follows must share the filter tested in
  // lib/ready-sandbox-providers.test.ts rather than copy it.
  const source = await Bun.file(
    new URL("../NewSession.tsx", import.meta.url),
  ).text();
  expect(source).not.toContain('connection.state === "ready"');
  expect(source).not.toContain("p.configured && p.certified");
  expect(source.match(/readySandboxProviders\(sandboxStatus\)/g)).toHaveLength(
    2,
  );
});
