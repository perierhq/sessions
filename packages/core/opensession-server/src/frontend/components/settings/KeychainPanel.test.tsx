// The Keychain section and its Add credential dialog. The components' own
// hooks run in the hook harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { addKeychainCredential } from "../../lib/api/settings";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

type AddInput = Parameters<typeof addKeychainCredential>[0];
const added: AddInput[] = [];
let addError: Error | undefined;
const realApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
  ...realApi,
  addKeychainCredential: async (input: AddInput) => {
    if (addError) throw addError;
    added.push(input);
    return { credential: { id: "kc-1", ...input } };
  },
}));

const { AddCredentialForm, AddLoginForm } = await import("./KeychainPanel");
const { Input } = await import("../../ui/input");
const { InlineAlert } = await import("../../ui/state");
const { Modal } = await import("../../ui/modal");

beforeEach(() => {
  added.length = 0;
  addError = undefined;
});
afterEach(() => harness.unmountAll());

type Tree = ReturnType<typeof harness.mount>;

function text(tree: Tree): string {
  return JSON.stringify(tree.output(), (key, value) =>
    key.startsWith("_") ? undefined : value,
  );
}

async function mountForm() {
  const tree = harness.mount(AddCredentialForm, {
    serviceRef: { current: null },
    onAdded: () => {},
  });
  await settle();
  return tree;
}

test("the header field shows a bare header name and says what empty sends", async () => {
  const tree = await mountForm();
  const header = find(
    tree.output(),
    Input,
    (p) => p.placeholder === "Authorization",
  );
  expect(header).toBeDefined();
  expect(header!.props["aria-describedby"]).toBeTruthy();
  expect(text(tree)).toContain("Authorization: Bearer <secret>");
});

/** Type into the input whose placeholder is `placeholder`. */
async function type(tree: Tree, placeholder: string, value: string) {
  const input = find(
    tree.output(),
    Input,
    (p) => p.placeholder === placeholder,
  );
  expect(input).toBeDefined();
  // SAFETY: the forms' handlers read only `target.value`.
  input!.props.onChange!({ target: { value } } as never);
  await settle();
}

async function submit(tree: Tree) {
  const form = find<React.ComponentProps<"form">>(tree.output(), "form");
  // SAFETY: the forms' submit handlers call only `preventDefault`.
  form!.props.onSubmit!({ preventDefault: () => {} } as never);
  await settle();
}

/** The form's direct children in order: its fields, an alert, the footer. */
function order(tree: Tree): string[] {
  const form = find<React.ComponentProps<"form">>(tree.output(), "form");
  const children = form!.props.children;
  return (Array.isArray(children) ? children : [children])
    .filter(realReact.isValidElement)
    .map((child) =>
      child.type === InlineAlert
        ? "alert"
        : child.type === Modal.Footer
          ? "footer"
          : "fields",
    );
}

test("a failed save shows its error inside the dialog, above its buttons", async () => {
  addError = new Error("host must be a public host name");
  const tree = await mountForm();
  await type(tree, "vercel", "acme");
  await type(tree, "api.vercel.com", "localhost");
  await type(tree, "Never shown again", "sk-acme");
  await submit(tree);
  const alert = find(tree.output(), InlineAlert);
  expect(alert).toBeDefined();
  expect(text(tree)).toContain("host must be a public host name");
  expect(order(tree).slice(-2)).toEqual(["alert", "footer"]);

  // The next attempt clears it, and a success never shows one.
  addError = undefined;
  await submit(tree);
  expect(find(tree.output(), InlineAlert)).toBeUndefined();
  expect(added).toHaveLength(1);
});

test("a login's failed save shows inside its dialog too", async () => {
  addError = new Error(
    "loginUrl must be a full https:// URL of the sign-in page",
  );
  const tree = harness.mount(AddLoginForm, {
    serviceRef: { current: null },
    onAdded: () => {},
  });
  await settle();
  await type(tree, "acme-staging", "acme-staging");
  await type(tree, "https://app.example.test/login", "app.example.test");
  await type(tree, "qa@example.test", "qa@example.test");
  await type(tree, "Never shown again here", "pw");
  await submit(tree);
  expect(text(tree)).toContain("loginUrl must be a full https:// URL");
  expect(order(tree).slice(-2)).toEqual(["alert", "footer"]);
});
