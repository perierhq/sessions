import { afterEach, describe, expect, test } from "bun:test";
import { APP_ROOT } from "./app-shell-classes";
import { appHeader } from "./app-header-classes";
import { PHONE_QUERY } from "./breakpoints";
import { syncThemeColor, themeColorToken } from "./theme-color";

const BASE_THEME = new URL("../styles/base-theme.css", import.meta.url);
const saved = {
  document: globalThis.document,
  window: globalThis.window,
  getComputedStyle: globalThis.getComputedStyle,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    Object.defineProperty(globalThis, key, { value, configurable: true });
});

/** A document whose tokens are `tokens`, at phone width or not. */
function install(tokens: Record<string, string>, phone: boolean) {
  let content = "#222222";
  const meta = {
    getAttribute: () => content,
    setAttribute: (_name: string, value: string) => {
      content = value;
    },
  };
  const root = {};
  Object.defineProperty(globalThis, "document", {
    value: {
      documentElement: root,
      querySelector: (selector: string) =>
        selector === 'meta[name="theme-color"]' ? meta : null,
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      matchMedia: (query: string) => ({
        matches: query === PHONE_QUERY && phone,
      }),
    },
    configurable: true,
  });
  // Only the root's tokens are read, so every element answers with them.
  Object.defineProperty(globalThis, "getComputedStyle", {
    value: () => ({
      getPropertyValue: (name: string) => tokens[name] ?? "",
    }),
    configurable: true,
  });
  return () => content;
}

/** Each theme's value for a token, as styles/base-theme.css declares it. */
async function tokenValues(name: string) {
  const css = await Bun.file(BASE_THEME).text();
  const darkStart = css.indexOf(":root");
  const lightStart = css.indexOf('[data-theme="light"]');
  const read = (from: number, to: number) => {
    const block = css.slice(from, to);
    const value = block.match(new RegExp(`\\s${name}:\\s*([^;]+);`))?.[1];
    if (!value) throw new Error(`${name} not found`);
    return value.trim();
  };
  return {
    dark: read(darkStart, lightStart),
    light: read(lightStart, css.length),
  };
}

describe("theme-color", () => {
  test("follows the page on a phone and the titlebar on desktop", () => {
    expect(themeColorToken(true)).toBe("--bg");
    expect(themeColorToken(false)).toBe("--topbar-bg");
  });

  test("writes the computed token value for the current layout and theme", async () => {
    const bg = await tokenValues("--bg");
    const sidebar = await tokenValues("--sidebar-bg");
    for (const theme of ["dark", "light"] as const) {
      // --topbar-bg is var(--sidebar-bg); computed style resolves it.
      const tokens = {
        "--bg": bg[theme],
        "--topbar-bg": sidebar[theme],
      };
      const phone = install(tokens, true);
      expect(syncThemeColor()).toBe(true);
      expect(phone()).toBe(bg[theme]);

      const desktop = install(tokens, false);
      expect(syncThemeColor()).toBe(true);
      expect(desktop()).toBe(sidebar[theme]);
    }
  });

  test("keeps the current value until the tokens have loaded", () => {
    const content = install({}, true);
    expect(syncThemeColor()).toBe(false);
    expect(content()).toBe("#222222");
  });

  test("the phone top edge is --bg on every route", () => {
    // The floating bar (root list, Feed, session) starts its scroll edge as
    // solid --bg, over the root list's sidebar colour too.
    expect(appHeader({ detail: false, floating: true })).toContain(
      "linear-gradient(to_bottom,var(--bg)_0%",
    );
    expect(appHeader({ detail: true, floating: true })).toContain(
      "linear-gradient(to_bottom,var(--bg)_0%",
    );
    // Other pushed pages draw the bar transparent over the app root, whose
    // phone fill is the page colour (bg-surface is --bg).
    expect(appHeader({ detail: true, floating: false })).toContain(
      "phone:bg-transparent",
    );
    expect(APP_ROOT).toContain("phone:bg-surface");
  });
});
