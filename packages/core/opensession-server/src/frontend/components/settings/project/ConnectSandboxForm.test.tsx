// Connecting a sandbox from the checklist: a missing key says so under the
// key field, tied to it; the global default is set only once the
// connection check has passed.
import { afterEach, expect, mock, test } from "bun:test";
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
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({ ...realToast, toast: () => 0 }));

const { ConnectSandboxForm } = await import("./ConnectSandboxForm");
const { Input } = await import("../../../ui/input");

afterEach(() => harness.unmountAll());

const mountForm = () =>
  harness.mount(ConnectSandboxForm, {
    hasGlobalDefault: false,
    onConnected: () => {},
  });

test("a missing key is said under the key field and tied to it", async () => {
  const form = mountForm();
  const el = find(form.output(), "form")!;
  (el.props as { onSubmit: (e: { preventDefault(): void }) => void }).onSubmit(
    { preventDefault() {} },
  );
  await settle();
  const input = find(form.output(), Input)!;
  const described = input.props["aria-describedby"];
  expect(described).toBeTruthy();
  expect(input.props["aria-invalid"]).toBe(true);
  const error = elements(form.output()).find(
    (e) => (e.props as { id?: string }).id === described,
  );
  expect(JSON.stringify(error?.props)).toContain("Paste your Daytona API key");
});
