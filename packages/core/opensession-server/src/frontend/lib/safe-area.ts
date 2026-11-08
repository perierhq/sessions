/**
 * The safe-area insets in px, for the few placements made in script.
 *
 * `env(safe-area-inset-*)` only resolves inside a property value; reading the
 * `--sa-*` tokens (styles/base-theme.css) back from script gives the unresolved
 * `env(...)` text. A hidden fixed probe padded by the four tokens resolves them
 * and is reused across calls. Every inset is 0 where the browser reports none.
 */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

let probe: HTMLDivElement | undefined;

export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === "undefined" || !document.body)
    return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:var(--sa-t) var(--sa-r) var(--sa-b) var(--sa-l)";
    document.body.appendChild(probe);
  }
  const style = getComputedStyle(probe);
  const px = (value: string) => Number.parseFloat(value) || 0;
  return {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
}
