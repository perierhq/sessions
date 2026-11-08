import { expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";
import {
  APP_ROOT,
  SIDEBAR_COLUMN_DESKTOP,
  WORKSPACE_SHELL,
} from "../lib/app-shell-classes";
import { appHeader } from "../lib/app-header-classes";
import { DESK_FAB, MOBILE_FAB } from "../lib/fab-classes";
import { VIEWER_INPUT } from "../lib/session-viewer-classes";

test("each safe-area edge has its own token", async () => {
  const css = await readBaseCss();
  for (const [token, edge] of [
    ["--sa-t", "top"],
    ["--sa-r", "right"],
    ["--sa-b", "bottom"],
    ["--sa-l", "left"],
  ])
    expect(css).toContain(`${token}: env(safe-area-inset-${edge}, 0px)`);
});

test("the phone layout clears both side insets, each on its own", () => {
  expect(APP_ROOT).toContain("phone:pl-[var(--sa-l)]");
  expect(APP_ROOT).toContain("phone:pr-[var(--sa-r)]");
  // Fixed chrome sits outside the app root's padding and adds its own.
  const floating = appHeader({ detail: true, floating: true });
  expect(floating).toContain("phone:pl-[calc(12px+var(--sa-l))]");
  expect(floating).toContain("phone:pr-[calc(12px+var(--sa-r))]");
  expect(MOBILE_FAB).toContain("var(--sa-r)");
  expect(DESK_FAB).toContain("var(--sa-r)");
});

test("desktop columns reach the screen edge and inset their content", () => {
  for (const edge of [
    "pt-[var(--sa-t)]",
    "pb-[var(--sa-b)]",
    "pl-[var(--sa-l)]",
  ])
    expect(SIDEBAR_COLUMN_DESKTOP).toContain(edge);
  expect(SIDEBAR_COLUMN_DESKTOP).toContain(
    "w-[calc(var(--sidebar-w,280px)+var(--sa-l))]",
  );
  expect(WORKSPACE_SHELL).toContain("desktop:pt-[var(--sa-t)]");
  expect(WORKSPACE_SHELL).toContain("desktop:pr-[var(--sa-r)]");
  // The composer takes the larger of its gap and the home indicator, not both.
  expect(VIEWER_INPUT).toContain("pb-[max(14px,var(--sa-b))]");
});

test("fold layouts are enhancements keyed on viewport segments", () => {
  expect(SIDEBAR_COLUMN_DESKTOP).toContain(
    "[@media(horizontal-viewport-segments:2)]:w-[env(viewport-segment-width_0_0)]",
  );
  expect(WORKSPACE_SHELL).toContain(
    "[@media(horizontal-viewport-segments:2)]:ml-[calc(env(viewport-segment-left_1_0)_-_env(viewport-segment-right_0_0))]",
  );
  expect(VIEWER_INPUT).toContain("[@media(vertical-viewport-segments:2)]");
  // The keyboard pins the composer to its own edge; the fold must let go.
  expect(VIEWER_INPUT).toContain("[body:not(.kb-open)_&]");
});
