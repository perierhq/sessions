// The drift notice: says what happened once, and its button re-runs the
// migration for this project only, replacing its settings after a backup, so
// it confirms first, shows it is working until the run answers (a double
// click sends one run) and then says what happened.
import { afterEach, expect, mock, test } from "bun:test";
import type * as React from "react";
import type { ProjectRemigrateResult } from "../../../../shared/project-settings";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));
const toasts: Array<{ message: string; variant?: string }> = [];
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({
  ...realToast,
  toast: (message: string, options?: { variant?: string }) => {
    toasts.push({ message, variant: options?.variant });
    return toasts.length;
  },
}));

const { DriftNotice } = await import("./DriftNotice");
const { Button } = await import("../../../ui/button");
const { ConfirmDialog } = await import("../../../ui/confirm");

afterEach(() => {
  harness.unmountAll();
  toasts.length = 0;
});

const RESULT: ProjectRemigrateResult = {
  project: "acme-web",
  report: {
    project: "acme-web",
    dropped: [{ field: "models", item: "review", why: "unknown role" }],
    access: "migrated",
  },
  backupPath: "/data/backups/acme-web.json",
  overwritten: true,
};

const text = (tree: React.ReactNode) =>
  JSON.stringify(tree, (key, value) =>
    key.startsWith("_") ? undefined : value,
  );

test("one message, a confirm that names this project, busy, then the result", async () => {
  let runs = 0;
  let finish: (result: ProjectRemigrateResult | null) => void = () => {};
  const notice = harness.mount(DriftNotice, {
    project: "acme-web",
    onRemigrate: () => {
      runs++;
      return new Promise<ProjectRemigrateResult | null>(
        (resolve) => (finish = resolve),
      );
    },
  });
  expect(text(notice.output())).toContain(
    "Settings changed during the upgrade",
  );
  expect(text(notice.output()).match(/Re-run migration/g)?.length).toBe(1);

  const button = () => find(notice.output(), Button)!;
  // SAFETY: the Button's click handler ignores its event.
  (button().props as { onClick: () => void }).onClick();
  await settle();
  expect(runs).toBe(0);
  const request = find(notice.output(), ConfirmDialog)!.props.request!;
  expect(String(request.title)).toContain("acme-web");
  expect(String(request.description)).toContain("re-reads acme-web's old");
  expect(String(request.description)).toContain("replaces its current");
  expect(String(request.description)).toContain("backed up first");

  request.onConfirm();
  request.onConfirm();
  await settle();
  expect(runs).toBe(1);
  expect(button().props.disabled).toBe(true);
  expect(text(button().props.children)).toContain("Migrating");

  finish(RESULT);
  await settle();
  expect(button().props.disabled).toBeFalsy();
  expect(toasts).toEqual([
    {
      message:
        "Re-ran the migration for acme-web. Backup: /data/backups/acme-web.json. 1 setting couldn't carry over",
      variant: "success",
    },
  ]);
});

test("a failed run frees the button and claims nothing", async () => {
  const notice = harness.mount(DriftNotice, {
    project: "acme-web",
    onRemigrate: async () => null,
  });
  // SAFETY: the Button's click handler ignores its event.
  (find(notice.output(), Button)!.props as { onClick: () => void }).onClick();
  await settle();
  find(notice.output(), ConfirmDialog)!.props.request!.onConfirm();
  await settle();
  expect(find(notice.output(), Button)!.props.disabled).toBeFalsy();
  expect(toasts).toEqual([]);
});
