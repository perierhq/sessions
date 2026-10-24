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
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

const { AccessRoleList } = await import("./AccessRoleList");

afterEach(() => harness.unmountAll());

type ButtonProps = React.ComponentProps<"button">;

/** The text inside a tree, children only. */
function text(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return text(node.props.children);
  return "";
}

function chips(tree: ReactNode): ButtonProps[] {
  return elements(tree)
    .filter((el) => el.type === "button")
    .map((el) => el.props as ButtonProps)
    .filter((p) => p["aria-pressed"] !== undefined && !p["aria-label"]);
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
    verifier?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    await settle();
    const tree = list.output();
    expect(chips(tree).find((c) => c["aria-pressed"])?.children).toBe(
      "Verifier",
    );
    const named = elements(tree).find(
      (el) =>
        (el.props as { "aria-label"?: string })["aria-label"] ===
        "Changes code in acme-web for Verifier: Read only",
    );
    expect(named).toBeDefined();
    expect(text((named!.props as { children?: ReactNode }).children)).toBe("");
    // The value itself renders through CellFace with the cell's value.
    const face = elements(named).find(
      (el) => (el.props as { cell?: { value: string } }).cell !== undefined,
    );
    expect((face?.props as { cell: { value: string } }).cell.value).toBe(
      "read",
    );
  });

  test("a checkmark row toggles its cell for the shown role", async () => {
    const changes: AccessCellChange[] = [];
    const list = mount((c) => changes.push(c));
    chips(list.output())
      .find((c) => text(c.children) === "Reviews")
      ?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    await settle();
    const linear = elements(list.output()).find(
      (el) =>
        (el.props as { "aria-label"?: string })["aria-label"] ===
        "Linear for Reviews: Yes",
    );
    expect((linear?.props as ButtonProps)["aria-pressed"]).toBe(true);
    expect(String((linear?.props as ButtonProps).className)).toContain(
      "size-11",
    );
    (linear?.props as ButtonProps).onClick?.(
      {} as React.MouseEvent<HTMLButtonElement>,
    );
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
