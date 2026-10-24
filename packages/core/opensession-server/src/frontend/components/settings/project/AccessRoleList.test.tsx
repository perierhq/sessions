// The phone access list: all five roles as chips, one role's values at a
// time, checkmark toggles that change a cell. Its own state runs in the
// hook harness; the rows are read from the element tree.
import { afterEach, describe, expect, mock, test } from "bun:test";
import type * as React from "react";
import { isValidElement, type ReactNode } from "react";
import type { AccessCellChange } from "../../../../shared/project-settings";
import { READY_4_OF_6 } from "../../../../shared/project-settings-fixtures";
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

const { AccessRoleList } = await import("./AccessRoleList");
const { CellFace } = await import("./CellFace");
const { PlainButton } = await import("../../../ui/plain-button");

afterEach(() => harness.unmountAll());

type ButtonProps = React.ComponentProps<"button">;

/** The text inside a tree, children only. */
function text(node: ReactNode): string {
  if (node == null || node === true || node === false) return "";
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return text(node.props.children);
  return String(node);
}

function buttons(tree: ReactNode): ButtonProps[] {
  const out: ButtonProps[] = [];
  for (const el of elements(tree))
    if (el.type === PlainButton && isValidElement<ButtonProps>(el))
      out.push(el.props);
  return out;
}

/** The role chips: pressed or not, named by their words. */
function chips(tree: ReactNode): ButtonProps[] {
  return buttons(tree).filter(
    (p) => p["aria-pressed"] !== undefined && !p["aria-label"],
  );
}

/** The element a screen reader calls `name`. */
function named(tree: ReactNode, name: string) {
  for (const el of elements(tree))
    if (
      isValidElement<{ "aria-label"?: string; children?: ReactNode }>(el) &&
      el.props["aria-label"] === name
    )
      return el;
  return undefined;
}

/** A click, as these handlers read it. */
function click(props: ButtonProps | undefined) {
  // SAFETY: every handler under test ignores its event argument.
  props?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
}

const mount = (onCellChange = (_: AccessCellChange) => {}) =>
  harness.mount(AccessRoleList, {
    access: READY_4_OF_6.access,
    onCellChange,
    onAllowAgents: () => {},
  });

describe("AccessRoleList", () => {
  test("shows all five roles as chips", () => {
    const list = mount();
    const all = chips(list.output());
    expect(all.map((c) => text(c.children))).toEqual([
      "You",
      "Automations",
      "Investigator",
      "Verifier",
      "Reviews",
    ]);
    for (const chip of all) expect(String(chip.className)).toMatch(/before:/);
  });

  test("selecting Verifier shows Read only for Changes code", async () => {
    const list = mount();
    const verifier = chips(list.output()).find(
      (c) => text(c.children) === "Verifier",
    );
    click(verifier);
    await settle();
    const tree = list.output();
    expect(chips(tree).find((c) => c["aria-pressed"])?.children).toBe(
      "Verifier",
    );
    const code = named(
      tree,
      "Changes code in acme-web for Verifier: Read only",
    );
    expect(code).toBeDefined();
    // The value itself renders through CellFace with the cell's value.
    const face = find(code, CellFace);
    expect(face?.props.cell.value).toBe("read");
  });

  test("a checkmark row toggles its cell for the shown role", async () => {
    const changes: AccessCellChange[] = [];
    const list = mount((c) => changes.push(c));
    click(chips(list.output()).find((c) => text(c.children) === "Reviews"));
    await settle();
    const linear = buttons(list.output()).find(
      (b) => b["aria-label"] === "Linear for Reviews: Yes",
    );
    expect(linear?.["aria-pressed"]).toBe(true);
    expect(String(linear?.className)).toContain("size-11");
    click(linear);
    expect(changes).toEqual([
      {
        row: { kind: "connection", server: "linear" },
        role: "reviews",
        value: false,
      },
    ]);
  });

  test("each row says how many roles have it", () => {
    const list = mount();
    const all = text(list.output());
    expect(all).toContain("4 of 5 roles");
    expect(all).toContain("Every role");
  });
});
