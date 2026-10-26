// What the article editor does on Save: a new article goes out with
// `expectedBlob: null`, and a 409 keeps the edit on screen with the conflict
// copy and a Reload. The form's own hooks run in the hook harness; children
// are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { KnowledgeSave } from "../../../lib/api/knowledge";
import {
  createHookHarness,
  elements,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

const toasts: string[] = [];
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({
  ...realToast,
  toast: (message: string) => {
    toasts.push(message);
    return toasts.length;
  },
}));

const { ApiError } = await import("../../../lib/api/request");
const saves: Array<{ project: string; save: KnowledgeSave }> = [];
let refuse: Error | null = null;
const realApi = await import("../../../lib/api/knowledge");
mock.module("../../../lib/api/knowledge", () => ({
  ...realApi,
  saveKnowledgeItem: async (project: string, save: KnowledgeSave) => {
    saves.push({ project, save });
    if (refuse) throw refuse;
    return {
      item: { path: "articles/support-hours.md" },
      commit: "c".repeat(40),
    };
  },
}));

const { KnowledgeEditorForm } = await import("./KnowledgeEditor");
const { Input, Textarea } = await import("../../../ui/input");
const { Button } = await import("../../../ui/button");
const { InlineAlert } = await import("../../../ui/state");

const TODAY = "2026-10-26";
const saved: string[] = [];
let reloads = 0;

beforeEach(() => {
  saves.length = 0;
  saved.length = 0;
  toasts.length = 0;
  refuse = null;
  reloads = 0;
});
afterEach(() => harness.unmountAll());

const mountNew = () =>
  harness.mount(KnowledgeEditorForm, {
    project: "acme",
    read: null,
    today: TODAY,
    onSaved: (path: string) => saved.push(path),
    onReload: () => reloads++,
  });

type Form = ReturnType<typeof mountNew>;

const type = (form: Form, name: string, value: string) => {
  const field =
    find(form.output(), Input, (p) => p.name === name) ??
    find(form.output(), Textarea, (p) => p.name === name);
  if (!field) throw new Error(`No field ${name}`);
  // SAFETY: the handlers read only `target.value`.
  field.props.onChange?.({ target: { value } } as never);
};

const press = (form: Form, label: string) => {
  const button = find(form.output(), Button, (p) => p.children === label);
  if (!button) throw new Error(`No ${label} button`);
  // SAFETY: the handler doesn't read the event.
  button.props.onClick?.({} as never);
};

const alertText = (form: Form) => {
  const alert = find(form.output(), InlineAlert);
  return alert ? String(alert.props.children) : null;
};

test("saving a new article sends the title and body with expectedBlob null", async () => {
  const form = mountNew();
  await settle();
  type(form, "title", "Support hours");
  await settle();
  type(form, "body", "We answer on weekdays from 09:00 to 17:00 CET.");
  await settle();
  press(form, "Save");
  await settle();
  expect(saves).toHaveLength(1);
  const { project, save } = saves[0]!;
  expect(project).toBe("acme");
  expect(save.expectedBlob).toBeNull();
  expect(save.path).toBeUndefined();
  expect(save.body).toBe("We answer on weekdays from 09:00 to 17:00 CET.");
  expect(save.fm).toMatchObject({
    title: "Support hours",
    kind: "answer",
    trust: "trusted",
    status: "active",
    validAsOf: TODAY,
  });
  expect(saved).toEqual(["articles/support-hours.md"]);
});

test("an invalid form doesn't save and says why under the field", async () => {
  const form = mountNew();
  await settle();
  press(form, "Save");
  await settle();
  expect(saves).toHaveLength(0);
  const title = find(form.output(), Input, (p) => p.name === "title");
  expect(title?.props["aria-invalid"]).toBe(true);
  // The error sits under the field, and the field points at it.
  const labeled = elements(form.output())
    .map((el) => el.props)
    .find((p) => "error" in p && p.error === "Add a title");
  expect(labeled).toBeDefined();
  const errorId =
    labeled && "errorId" in labeled ? String(labeled.errorId) : "missing";
  expect(String(title?.props["aria-describedby"])).toBe(errorId);
});

test("a 409 keeps the edit and offers a reload", async () => {
  refuse = new ApiError("Conflict", 409);
  const form = mountNew();
  await settle();
  type(form, "title", "Support hours");
  await settle();
  type(form, "body", "Weekdays.");
  await settle();
  press(form, "Save");
  await settle();
  expect(alertText(form)).toBe(
    "Someone changed this article. Reload and try again.",
  );
  const alert = find(form.output(), InlineAlert);
  expect(alert?.props.retryLabel).toBe("Reload");
  alert?.props.onRetry?.();
  expect(reloads).toBe(1);
  expect(saved).toEqual([]);
  // The text typed is still there.
  expect(
    find(form.output(), Input, (p) => p.name === "title")?.props.value,
  ).toBe("Support hours");
});
