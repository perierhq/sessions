// What the project page sends: a cell click becomes one patch at the loaded
// revision, and a stale revision refetches, re-sends the same cell once and
// says so. The page's own hooks run in the hook harness; its sections are
// read from the element tree, not rendered.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AccessCellChange,
  ProjectSettingsPatch,
  ProjectSettingsView,
} from "../../../../shared/project-settings";
import {
  DEFAULTS_VIEW,
  READY_4_OF_6,
} from "../../../../shared/project-settings-fixtures";
import { ApiError } from "../../../lib/api/request";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    dispatchEvent: () => true,
    location: { assign: () => {} },
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

let phone = false;
mock.module("../../../hooks/useIsPhone", () => ({ useIsPhone: () => phone }));

// The cached view, as SWR's bound `mutate` treats it.
let cached: ProjectSettingsView = READY_4_OF_6;
let onServer: ProjectSettingsView = READY_4_OF_6;
let refetches = 0;
type Updater = (v?: ProjectSettingsView) => ProjectSettingsView | undefined;
const mutate = async (next?: ProjectSettingsView | Updater) => {
  if (next === undefined) {
    refetches++;
    cached = onServer;
  } else if (next instanceof Function) {
    cached = next(cached) ?? cached;
  } else cached = next;
  return cached;
};
const revalidations: Array<readonly unknown[] | undefined> = [];
mock.module("../../../hooks/useProjects", () => ({
  projectSWRKey: {
    projects: () => ["api", "projects"],
    projectSettings: (project: string) => ["api", "project-settings", project],
    projectDefaults: () => ["api", "project-defaults"],
  },
  revalidateProjects: (except?: readonly unknown[]) => {
    revalidations.push(except);
  },
  useProjectSettings: () => ({ data: cached, error: undefined, mutate }),
  useProjectDefaults: () => ({
    data: DEFAULTS_VIEW,
    error: undefined,
    mutate: async () => DEFAULTS_VIEW,
  }),
}));

const patches: ProjectSettingsPatch[] = [];
let respond: (patch: ProjectSettingsPatch) => ProjectSettingsView = () =>
  onServer;
/** A response that waits, when set. */
let respondLater: (() => Promise<ProjectSettingsView>) | null = null;
mock.module("../../../lib/api/projects", () => ({
  ApiError,
  patchProjectSettings: async (_: string, patch: ProjectSettingsPatch) => {
    patches.push(patch);
    return respondLater ? respondLater() : respond(patch);
  },
  allowAgentsOnConnector: async () => ({ ok: true }),
  migrateProjects: async () => ({}),
  bindProjectRunner: async () => onServer,
  patchProjectDefaults: async () => DEFAULTS_VIEW,
}));

const toasts: Array<{ message: string; variant?: string }> = [];
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({
  ...realToast,
  toast: (message: string, options?: { variant?: string }) => {
    toasts.push({ message, variant: options?.variant });
    return toasts.length;
  },
}));

const { ProjectSettingsPage } = await import("./ProjectSettingsPage");
const { AccessSection } = await import("./AccessSection");
const { AccessRoleList } = await import("./AccessRoleList");
const { AccessTable } = await import("./AccessTable");
const { ProductionSection } = await import("./ProductionSection");
const { IncidentsSection } = await import("./IncidentsSection");
const { nextCellValue } =
  await import("../../../lib/project-settings/page-model");

const LINEAR_REVIEWS: AccessCellChange = {
  row: { kind: "connection", server: "linear" },
  role: "reviews",
  value: false,
};

function at(revision: number): ProjectSettingsView {
  return { ...READY_4_OF_6, document: { ...READY_4_OF_6.document, revision } };
}

beforeEach(() => {
  cached = READY_4_OF_6;
  onServer = READY_4_OF_6;
  refetches = 0;
  patches.length = 0;
  toasts.length = 0;
  phone = false;
  respond = () => onServer;
  respondLater = null;
  revalidations.length = 0;
});
afterEach(() => harness.unmountAll());

const mountPage = () =>
  harness.mount(ProjectSettingsPage, {
    project: "acme-web",
    onOpenSection: () => {},
  });

function clickCell(tree: ReturnType<ReturnType<typeof mountPage>["output"]>) {
  const section = find(tree, AccessSection);
  if (!section) throw new Error("No access section");
  section.props.onCellChange(LINEAR_REVIEWS);
}

describe("saving a cell", () => {
  test("Linear for Reviews sends one patch at the loaded revision", async () => {
    respond = () => at(5);
    const page = mountPage();
    clickCell(page.output());
    await settle(40);
    expect(patches).toEqual([
      {
        expectedRevision: READY_4_OF_6.document.revision,
        access: { cells: [LINEAR_REVIEWS] },
      },
    ]);
    expect(cached.document.revision).toBe(5);
    expect(toasts).toEqual([]);
  });

  test("a saved cell refreshes the project list, other pages and defaults", async () => {
    respond = () => at(5);
    const page = mountPage();
    clickCell(page.output());
    await settle(40);
    expect(revalidations).toEqual([["api", "project-settings", "acme-web"]]);
  });

  test("the cell reads – before the server answers", async () => {
    let release: (v: ProjectSettingsView) => void = () => {};
    const pending = new Promise<ProjectSettingsView>((r) => (release = r));
    respondLater = () => pending;
    const page = mountPage();
    clickCell(page.output());
    await settle(10);
    const linear = cached.access.groups
      .flatMap((g) => g.rows)
      .find((r) => r.title === "Linear");
    expect(linear?.cells.reviews.value).toBe("no");
    release(at(5));
    await settle(20);
    expect(cached.document.revision).toBe(5);
  });

  test("a 409 refetches, re-sends the cell once and toasts", async () => {
    onServer = at(9);
    respond = (patch) => {
      if (patch.expectedRevision === READY_4_OF_6.document.revision)
        throw new ApiError("Settings changed since you loaded them", 409);
      return at(10);
    };
    const page = mountPage();
    clickCell(page.output());
    await settle(60);
    expect(refetches).toBeGreaterThanOrEqual(1);
    expect(patches).toEqual([
      {
        expectedRevision: READY_4_OF_6.document.revision,
        access: { cells: [LINEAR_REVIEWS] },
      },
      { expectedRevision: 9, access: { cells: [LINEAR_REVIEWS] } },
    ]);
    expect(toasts).toEqual([
      { message: "Settings changed since you loaded them", variant: undefined },
    ]);
    expect(cached.document.revision).toBe(10);
  });

  test("a stale action list refetches and is refused, not re-sent", async () => {
    onServer = at(9);
    respond = () => {
      throw new ApiError("Settings changed since you loaded them", 409);
    };
    const page = mountPage();
    const production = find(page.output(), ProductionSection);
    if (!production) throw new Error("No production section");
    const actions = READY_4_OF_6.document.production.actions;
    const saved = production.props.onSave({ production: { actions } });
    await expect(saved).rejects.toThrow(
      "Settings changed since you loaded them",
    );
    await settle(20);
    expect(patches).toHaveLength(1);
    expect(refetches).toBe(1);
    expect(cached.document.revision).toBe(9);
    expect(toasts).toEqual([]);
  });

  test("a refusal toasts and reloads the settings", async () => {
    respond = () => {
      throw new ApiError("Only a signed-in person can change this", 403);
    };
    const page = mountPage();
    clickCell(page.output());
    await settle(40);
    expect(toasts).toEqual([
      { message: "Only a signed-in person can change this", variant: "error" },
    ]);
    expect(refetches).toBe(1);
  });
});

const linearRow = (view: ProjectSettingsView) =>
  view.access.groups.flatMap((g) => g.rows).find((r) => r.title === "Linear")!;

describe("saves waiting their turn", () => {
  test("a second change paints at once, before the first save answers", async () => {
    let release: (v: ProjectSettingsView) => void = () => {};
    const first = new Promise<ProjectSettingsView>((r) => (release = r));
    respondLater = () => first;
    const page = mountPage();
    clickCell(page.output());
    // The same cell again, worked out from what the page now shows.
    page.update({ project: "acme-web", onOpenSection: () => {} });
    const view = find(page.output(), AccessSection)!.props.view;
    const again = nextCellValue(
      LINEAR_REVIEWS.row,
      "reviews",
      linearRow(view).cells.reviews,
    );
    expect(again?.value).not.toBe(LINEAR_REVIEWS.value);
    find(page.output(), AccessSection)!.props.onCellChange(again!);
    await settle(10);
    // Painted back, though only the first save has been sent.
    expect(patches).toHaveLength(1);
    expect(linearRow(cached).cells.reviews.value).toBe("yes");
    release(at(5));
    await settle(40);
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({
      expectedRevision: 5,
      access: { cells: [again!] },
    });
  });

  test("the waiting change stays painted over the first answer", async () => {
    let release: (v: ProjectSettingsView) => void = () => {};
    const first = new Promise<ProjectSettingsView>((r) => (release = r));
    let calls = 0;
    respondLater = () => (calls++ === 0 ? first : new Promise(() => {}));
    const page = mountPage();
    clickCell(page.output());
    const pause = find(page.output(), IncidentsSection)!;
    void pause.props.onSave({ incidents: { agentsPaused: true } });
    await settle(10);
    expect(cached.document.incidents.agentsPaused).toBe(true);
    release(at(5));
    await settle(20);
    expect(cached.document.revision).toBe(5);
    expect(cached.document.incidents.agentsPaused).toBe(true);
  });
});

describe("phone and desktop", () => {
  test("a phone gets the role list, a desktop the table", () => {
    const props = {
      view: READY_4_OF_6,
      adding: null,
      onAddingChange: () => {},
      onCellChange: () => {},
      onAllowAgents: () => {},
      onSave: async () => {},
    };
    phone = true;
    const onPhone = harness.mount(AccessSection, props);
    expect(find(onPhone.output(), AccessRoleList)).toBeDefined();
    expect(find(onPhone.output(), AccessTable)).toBeUndefined();
    phone = false;
    const onDesktop = harness.mount(AccessSection, props);
    expect(find(onDesktop.output(), AccessTable)).toBeDefined();
  });
});
