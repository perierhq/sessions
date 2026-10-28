// The Keychain section and its add and edit dialogs. The components' own
// hooks run in the hook harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  KEYCHAIN_METHODS,
  type KeychainMethod,
  type addKeychainCredential,
  type KeychainCredentialDto,
  type testKeychainCredential,
  type updateKeychainCredential,
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
type PatchInput = Parameters<typeof updateKeychainCredential>[1];
const added: AddInput[] = [];
const patched: Array<{ id: string; patch: PatchInput }> = [];
type TestInput = Parameters<typeof testKeychainCredential>[0];
const tested: TestInput[] = [];
let addError: Error | undefined;
let testReply: { status: number; reason: string } | Error = {
  status: 200,
  reason: "OK",
};
const deleted: string[] = [];
const resumed: string[] = [];
const NOW = Date.now();
const credentialFixture = (
  id: string,
  service: string,
  over: Partial<KeychainCredentialDto> = {},
): KeychainCredentialDto => ({
  id,
  owner: "Alex",
  service,
  host: "api.example.test",
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
  mine: true,
  ...over,
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
const isoDay = (offsetDays: number) =>
  new Date(NOW + offsetDays * 86_400_000).toISOString().slice(0, 10);
const keychain = {
  credentials: [
    credentialFixture("kc-1", "acme-api", {
      lastUsed: {
        at: new Date(NOW - 2 * 3_600_000).toISOString(),
        sessionId: "s-used",
        by: "Sam",
        status: 200,
      },
    }),
    credentialFixture("kc-2", "acme-unused"),
    credentialFixture("kc-3", "acme-old", { expiresOn: isoDay(-3) }),
    credentialFixture("kc-4", "acme-soon", { expiresOn: isoDay(5) }),
  ],
  grants: [
    grantFixture("g-1", "kc-1"),
    grantFixture("g-2", "kc-1"),
    grantFixture("g-3", "kc-1", "used"),
    grantFixture("g-4", "kc-1", "active", -60_000),
    { ...grantFixture("g-5", "kc-2"), status: "suspended" as const },
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
  updateKeychainCredential: async (id: string, patch: PatchInput) => {
    if (addError) throw addError;
    patched.push({ id, patch });
    return {};
  },
  testKeychainCredential: async (input: TestInput) => {
    tested.push(input);
    if (testReply instanceof Error) throw testReply;
    return testReply;
  },
  fetchKeychain: async () => keychain,
  resumeKeychainGrant: async (id: string) => {
    resumed.push(id);
    return { ok: true };
  },
  deleteKeychainCredential: async (id: string) => {
    deleted.push(id);
    return { ok: true };
  },
}));

const { CredentialDialog, LoginDialog } = await import("./KeychainDialogs");
const { KeychainSection } = await import("./KeychainPanel");
const { Button } = await import("../../ui/button");
const { ConfirmDialog } = await import("../../ui/confirm");
const { Input } = await import("../../ui/input");
const { Field } = await import("../../ui/input");
const { Menu } = await import("../../ui/menu");
const { PlainButton } = await import("../../ui/plain-button");
const { SettingRow } = await import("./shared");
const { SettingsDialog } = await import("./incidents/SettingsDialog");
const { Badge } = await import("../../ui/badge");
const { InlineAlert } = await import("../../ui/state");
const { AgentName } = await import("../AgentIdentity");
const { CredentialHistoryDialog } = await import("./CredentialHistoryDialog");

beforeEach(() => {
  added.length = 0;
  patched.length = 0;
  tested.length = 0;
  deleted.length = 0;
  addError = undefined;
  testReply = { status: 200, reason: "OK" };
});
afterEach(() => harness.unmountAll());

type Tree = ReturnType<typeof harness.mount>;

function text(tree: Tree): string {
  return JSON.stringify(tree.output(), (key, value) =>
    key.startsWith("_") ? undefined : value,
  );
}

async function mountForm(credential?: KeychainCredentialDto) {
  const tree = harness.mount(CredentialDialog, {
    credential,
    onClose: () => {},
    onSaved: () => {},
  });
  await settle();
  return tree;
}

type InputProps = React.ComponentProps<typeof Input>;

/** Type into the first input `which` picks. */
async function type(
  tree: Tree,
  which: (props: InputProps) => boolean,
  value: string,
) {
  const input = find(tree.output(), Input, which);
  expect(input).toBeDefined();
  // SAFETY: the forms' handlers read only `target.value`.
  input!.props.onChange!({ target: { value } } as never);
  await settle();
}

const secretField = (p: InputProps) => p.type === "password";
const placeholder = (text: string) => (p: InputProps) => p.placeholder === text;
const valued = (text: string) => (p: InputProps) => p.value === text;

function dialog(tree: Tree) {
  const found = find(tree.output(), SettingsDialog);
  expect(found).toBeDefined();
  return found!.props;
}

async function submit(tree: Tree) {
  dialog(tree).onSave!();
  await settle();
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

test("a failed save shows its error inside the dialog, above its buttons", async () => {
  addError = new Error("host must be a public host name");
  const tree = await mountForm();
  await type(tree, placeholder("acme-api"), "acme");
  await type(tree, placeholder("api.example.test"), "localhost");
  await type(tree, secretField, "sk-acme");
  await submit(tree);
  // SettingsDialog draws its `error` above Cancel and Save.
  expect(dialog(tree).error).toBe("host must be a public host name");

  // The next attempt clears it, and a success never shows one.
  addError = undefined;
  await submit(tree);
  expect(dialog(tree).error).toBeNull();
  expect(added).toHaveLength(1);
});

test("a login's failed save shows inside its dialog too", async () => {
  addError = new Error(
    "loginUrl must be a full https:// URL of the sign-in page",
  );
  const tree = harness.mount(LoginDialog, {
    onClose: () => {},
    onSaved: () => {},
  });
  await settle();
  await type(tree, placeholder("acme-staging"), "acme-staging");
  await type(
    tree,
    placeholder("https://app.example.test/login"),
    "app.example.test",
  );
  await type(tree, placeholder("qa@example.test"), "qa@example.test");
  await type(tree, secretField, "pw");
  await submit(tree);
  expect(dialog(tree).error).toContain("loginUrl must be a full https:// URL");
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
  for (const form of [CredentialDialog, LoginDialog]) {
    const tree = harness.mount(form, {
      onClose: () => {},
      onSaved: () => {},
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
  await type(tree, placeholder("acme-api"), "acme");
  await type(tree, placeholder("api.example.test"), "api.example.test");
  await type(tree, secretField, "sk-acme");
  await type(tree, placeholder("/v1/orders"), "/v1/orders, /v2/orders");
  await submit(tree);
  expect(added).toHaveLength(1);
  expect(added[0]!.allowedMethods).toEqual(["GET", "DELETE"]);
  expect(added[0]!.allowedPathPrefixes).toEqual(["/v1/orders", "/v2/orders"]);
});

test("no chip selected sends no method limit", async () => {
  const tree = await mountForm();
  await type(tree, placeholder("acme-api"), "acme");
  await type(tree, placeholder("api.example.test"), "api.example.test");
  await type(tree, secretField, "sk-acme");
  await submit(tree);
  expect(added[0]!.allowedMethods).toEqual([]);
});

const saved = credentialFixture("kc-9", "acme-orders", {
  description: "Orders",
  allowedMethods: ["GET"],
  allowedPathPrefixes: ["/v1/orders"],
  testPath: "/v1/orders/latest",
});

test("edit opens with the credential's values and keeps the secret", async () => {
  const tree = await mountForm(saved);
  expect(dialog(tree).title).toBe("Edit acme-orders");
  // No secret field until the owner chooses to rotate it.
  expect(find(tree.output(), Input, secretField)).toBeUndefined();
  expect(
    find(tree.output(), Input, (p) => p.value === "/v1/orders"),
  ).toBeDefined();
  // Nothing changed yet, so nothing to save.
  expect(dialog(tree).canSave).toBe(false);
  await type(tree, valued("Orders"), "Orders, read only");
  expect(dialog(tree).canSave).toBe(true);
  await submit(tree);
  expect(patched).toHaveLength(1);
  expect(patched[0]!.id).toBe("kc-9");
  expect(patched[0]!.patch).toMatchObject({
    description: "Orders, read only",
    allowedMethods: ["GET"],
    expectedUpdatedAt: "2026-10-28T10:00:00.000Z",
  });
  // An empty secret keeps the current one.
  expect(patched[0]!.patch.secret).toBe("");
});

test("rotate takes a new secret and saves only with one", async () => {
  const tree = await mountForm(saved);
  const rotate = find(
    tree.output(),
    Button,
    (p) => p.children === "Rotate secret",
  );
  // SAFETY: the Rotate handler ignores the click event.
  rotate!.props.onClick!(undefined as never);
  await settle();
  await type(tree, secretField, "sk-new");
  expect(dialog(tree).canSave).toBe(true);
  await submit(tree);
  expect(patched[0]!.patch.secret).toBe("sk-new");
});

async function runTest(tree: Tree) {
  const button = find(tree.output(), Button, (p) => p.children === "Test");
  expect(button).toBeDefined();
  // SAFETY: the Test handler ignores the click event.
  button!.props.onClick!(undefined as never);
  await settle();
}

test("test runs what is on screen and shows only the status", async () => {
  testReply = { status: 401, reason: "Unauthorized" };
  const tree = await mountForm(saved);
  await type(tree, placeholder("api.example.test"), "api2.example.test");
  await runTest(tree);
  expect(tested[0]).toMatchObject({
    credentialId: "kc-9",
    path: "/v1/orders/latest",
    spec: { host: "api2.example.test" },
  });
  expect(text(tree)).toContain(
    "GET /v1/orders/latest answered 401 Unauthorized. Check the secret and the header",
  );
  // A change makes the result stale, so it goes.
  await type(tree, valued("api2.example.test"), "api.example.test");
  expect(text(tree)).not.toContain("answered 401");
});

test("a new credential can't be tested before it has a secret", async () => {
  const tree = await mountForm();
  await type(tree, placeholder("api.example.test"), "api.example.test");
  const button = find(tree.output(), Button, (p) => p.children === "Test");
  expect(button!.props.disabled).toBe(true);
  await type(tree, secretField, "sk-acme");
  testReply = new Error("the request to api.example.test timed out");
  await runTest(tree);
  expect(tested[0]).toMatchObject({ secret: "sk-acme", path: "/" });
  expect(text(tree)).toContain("The request to api.example.test timed out");
});

test("expiry is a date, cleared to none", async () => {
  const tree = await mountForm(saved);
  await type(tree, (p) => p.type === "date", isoDay(10));
  expect(text(tree)).toContain("Expires in 10 days");
  await submit(tree);
  expect(patched[0]!.patch.expiresOn).toBe(isoDay(10));
});

async function section() {
  const tree = harness.mount(KeychainSection, {});
  await settle();
  return tree;
}

function row(tree: Tree, service: string) {
  return find(tree.output(), SettingRow, (p) =>
    JSON.stringify(p.title).includes(service),
  )!;
}

test("rows show an expired credential and one about to expire", async () => {
  const tree = await section();
  expect(
    find(
      row(tree, "acme-old").props.title,
      Badge,
      (p) => p.children === "Expired",
    ),
  ).toBeDefined();
  expect(JSON.stringify(row(tree, "acme-soon").props.desc)).toContain(
    "expires in 5 days",
  );
});

test("a row's Edit opens the dialog for that credential", async () => {
  const tree = await section();
  const edit = find(
    row(tree, "acme-api").props.control,
    Button,
    (p) => p.children === "Edit",
  );
  // SAFETY: the Edit handler ignores the click event.
  edit!.props.onClick!(undefined as never);
  await settle();
  const open = find(tree.output(), CredentialDialog);
  expect(open?.props.credential?.id).toBe("kc-1");
});

async function deleteAsks(service: string) {
  const tree = await section();
  const remove = find(
    row(tree, service).props.control,
    Menu.Item,
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

test("an edit that widens the limits says, before saving, which grants pause", async () => {
  const tree = harness.mount(CredentialDialog, {
    credential: saved,
    grants: [grantFixture("g-7", "kc-9"), grantFixture("g-8", "kc-9")],
    onClose: () => {},
    onSaved: () => {},
  });
  await settle();
  expect(dialog(tree).notice).toBeFalsy();
  await toggle(tree, "DELETE");
  const notice = find(dialog(tree).notice, InlineAlert);
  expect(notice?.props.variant).toBe("warn");
  expect(text(tree)).toContain(
    "Saving widens the limits: methods now include DELETE. 2 grants approved under the old limits pause until you allow them again",
  );
  // Back to the old limits: nothing to warn about.
  await toggle(tree, "DELETE");
  expect(dialog(tree).notice).toBeFalsy();
});

test("a paused grant can be allowed again by the owner", async () => {
  const tree = await section();
  const paused = find(tree.output(), SettingRow, (p) =>
    JSON.stringify(p.title).includes("Paused"),
  );
  expect(paused).toBeDefined();
  const allow = find(
    paused!.props.control,
    Button,
    (p) => p.children === "Allow again",
  );
  // SAFETY: the Allow again handler ignores the click event.
  allow!.props.onClick!(undefined as never);
  await settle();
  expect(resumed).toEqual(["g-5"]);
});

test("a row says when the credential was last used and by which agent", async () => {
  const tree = await section();
  const desc = row(tree, "acme-api").props.desc;
  expect(JSON.stringify(desc)).toContain("Last used ");
  expect(JSON.stringify(desc)).toContain("2h ago");
  expect(find(desc, AgentName)?.props.sessionId).toBe("s-used");
  expect(find<React.ComponentProps<"a">>(desc, "a")?.props.href).toContain(
    "/session/s-used",
  );
  // Never used: nothing to say.
  expect(JSON.stringify(row(tree, "acme-unused").props.desc)).not.toContain(
    "Last used",
  );
});

test("History opens the credential's audit lines", async () => {
  const tree = await section();
  const history = find(
    row(tree, "acme-api").props.control,
    Menu.Item,
    (p) => p.children === "History",
  );
  // SAFETY: the History handler ignores the click event.
  history!.props.onClick!(undefined as never);
  await settle();
  expect(
    find(tree.output(), CredentialHistoryDialog)?.props.credential.id,
  ).toBe("kc-1");
});

test("a row shows the ceiling its grants inherit", async () => {
  const tree = await section();
  expect(JSON.stringify(row(tree, "acme-api").props.desc)).toContain(
    "allows any method, any path",
  );
});
