// The global Defaults page: one phrase per project, per-control saves, the
// websites list checked before it is sent, and touch-sized controls. The
// panel's own hooks run in the hook harness; children are read, not
// rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  DEFAULTS_VIEW,
  PROJECT_LIST,
} from "../../../shared/project-settings-fixtures";
import type {
  ProjectDefaultsPatch,
  ProjectDefaultsView,
} from "../../../shared/project-settings";
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

let view: ProjectDefaultsView = DEFAULTS_VIEW;
const mutations: unknown[] = [];
mock.module("../../hooks/useProjects", () => ({
  useProjectDefaults: () => ({
    data: view,
    error: undefined,
    isLoading: false,
    mutate: (next?: unknown) => {
      mutations.push(next);
      if (next && typeof next === "object") {
        // SAFETY: the panel only ever mutates with a whole view.
        view = next as ProjectDefaultsView;
      }
      return Promise.resolve(view);
    },
  }),
}));

const patches: ProjectDefaultsPatch[] = [];
let patchError: Error | null = null;
const realProjectsApi = await import("../../lib/api/projects");
mock.module("../../lib/api/projects", () => ({
  ...realProjectsApi,
  patchProjectDefaults: async (patch: ProjectDefaultsPatch) => {
    patches.push(patch);
    if (patchError) throw patchError;
    return { ...view, ...patch, models: { ...view.models, ...patch.models } };
  },
}));

const catalog = {
  default: "pi/anthropic/claude-opus-5-5",
  models: [
    {
      id: "pi/anthropic/claude-opus-5-5",
      provider: "pi",
      label: "Opus 5.5",
      aliases: [],
      efforts: [],
    },
    {
      id: "pi/anthropic/claude-sonnet-5",
      provider: "pi",
      label: "Sonnet 5",
      aliases: [],
      efforts: [],
    },
    {
      id: "pi/openai/gpt-5.5",
      provider: "pi",
      label: "GPT-5.5",
      aliases: [],
      efforts: [],
    },
  ],
};
const sandboxStatus = {
  enabled: true,
  providers: [
    { id: "daytona", configured: true, certified: true },
    { id: "podman", configured: true, certified: true },
  ],
  connections: [
    { provider: "daytona", state: "ready", settings: { region: "eu" } },
    { provider: "podman", state: "ready", settings: {} },
  ],
};
mock.module("swr", () => ({
  default: (key: unknown) => {
    const name = Array.isArray(key) ? String(key[1]) : "";
    if (name.includes("models")) return { data: catalog };
    if (name.includes("sandbox")) return { data: sandboxStatus };
    return { data: undefined };
  },
}));

const toasts: string[] = [];
const realToast = await import("../../ui/toast");
mock.module("../../ui/toast", () => ({
  ...realToast,
  toast: (message: string) => {
    toasts.push(message);
    return toasts.length;
  },
}));

const { DefaultsPanel } = await import("./DefaultsPanel");
const { OptionSelect, Select } = await import("../../ui/select");
const { Button } = await import("../../ui/button");
const { Input } = await import("../../ui/input");
const { SettingLinkRow } = await import("./incidents/SettingLinkRow");

const opened: string[] = [];

beforeEach(() => {
  view = DEFAULTS_VIEW;
  patches.length = 0;
  mutations.length = 0;
  toasts.length = 0;
  opened.length = 0;
  patchError = null;
});
afterEach(() => harness.unmountAll());

async function mountPanel() {
  const panel = harness.mount(DefaultsPanel, {
    onOpenProject: (id: string) => opened.push(id),
  });
  await settle();
  return panel;
}

type Tree = ReturnType<typeof harness.mount>;

function selectByLabel(tree: Tree, label: string) {
  const el = elements(tree.output()).find(
    (e) =>
      e.type === OptionSelect &&
      (e.props as { label?: string }).label === label,
  );
  if (!el) throw new Error(`No select ${label}`);
  // SAFETY: an element whose type is OptionSelect carries its props.
  return el.props as {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (v: string) => void;
  };
}

function text(tree: Tree): string {
  const out: string[] = [];
  for (const el of elements(tree.output())) {
    const children = (el.props as { children?: unknown }).children;
    for (const c of [children].flat()) {
      if (typeof c === "string" || typeof c === "number") out.push(String(c));
    }
    for (const key of ["title", "value", "description", "desc"]) {
      const v = (el.props as Record<string, unknown>)[key];
      if (typeof v === "string") out.push(v);
    }
  }
  return out.join("\n");
}

test("one row per project, with the nav's phrase", async () => {
  const tree = await mountPanel();
  const rows = elements(tree.output())
    .filter((e) => e.type === SettingLinkRow)
    // SAFETY: SettingLinkRow elements carry its props.
    .map((e) => e.props as { value?: unknown; onClick: () => void });
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.value)).toEqual(
    PROJECT_LIST.map((p) => p.status.label),
  );
  rows[0]!.onClick();
  expect(opened).toEqual(["acme-web"]);
});

test("changing a role's model saves just that role", async () => {
  const tree = await mountPanel();
  const select = selectByLabel(tree, "Automations default model");
  expect(select.value).toBe("pi/anthropic/claude-sonnet-5");
  select.onChange("pi/openai/gpt-5.5");
  await settle();
  expect(patches).toEqual([{ models: { automations: "pi/openai/gpt-5.5" } }]);
});

test("a failed save says why and reloads", async () => {
  const { ApiError } = await import("../../lib/api/request");
  patchError = new ApiError("Pick a different model for the verifier", 400);
  const tree = await mountPanel();
  selectByLabel(tree, "Verifier default model").onChange(
    "pi/anthropic/claude-opus-5-5",
  );
  await settle();
  expect(toasts).toEqual(["Pick a different model for the verifier"]);
  expect(mutations.at(-1)).toBeUndefined();
});

test("a 403 asks for a signed-in person", async () => {
  const { ApiError } = await import("../../lib/api/request");
  patchError = new ApiError("Forbidden", 403);
  const tree = await mountPanel();
  selectByLabel(tree, "Previews").onChange("daytona");
  await settle();
  expect(toasts).toEqual(["Only a signed-in person can change this"]);
});

function websiteInput(tree: Tree) {
  const el = elements(tree.output()).find(
    (e) =>
      e.type === Input &&
      (e.props as { "aria-label"?: string })["aria-label"] === "Website",
  );
  if (!el) throw new Error("No website input");
  // SAFETY: Input elements carry input props.
  return el.props as {
    onChange: (e: { target: { value: string } }) => void;
  };
}

function websiteForm(tree: Tree) {
  const el = elements(tree.output()).find((e) => e.type === "form");
  if (!el) throw new Error("No website form");
  // SAFETY: a form element's props.
  return el.props as { onSubmit: (e: { preventDefault(): void }) => void };
}

test("a website that isn't one shows an error and sends nothing", async () => {
  const tree = await mountPanel();
  websiteInput(tree).onChange({ target: { value: "bad host" } });
  await settle();
  websiteForm(tree).onSubmit({ preventDefault() {} });
  await settle();
  expect(patches).toEqual([]);
  expect(text(tree)).toContain("Enter a website name");
});

test("adding a website sends the whole list", async () => {
  const tree = await mountPanel();
  websiteInput(tree).onChange({ target: { value: "status.example.test" } });
  await settle();
  websiteForm(tree).onSubmit({ preventDefault() {} });
  await settle();
  expect(patches).toEqual([
    { websites: ["api.example.test", "status.example.test"] },
  ]);
});

test("the sandbox row reads the server's sentence verbatim", async () => {
  view = {
    ...DEFAULTS_VIEW,
    sandbox: "podman",
    sandboxUsedBy: "Used by acme-api, docs-site, and acme-web",
  };
  const tree = await mountPanel();
  const all = text(tree);
  expect(all).toContain("Used by acme-api, docs-site, and acme-web");
  expect(all).not.toContain("incident agents");
  expect(all).toContain("Automations can't run on this machine");
});

test("the sandbox options: this machine, the container, ready providers", async () => {
  const tree = await mountPanel();
  const root = elements(tree.output()).find((e) => e.type === Select.Root);
  // SAFETY: Select.Root carries `items`.
  const items = (root!.props as { items: Array<{ value: string }> }).items;
  expect(items.map((i) => i.value)).toEqual(["none", "podman", "daytona"]);
});

test("every button and select trigger is a 44px target on a phone", async () => {
  const tree = await mountPanel();
  const controls = elements(tree.output()).filter(
    (e) =>
      e.type === "button" ||
      e.type === Button ||
      e.type === OptionSelect ||
      e.type === Select.Trigger,
  );
  expect(controls.length).toBeGreaterThan(5);
  for (const el of controls) {
    const className = String(
      (el.props as { className?: string }).className ?? "",
    );
    expect(
      className.includes("min-h-11") || className.includes("before:"),
    ).toBe(true);
  }
});
