import { expect, test } from "bun:test";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HiddenListEntry } from "../../lib/hidden-list";
import {
  type Focusable,
  HiddenEntry,
  HiddenList,
  nextListOpen,
  restoreFocusTarget,
} from "./HiddenEntry";

const entry = (key: string): HiddenListEntry => ({
  kind: "row",
  key,
  hiddenAt: "2026-08-01T10:00:00.000Z",
  title: `Title ${key}`,
  repo: "acme/web",
  sessionId: `session-${key}`,
});

const render = (entries: HiddenListEntry[], isPhone: boolean) =>
  renderToStaticMarkup(
    <HiddenEntry
      entries={entries}
      isPhone={isPhone}
      onOpenEntry={() => {}}
      onRestore={() => {}}
    />,
  );

test("nothing renders while nothing is hidden", () => {
  expect(render([], false)).toBe("");
  expect(render([], true)).toBe("");
});

test("the row names itself and its count for screen readers", () => {
  for (const isPhone of [false, true]) {
    const html = render([entry("a"), entry("b")], isPhone);
    expect(html).toContain(">Hidden<");
    expect(html).toContain(">2<");
    expect(html).toContain('aria-label="Hidden, 2 items"');
  }
  expect(render([entry("a")], false)).toContain('aria-label="Hidden, 1 item"');
});

// ── Interactions ─────────────────────────────────────────────────────────
// No DOM under the test runner: the list is called as a function and its
// Restore handlers are driven with stand-in elements, like KeepInSidebarMark.

const focusLog: string[] = [];
const focusable = (name: string): Focusable => ({
  focus: () => {
    focusLog.push(name);
  },
});

/** The stand-in for a list item: its siblings and their Restore buttons. */
interface FakeSibling {
  querySelector: (selector: string) => Focusable | null;
}
interface FakeClick {
  currentTarget: {
    closest: (selector: string) => {
      nextElementSibling: FakeSibling | null;
      previousElementSibling: FakeSibling | null;
    } | null;
  };
}
interface RestoreProps {
  "aria-label"?: string;
  "data-hidden-restore"?: string;
  onClick?: (event: FakeClick) => void;
  children?: ReactNode;
}

const sibling = (restore: Focusable): FakeSibling => ({
  querySelector: (selector) =>
    selector === "[data-hidden-restore]" ? restore : null,
});
const click = (
  next: FakeSibling | null,
  previous: FakeSibling | null,
): FakeClick => ({
  currentTarget: {
    closest: () => ({
      nextElementSibling: next,
      previousElementSibling: previous,
    }),
  },
});

// The Restore buttons in a rendered tree, depth first.
function restoreButtons(node: ReactNode): ReactElement<RestoreProps>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<RestoreProps>(child)) return [];
    const own = child.props["data-hidden-restore"] === undefined ? [] : [child];
    return [...own, ...restoreButtons(child.props.children)];
  });
}

test("restoring moves focus to the next Restore, else the previous", () => {
  const next = focusable("next");
  const previous = focusable("previous");
  const fallback = focusable("archived");
  expect(restoreFocusTarget([next, previous], () => fallback)).toBe(next);
  expect(restoreFocusTarget([null, previous], () => fallback)).toBe(previous);
  // The last entry: the list is about to go, so focus lands somewhere stable.
  expect(restoreFocusTarget([undefined, null], () => fallback)).toBe(fallback);
});

test("restoring the last entry hands focus to the fallback before it goes", () => {
  focusLog.length = 0;
  const order: string[] = [];
  const tree = HiddenList({
    entries: [entry("only")],
    onOpenEntry: () => {},
    onRestore: (restored) => {
      order.push(`restore ${restored.key}`);
      // By the time the entry is restored, focus has already left the row.
      order.push(`focus was ${focusLog.at(-1) ?? "nowhere"}`);
    },
    focusFallback: () => focusable("archived"),
    className: "",
  });
  const [restore] = restoreButtons(tree);
  expect(restore?.props["aria-label"]).toBe(
    "Restore Title only to your sidebar",
  );
  restore?.props.onClick?.(click(null, null));
  expect(order).toEqual(["restore only", "focus was archived"]);
});

test("restoring one of several entries focuses the neighbouring Restore", () => {
  focusLog.length = 0;
  const tree = HiddenList({
    entries: [entry("a"), entry("b")],
    onOpenEntry: () => {},
    onRestore: () => {},
    focusFallback: () => focusable("archived"),
    className: "",
  });
  const [first] = restoreButtons(tree);
  first?.props.onClick?.(click(sibling(focusable("restore b")), null));
  expect(focusLog).toEqual(["restore b"]);
});

test("the list closes when it empties and does not reopen by itself", () => {
  // Opened with two entries, then both restored (here or on another device).
  let open = nextListOpen(true, 2);
  expect(open).toBe(true);
  open = nextListOpen(open, 1);
  expect(open).toBe(true);
  open = nextListOpen(open, 0);
  expect(open).toBe(false);
  // Something is hidden again: the row returns, the list stays shut.
  open = nextListOpen(open, 1);
  expect(open).toBe(false);
});

test("HiddenEntry closes its list from an effect on the entry count", async () => {
  const source = await Bun.file(
    new URL("./HiddenEntry.tsx", import.meta.url),
  ).text();
  expect(source).toMatch(
    /useEffect\(\(\) => \{\s*setOpen\(\(current\) => nextListOpen\(current, count\)\);\s*\}, \[count\]\);/,
  );
});
