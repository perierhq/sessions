// The drift notice: says what happened once, and its button migrates every
// project on this instance, so it confirms first and shows it is working
// until the run answers (a double click sends one run).
import { afterEach, expect, mock, test } from "bun:test";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({ ...realToast, toast: () => 0 }));

const { DriftNotice } = await import("./DriftNotice");
const { Button } = await import("../../../ui/button");
const { ConfirmDialog } = await import("../../../ui/confirm");

afterEach(() => harness.unmountAll());

const text = (tree: unknown) =>
  JSON.stringify(tree, (key, value) => (key.startsWith("_") ? undefined : value));

test("one message, a confirm that names every project, then busy", async () => {
  let runs = 0;
  let finish: () => void = () => {};
  const notice = harness.mount(DriftNotice, {
    onMigrate: () => {
      runs++;
      return new Promise<void>((resolve) => (finish = resolve));
    },
  });
  expect(text(notice.output())).toContain(
    "Settings changed during the upgrade",
  );
  expect(text(notice.output()).match(/Migrate/g)?.length).toBe(1);

  const button = () => find(notice.output(), Button)!;
  (button().props as { onClick: () => void }).onClick();
  await settle();
  expect(runs).toBe(0);
  const request = find(notice.output(), ConfirmDialog)!.props.request!;
  expect(String(request.title)).toContain("all projects");

  request.onConfirm();
  await settle();
  expect(runs).toBe(1);
  expect(button().props.disabled).toBe(true);
  expect(text(button().props.children)).toContain("Migrating");

  finish();
  await settle();
  expect(button().props.disabled).toBeFalsy();
});
