// Connecting a sandbox from the checklist: a missing key says so under the
// key field, tied to it; the global default is set only once the
// connection check has passed.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type * as React from "react";
import type { ProjectDefaultsPatch } from "../../../../shared/project-settings";
import {
  createHookHarness,
  elements,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));
const toasts: string[] = [];
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({
  ...realToast,
  toast: (message: string) => toasts.push(message),
}));

// The check: "checking" until the test says how it ended.
let checkState: "checking" | "ready" | "needs_attention" = "checking";
const defaultsPatches: unknown[] = [];
const connection = () => ({
  provider: "daytona",
  state: checkState,
  qualification: { failureSummary: "The API key was refused" },
});
mock.module("../../../lib/api/sandboxes", () => ({
  connectSandbox: async () => ({ connections: [connection()] }),
  fetchSandboxConnections: async () => ({ connections: [connection()] }),
}));
const realProjectsApi = await import("../../../lib/api/projects");
mock.module("../../../lib/api/projects", () => ({
  ...realProjectsApi,
  patchProjectDefaults: async (patch: ProjectDefaultsPatch) => {
    defaultsPatches.push(patch);
    return {};
  },
}));
let finishCheck: () => void = () => {};
mock.module("../../../lib/project-settings/connect", () => ({
  waitForConnection: async () => {
    await new Promise<void>((resolve) => (finishCheck = resolve));
    return connection();
  },
}));

const { ConnectSandboxForm } = await import("./ConnectSandboxForm");
const { Input } = await import("../../../ui/input");

afterEach(() => harness.unmountAll());
beforeEach(() => {
  checkState = "checking";
  defaultsPatches.length = 0;
  toasts.length = 0;
});

/** Type a key and press Connect. */
async function connect(form: ReturnType<typeof mountForm>) {
  const input = find(form.output(), Input)!;
  // SAFETY: the key field's handler reads only currentTarget.value.
  input.props.onChange!({
    currentTarget: { value: "dtn_key" },
  } as React.ChangeEvent<HTMLInputElement>);
  await settle();
  const el = find(form.output(), "form")!;
  // SAFETY: the form's submit handler reads only preventDefault.
  (el.props as { onSubmit: (e: { preventDefault(): void }) => void }).onSubmit({
    preventDefault() {},
  });
  await settle();
}

test("the global default is set only once the check passes", async () => {
  const form = mountForm();
  await connect(form);
  expect(defaultsPatches).toEqual([]);
  checkState = "ready";
  finishCheck();
  await settle(20);
  expect(defaultsPatches).toEqual([{ sandbox: "daytona" }]);
  expect(toasts.at(-1)).toBe("Daytona is connected");
});

test("a failed check sets nothing and says why", async () => {
  const form = mountForm();
  await connect(form);
  checkState = "needs_attention";
  finishCheck();
  await settle(20);
  expect(defaultsPatches).toEqual([]);
  expect(toasts.at(-1)).toContain("The API key was refused");
});

const mountForm = () =>
  harness.mount(ConnectSandboxForm, {
    hasGlobalDefault: false,
    onConnected: () => {},
  });

test("a missing key is said under the key field and tied to it", async () => {
  const form = mountForm();
  const el = find(form.output(), "form")!;
  // SAFETY: the form's submit handler reads only preventDefault.
  (el.props as { onSubmit: (e: { preventDefault(): void }) => void }).onSubmit({
    preventDefault() {},
  });
  await settle();
  const input = find(form.output(), Input)!;
  const described = input.props["aria-describedby"];
  expect(described).toBeTruthy();
  expect(input.props["aria-invalid"]).toBe(true);
  const error = elements(form.output()).find(
    // SAFETY: reading an optional id off any element's props.
    (e) => (e.props as { id?: string }).id === described,
  );
  expect(JSON.stringify(error?.props)).toContain("Paste your Daytona API key");
});
