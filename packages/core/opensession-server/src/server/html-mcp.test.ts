import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlRenderFromResult } from "@tellahq/opensession-protocol/html-render";
import { previewHtml, renderHtml, type HtmlToolsDeps } from "./html-mcp";
import {
  injectBootstrap,
  inlineLocalImages,
  renderSlug,
} from "./html-render/document";
import {
  BrowserUnavailableError,
  type HeadlessPage,
} from "./html-render/headless";
import { isLocalAddress } from "./html-render/public-proxy";
import { isHtmlRenderAsset } from "./routes/session-assets";

const dir = mkdtempSync(join(tmpdir(), "html-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeBrowser(heightAt: (width: number) => number) {
  const loaded: string[] = [];
  const browser: HtmlToolsDeps["browser"] = async (options, fn) => {
    let width = options.width;
    const page: HeadlessPage = {
      consoleMessages: [{ level: "error", text: "ReferenceError: x" }],
      notes: [],
      async load(html) {
        loaded.push(html);
        return heightAt(width);
      },
      async measureAt(w) {
        width = w;
        return heightAt(w);
      },
      async screenshot() {
        return "cG5n";
      },
    };
    return fn(page);
  };
  return { browser, loaded };
}

describe("injectBootstrap", () => {
  test("goes after the doctype, ahead of the page", () => {
    const page = injectBootstrap(
      '<!DOCTYPE html><html lang="en"><head><style>:root{--x:1}</style></head><body>x</body></html>',
    );
    expect(page.startsWith("<!DOCTYPE html><meta charset")).toBe(true);
    expect(page.indexOf('<style id="os-theme">')).toBeLessThan(
      page.indexOf(":root{--x:1}"),
    );
  });

  test("adds a doctype to a fragment", () => {
    const page = injectBootstrap("<p>hi</p>");
    expect(page.startsWith("<!doctype html><meta charset")).toBe(true);
    expect(page.endsWith("<p>hi</p>")).toBe(true);
  });

  test("defaults follow the OS appearance", () => {
    const page = injectBootstrap("<p>hi</p>");
    expect(page).toContain("--background:#1c1c1c");
    expect(page).toContain("@media (prefers-color-scheme: light)");
  });
});

describe("inlineLocalImages", () => {
  test("inlines existing absolute paths and reports the rest", async () => {
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from([137, 80, 78, 71]));
    const out = await inlineLocalImages(
      `<img src="${png}"><div style="background:url(${png})"></div><img src="/nope/missing.png">`,
    );
    expect(out.html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(out.html).toContain("url(data:image/png;base64,iVBORw==)");
    expect(out.missing).toEqual(["/nope/missing.png"]);
  });

  test("leaves remote URLs alone", async () => {
    const html = '<img src="https://cdn.example.test/a.png">';
    expect((await inlineLocalImages(html)).html).toBe(html);
  });
});

describe("renderHtml", () => {
  test("stores the page, measures it, and answers with a reference", async () => {
    const { browser, loaded } = fakeBrowser((w) => (w < 500 ? 800 : 420));
    const writes: Array<{ path: string; data: string }> = [];
    const result = await renderHtml(
      {
        sessionId: "os-1",
        html: "<p>fit</p>",
        title: "Monitor clamp fit",
        height: 500,
      },
      {
        browser,
        now: () => 1_000_000,
        writeAsset: async (_id, path, data) => {
          writes.push({ path, data: data.toString() });
          return {} as never;
        },
      },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.htmlRender.path).toBe(
      "html-renders/monitor-clamp-fit-lfls.html",
    );
    expect(result.htmlRender.url).toBe(
      "/api/sessions/os-1/assets/raw/html-renders/monitor-clamp-fit-lfls.html",
    );
    expect(result.htmlRender.heights?.[0]).toEqual([320, 800]);
    expect(result.htmlRender.heights?.at(-1)).toEqual([1160, 420]);
    expect(writes[0]!.data).toContain('<style id="os-theme">');
    expect(loaded[0]).toBe(writes[0]!.data);
    expect(result.consoleMessages[0]!.level).toBe("error");
    // The tool's text answer is what clients read.
    expect(
      htmlRenderFromResult(
        JSON.stringify({ htmlRender: result.htmlRender, message: "ok" }),
      ),
    ).toEqual(result.htmlRender);
  });

  test("still renders without a browser, unmeasured", async () => {
    const result = await renderHtml(
      { sessionId: "os-1", html: "<p>x</p>", title: "X", height: 300 },
      {
        browser: async () => {
          throw new BrowserUnavailableError("No Chrome.");
        },
        now: () => 1,
        writeAsset: async () => ({}) as never,
      },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.htmlRender.heights).toBeUndefined();
    expect(result.notes[0]).toContain("No Chrome.");
  });

  test("refuses missing images and oversized pages", async () => {
    const deps = {
      browser: fakeBrowser(() => 100).browser,
      now: () => 1,
      writeAsset: async () => ({}) as never,
    };
    const missing = await renderHtml(
      {
        sessionId: "s",
        html: '<img src="/nope/a.png">',
        title: "t",
        height: 100,
      },
      deps,
    );
    expect("error" in missing && missing.error).toContain("/nope/a.png");
    const big = await renderHtml(
      { sessionId: "s", html: "x".repeat(600_000), title: "t", height: 100 },
      deps,
    );
    expect("error" in big && big.error).toContain("limit");
  });
});

describe("previewHtml", () => {
  test("an artifact preview is the fence's own document", async () => {
    const { browser, loaded } = fakeBrowser(() => 240);
    const result = await previewHtml(
      { html: "<p>hi</p>", mode: "artifact", appearance: "light" },
      { browser },
    );
    if ("error" in result) throw new Error(String(result.error));
    expect(result.contentHeight).toBe(240);
    expect(loaded[0]).toContain("Content-Security-Policy");
    expect(loaded[0]).toContain("--background:#ffffff");
    expect(loaded[0]).not.toContain('id="os-theme"');
  });

  test("a render preview carries the bootstrap and clamps the capture", async () => {
    const { browser, loaded } = fakeBrowser(() => 5000);
    const result = await previewHtml(
      { html: "<p>hi</p>", width: 99 },
      { browser },
    );
    if ("error" in result) throw new Error(String(result.error));
    expect(result.width).toBe(240);
    expect(result.capturedHeight).toBe(2000);
    expect(loaded[0]).toContain('id="os-theme"');
  });
});

describe("guards", () => {
  test("the proxy refuses local and private addresses", () => {
    for (const [address, family] of [
      ["127.0.0.1", 4],
      ["10.1.2.3", 4],
      ["169.254.169.254", 4],
      ["100.100.1.1", 4],
      ["::1", 6],
      ["::ffff:127.0.0.1", 6],
      ["fd00::1", 6],
      ["64:ff9b::a9fe:a9fe", 6],
      ["198.18.0.1", 4],
      ["192.0.0.170", 4],
      ["::8.8.8.8", 6],
      ["2001::1", 6],
      ["2002:a9fe:a9fe::1", 6],
      ["fe80::1", 6],
      ["ff02::1", 6],
    ] as const)
      expect(isLocalAddress(address, family)).toBe(true);
    expect(isLocalAddress("93.184.216.34", 4)).toBe(false);
    expect(isLocalAddress("2606:4700::1111", 6)).toBe(false);
    expect(isLocalAddress("64:ff9b::808:808", 6)).toBe(false);
  });

  test("only stored renders get the render policy", () => {
    expect(isHtmlRenderAsset("html-renders/a-1.html")).toBe(true);
    expect(isHtmlRenderAsset("reports/a.html")).toBe(false);
    expect(isHtmlRenderAsset("html-renders/a.png")).toBe(false);
  });

  test("slugs", () => {
    expect(renderSlug("Monitor clamp: fit?")).toBe("monitor-clamp-fit");
    expect(renderSlug("!!!")).toBe("page");
  });
});
