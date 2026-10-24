// Removing a signal exception can't be undone (there is no way to make a
// new one), so Remove asks first and only the confirm sends the patch.
import { afterEach, expect, mock, test } from "bun:test";
import type { ProjectSignalException } from "../../../../shared/project-settings";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));
mock.module("../../../hooks/useIncidents", () => ({
  useSignals: () => ({ data: [{ id: "sig-1", name: "Checkout errors" }] }),
}));
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({ ...realToast, toast: () => 0 }));

const { SignalExceptions } = await import("./SignalExceptions");
const { Button } = await import("../../../ui/button");
const { ConfirmDialog } = await import("../../../ui/confirm");

afterEach(() => harness.unmountAll());

const EXCEPTION: ProjectSignalException = {
  signalId: "sig-1",
  role: "investigator",
  fields: {} as ProjectSignalException["fields"],
  updatedBy: "sam",
  updatedAt: "2026-01-01T00:00:00Z",
};

test("Remove asks first; only the confirm sends the patch", async () => {
  const saved: unknown[] = [];
  const view = harness.mount(SignalExceptions, {
    exceptions: [EXCEPTION],
    onSave: async (body: unknown) => {
      saved.push(body);
    },
  });
  const remove = find(
    view.output(),
    Button,
    (p: { children?: unknown }) => p.children === "Remove",
  );
  (remove!.props as { onClick: () => void }).onClick();
  await settle();
  expect(saved).toEqual([]);
  const dialog = find(view.output(), ConfirmDialog);
  const request = dialog!.props.request!;
  expect(dialog!.props.open).toBe(true);
  expect(request.destructive).toBe(true);
  expect(String(request.title)).toContain("Checkout errors");
  request.onConfirm();
  await settle();
  expect(saved).toEqual([
    {
      access: {
        removeSignalExceptions: [{ signalId: "sig-1", role: "investigator" }],
      },
    },
  ]);
});
