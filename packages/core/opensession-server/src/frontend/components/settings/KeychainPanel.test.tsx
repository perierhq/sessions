// The Keychain section and its Add credential dialog. The components' own
// hooks run in the hook harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  KEYCHAIN_METHODS,
  type KeychainMethod,
  type addKeychainCredential,
} from "../../lib/api/settings";
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
const deleted: string[] = [];
const NOW = Date.now();
const credentialFixture = (id: string, service: string) => ({
  id,
  owner: "Alex",
  service,
  host: "api.example.test",
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
  mine: true,
});
const grantFixture = (
  id: string,
  credentialId: string,
  status: "active" | "used" = "active",
  expiresInMs = 3_600_000,
) => ({
  id,
  credentialId,
  owner: "Alex",
  sessionId: `s-${id}`,
  requestedBy: "Bea",
  purpose: "read orders",
  mode: "standing" as const,
  status,
  createdAt: "2026-10-28T10:00:00.000Z",
  expiresAt: new Date(NOW + expiresInMs).toISOString(),
});
const keychain = {
  credentials: [
    credentialFixture("kc-1", "acme-api"),
    credentialFixture("kc-2", "acme-unused"),
  ],
  grants: [
    grantFixture("g-1", "kc-1"),
    grantFixture("g-2", "kc-1"),
    grantFixture("g-3", "kc-1", "used"),
    grantFixture("g-4", "kc-1", "active", -60_000),
  ],
  asks: [],
};
const realApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
  ...realApi,
  addKeychainCredential: async (input: AddInput) => {
    if (addError) throw addError;
    added.push(input);
    return { credential: { id: "kc-1", ...input } };
  },
  fetchKeychain: async () => keychain,
  deleteKeychainCredential: async (id: string) => {
    deleted.push(id);
    return { ok: true };
  },
}));

const { AddCredentialForm, AddLoginForm, KeychainSection } =
  await import("./KeychainPanel");
const { Button } = await import("../../ui/button");
const { ConfirmDialog } = await import("../../ui/confirm");
const { Input } = await import("../../ui/input");
const { InlineAlert } = await import("../../ui/state");
const { Field } = await import("../../ui/input");
const { PlainButton } = await import("../../ui/plain-button");
const { SettingRow } = await import("./shared");
const { Modal } = await import("../../ui/modal");

beforeEach(() => {
  added.length = 0;
  deleted.length = 0;
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

/** The method chips, by label, with whether each is on. */
function chips(tree: Tree): Partial<Record<KeychainMethod, boolean>> {
  const out: Partial<Record<KeychainMethod, boolean>> = {};
  for (const method of KEYCHAIN_METHODS) {
    const chip = find(
      tree.output(),
      PlainButton,
      (p) => p.children === method && p["aria-pressed"] !== undefined,
    );
    if (chip) out[method] = chip.props["aria-pressed"] === true;
  }
  return out;
}

async function toggle(tree: Tree, method: string) {
  const chip = find(tree.output(), PlainButton, (p) => p.children === method);
  // SAFETY: the chip's handler ignores the click event.
  chip!.props.onClick!(undefined as never);
  await settle();
}

test("field rules are visible text, not hover-only titles", async () => {
  for (const form of [AddCredentialForm, AddLoginForm]) {
    const tree = harness.mount(form, {
      serviceRef: { current: null },
      onAdded: () => {},
    });
    await settle();
    expect(find(tree.output(), Field, (p) => p.title !== undefined)).toBe(
      undefined,
    );
    expect(text(tree)).toContain("Optional");
  }
  const tree = await mountForm();
  const all = text(tree);
  expect(all).toContain("None selected allows any method");
  expect(all).toContain("Separate several with commas");
  expect(all).toContain("Use this when the API might echo the key");
});

test("methods are chips, and the chosen ones are saved", async () => {
  const tree = await mountForm();
  expect(chips(tree)).toEqual({
    GET: false,
    HEAD: false,
    POST: false,
    PUT: false,
    PATCH: false,
    DELETE: false,
  });
  await toggle(tree, "DELETE");
  await toggle(tree, "GET");
  await toggle(tree, "POST");
  await toggle(tree, "POST");
  expect(chips(tree)).toMatchObject({ GET: true, POST: false, DELETE: true });
  await type(tree, "vercel", "acme");
  await type(tree, "api.vercel.com", "api.example.test");
  await type(tree, "Never shown again", "sk-acme");
  await type(tree, "/v1/orders", "/v1/orders, /v2/orders");
  await submit(tree);
  expect(added).toHaveLength(1);
  expect(added[0]!.allowedMethods).toEqual(["GET", "DELETE"]);
  expect(added[0]!.allowedPathPrefixes).toEqual(["/v1/orders", "/v2/orders"]);
});

test("no chip selected sends no method limit", async () => {
  const tree = await mountForm();
  await type(tree, "vercel", "acme");
  await type(tree, "api.vercel.com", "api.example.test");
  await type(tree, "Never shown again", "sk-acme");
  await submit(tree);
  expect(added[0]!.allowedMethods).toBeUndefined();
});

async function deleteAsks(service: string) {
  const tree = harness.mount(KeychainSection, {});
  await settle();
  const row = find(tree.output(), SettingRow, (p) =>
    JSON.stringify(p.title).includes(service),
  );
  const remove = find(
    row!.props.control,
    Button,
    (p) => p.children === "Delete",
  );
  // SAFETY: the Delete handler ignores the click event.
  remove!.props.onClick!(undefined as never);
  await settle();
  return { tree, request: find(tree.output(), ConfirmDialog)?.props.request };
}

test("delete asks first, naming how many live grants lose access", async () => {
  const { request } = await deleteAsks("acme-api");
  expect(deleted).toEqual([]);
  expect(request?.title).toBe("Delete acme-api?");
  expect(request?.destructive).toBe(true);
  expect(String(request?.description)).toContain(
    "2 active grants lose access now",
  );
  request!.onConfirm();
  await settle();
  expect(deleted).toEqual(["kc-1"]);
});

test("deleting a credential nobody holds says so", async () => {
  const { request } = await deleteAsks("acme-unused");
  expect(String(request?.description)).toContain("No session holds a grant");
});
