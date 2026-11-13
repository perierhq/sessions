import { describe, expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";
const HTML = new URL("../index.html", import.meta.url);

describe("app viewport", () => {
  test("the app fills its viewport-locked body without remeasuring viewport units", async () => {
    const css = await readBaseCss();
    const root = css.match(/#root\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(css).toMatch(/body\s*\{\s*position:\s*fixed;\s*inset:\s*0;/);
    expect(root).toMatch(/height:\s*100%/);
    expect(root).not.toMatch(/height:\s*100(?:d|l|s)?vh/);
  });

  test("the installed app is a web app through its manifest, not the legacy metas", async () => {
    const html = await Bun.file(HTML).text();

    // Measured on an iPhone Duo: apple-mobile-web-app-capable with a
    // black-translucent status bar cuts the unfolded standalone window short
    // by the status-bar inset. The manifest's display: standalone is enough.
    expect(html).not.toContain('name="apple-mobile-web-app-capable"');
    expect(html).not.toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain('name="apple-mobile-web-app-title"');
    expect(html).toContain('name="theme-color"');
    // Safe-area insets (home indicator, side insets) still apply.
    expect(html).toContain("viewport-fit=cover");
  });

  test("nothing forces the document roots to the screen height", async () => {
    const html = await Bun.file(HTML).text();
    const css = await readBaseCss();

    // screen.height reports the closed display on an open foldable, so a
    // root forced to it is taller or shorter than the window it sits in.
    expect(html).not.toContain("window.screen.height");
    expect(html).not.toContain("style.height");
    expect(css).not.toMatch(/body\.kb-open\s*\{[^}]*height:/);
  });
});
