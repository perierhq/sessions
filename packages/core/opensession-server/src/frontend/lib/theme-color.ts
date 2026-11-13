import { PHONE_QUERY } from "./breakpoints";

/**
 * `<meta name="theme-color">`: the colour the system paints next to the page.
 * Two places read it. The installed iPhone app paints its opaque status bar
 * with it, directly above the page's top edge, and an installed desktop PWA
 * paints the window-controls caption band with it, beside our own titlebar.
 * Either way a value that differs from the page's top edge shows as a band, so
 * this follows the surface actually along that edge, per layout and per theme.
 *
 * - Phone: `--bg` on every route. The root list, Feed and a session float the
 *   top bar over the page, and its scroll edge starts as solid `--bg`
 *   (APP_HEADER_OVERLAY in lib/app-header-classes.ts), even over the root
 *   list's `--sidebar-bg`. Every other pushed page draws its bar transparent
 *   over the app root's `--bg` (APP_HEADER_DETAIL, APP_ROOT).
 * - Desktop: `--topbar-bg`, the titlebar the caption band sits beside.
 *
 * The colour is read from the token's computed value, so the palette stays
 * defined in styles/base-theme.css alone.
 */
export function themeColorToken(phone: boolean): "--bg" | "--topbar-bg" {
  return phone ? "--bg" : "--topbar-bg";
}

/**
 * Write the top edge's colour into the theme-color meta. Returns false when
 * the stylesheet that defines the tokens has not loaded yet (the token reads
 * empty), leaving the meta's current value in place.
 */
export function syncThemeColor(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined")
    return false;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return false;
  const phone = window.matchMedia?.(PHONE_QUERY).matches ?? false;
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(themeColorToken(phone))
    .trim();
  if (!color) return false;
  if (meta.getAttribute("content") !== color)
    meta.setAttribute("content", color);
  return true;
}

let watching = false;

/**
 * Keep theme-color in step with what can move the top edge: the breakpoint
 * (a desktop window narrowed to phone width) and, when the tokens are not in
 * yet at import, the stylesheet arriving. Theme changes go through applyTheme,
 * which calls syncThemeColor itself.
 */
export function watchThemeColor() {
  if (watching || typeof window === "undefined" || !window.matchMedia) return;
  watching = true;
  window.matchMedia(PHONE_QUERY).addEventListener?.("change", () => {
    syncThemeColor();
  });
  if (!syncThemeColor())
    window.addEventListener("load", () => syncThemeColor(), { once: true });
}
