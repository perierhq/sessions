// The Keychain section and its Add credential dialog. The components' own
// hooks run in the hook harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type {
  KeychainCredentialDto,
  KeychainGrantDto,
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

const added: Array<Record<string, unknown>> = [];
let addError: Error | undefined;
const realApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
  ...realApi,
  addKeychainCredential: async (input: Record<string, unknown>) => {
    if (addError) throw addError;
    added.push(input);
    return { credential: { id: "kc-1", ...input } };
  },
}));

const { AddCredentialForm } = await import("./KeychainPanel");
const { Input } = await import("../../ui/input");

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
    onError: () => {},
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
