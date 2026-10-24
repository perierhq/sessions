// The desktop access table: which cells are buttons, what they are called,
// what a click changes, and that every button is a 44px target. The table
// is hook-free, so a click is its element's own onClick.
import { describe, expect, test } from "bun:test";
import type * as React from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccessCellChange } from "../../../../shared/project-settings";
import { READY_4_OF_6 } from "../../../../shared/project-settings-fixtures";
import { elements, find } from "../../../tools/hook-harness";
import { Button } from "../../../ui/button";
import { AccessTable } from "./AccessTable";

type ButtonProps = React.ComponentProps<"button">;

function table(
  onCellChange = (_: AccessCellChange) => {},
  onAllow = (_: string) => {},
) {
  return AccessTable({
    access: READY_4_OF_6.access,
    onCellChange,
    onAllowAgents: onAllow,
  });
}

/** Every native button in the tree, with its props. */
function buttons(tree: React.ReactNode): ButtonProps[] {
  const out: ButtonProps[] = [];
  for (const el of elements(tree))
    if (el.type === "button" && isValidElement<ButtonProps>(el))
      out.push(el.props);
  return out;
}

/** A click, as these handlers read it. */
function click(props: { onClick?: ButtonProps["onClick"] } | undefined) {
  // SAFETY: every handler under test ignores its event argument.
  props?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
}

describe("AccessTable", () => {
  test("clicking Linear for Reviews unticks it", () => {
    const changes: AccessCellChange[] = [];
    const cell = buttons(table((c) => changes.push(c))).find(
      (b) => b["aria-label"] === "Linear for Reviews: Yes",
    );
    expect(cell?.["aria-pressed"]).toBe(true);
    click(cell);
    expect(changes).toEqual([
      {
        row: { kind: "connection", server: "linear" },
        role: "reviews",
        value: false,
      },
    ]);
  });

  test("a keychain cell cycles to Always and has no aria-pressed", () => {
    const changes: AccessCellChange[] = [];
    const cell = buttons(table((c) => changes.push(c))).find(
      (b) => b["aria-label"] === "Cloudflare token for Investigator: Ask once",
    );
    expect(cell?.["aria-pressed"]).toBeUndefined();
    click(cell);
    expect(changes[0]?.value).toBe("standing");
  });

  test("the You column and the verifier search cell are never buttons", () => {
    const labels = buttons(table()).map((b) => String(b["aria-label"] ?? ""));
    expect(labels.some((l) => l.includes(" for You:"))).toBe(false);
    expect(
      labels.some((l) => l.startsWith("Search the web for Verifier")),
    ).toBe(false);
    expect(
      labels.some((l) => l.startsWith("Cloudflare token for Automations")),
    ).toBe(false);
  });

  test("Allow agents fixes the Grafana row", () => {
    const allowed: string[] = [];
    const el = find(
      table(undefined, (s) => allowed.push(s)),
      Button,
      (p) => p.children === "Allow agents",
    );
    click(el?.props);
    expect(allowed).toEqual(["grafana"]);
  });

  test("markup: 5 equal columns, labels, 44px targets", () => {
    const html = renderToStaticMarkup(table());
    expect(html).toContain("repeat(5,96px)");
    for (const role of [
      "You",
      "Automations",
      "Investigator",
      "Verifier",
      "Reviews",
    ])
      expect(html).toContain(`>${role}<`);
    const all = html.match(/<button[^>]*>/g) ?? [];
    expect(all.length).toBeGreaterThan(10);
    for (const b of all) expect(b).toMatch(/min-h-11|before:/);
    // Blocked cells read a dash in amber.
    expect(html).toContain("Grafana for Investigator: Blocked");
    expect(html).toMatch(
      /text-yellow[^>]*aria-label="Grafana for Investigator: Blocked"|aria-label="Grafana for Investigator: Blocked"[^>]*text-yellow/,
    );
  });

  test("keychain cells spell the value out", () => {
    const html = renderToStaticMarkup(table());
    expect(html).toContain(">Ask once<");
    expect(html).toContain(">Ask each time<");
    expect(html).not.toContain(">Once<");
    expect(html).toContain(">Read only<");
    expect(html).toContain(">Branch<");
  });
});
