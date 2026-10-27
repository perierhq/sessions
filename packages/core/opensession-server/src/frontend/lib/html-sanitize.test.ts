import { describe, expect, it } from "bun:test";
import { sanitizeHtmlFragment } from "./html-sanitize";

describe("sanitizeHtmlFragment allowed markup", () => {
  it("keeps the avatar link bots put in a deploy table", () => {
    const html = sanitizeHtmlFragment(
      '<a href="https://vercel.com/tella/internal"><sup><img src="https://vercel.com/api/www/avatar?projectId=prj_x&teamId=team_y&s=32" width="16" height="16" align="middle" alt="" /></sup></a>',
    );
    expect(html).toContain('<a href="https://vercel.com/tella/internal"');
    expect(html).toContain("<sup>");
    // The avatar is on another host: named, not fetched, and not a second
    // link inside the deployment link.
    expect(html).not.toContain("<img");
    expect(html).toContain(
      '<sup><span class="md-remote-media md-remote-media-inline" title="vercel.com">',
    );
    expect(html).toContain("</sup></a>");
  });

  it("keeps a raw same-origin image with the author's sizing", () => {
    const html = sanitizeHtmlFragment(
      '<img src="/uploads/a.png?s=32&v=2" width="16" height="16" align="middle" alt="" />',
    );
    expect(html).toContain('width="16"');
    expect(html).toContain('align="middle"');
    // A raw ampersand in a query string is not an entity to preserve.
    expect(html).toContain('src="/uploads/a.png?s=32&amp;v=2"');
  });

  it("sends an external link to a new tab, leaves an anchor in place", () => {
    expect(
      sanitizeHtmlFragment('<a href="https://example.com">x</a>'),
    ).toContain('target="_blank" rel="noopener noreferrer"');
    expect(sanitizeHtmlFragment('<a href="#notes">x</a>')).not.toContain(
      "target=",
    );
  });

  it("tags raw images so they render inline", () => {
    expect(sanitizeHtmlFragment('<img src="/uploads/a.svg">')).toBe(
      '<img src="/uploads/a.svg" class="md-inline-image" loading="lazy" />',
    );
  });

  it("names a raw image from another host instead of loading it", () => {
    const html = sanitizeHtmlFragment(
      '<img src="https://acme.example.test/a.png?q=1" alt="chart">',
    );
    expect(html).not.toContain("<img");
    expect(html).toStartWith(
      '<a href="https://acme.example.test/a.png?q=1" class="md-remote-media"',
    );
    expect(html).toContain("Image from acme.example.test");
  });

  it("tracks raw links across fragments of one document", () => {
    const links = { depth: 0 };
    sanitizeHtmlFragment('<a href="https://acme.example.test">', { links });
    expect(links.depth).toBe(1);
    expect(
      sanitizeHtmlFragment('<img src="https://acme.example.test/a.png">', {
        links,
      }),
    ).toStartWith('<span class="md-remote-media md-remote-media-inline"');
    sanitizeHtmlFragment("</a>", { links });
    expect(links.depth).toBe(0);
  });

  it("rewrites an image source before deciding", () => {
    expect(
      sanitizeHtmlFragment('<img src="https://acme.example.test/a.png">', {
        imageSrc: () => "/gh-asset/abc?repo=acme",
      }),
    ).toBe(
      '<img src="/gh-asset/abc?repo=acme" class="md-inline-image" loading="lazy" />',
    );
  });

  it("keeps text between tags, escaping stray brackets", () => {
    expect(sanitizeHtmlFragment("<kbd>a</kbd> 3 < 4 &amp; 5")).toBe(
      "<kbd>a</kbd> 3 &lt; 4 &amp; 5",
    );
  });

  it("keeps a theme-aware picture", () => {
    const html = sanitizeHtmlFragment(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="/uploads/dark.png 1x, /uploads/dark@2x.png 2x"><img src="/uploads/light.png"></picture>',
    );
    expect(html).toContain("<picture>");
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
    expect(html).toContain("/uploads/dark@2x.png 2x");
    expect(html).toContain("</picture>");
  });

  it("drops a picture source that would load from another host", () => {
    const html = sanitizeHtmlFragment(
      '<picture><source srcset="/uploads/a.png 1x, https://acme.example.test/a@2x.png 2x"><img src="/uploads/a.png"></picture>',
    );
    expect(html).toBe(
      '<picture><img src="/uploads/a.png" class="md-inline-image" loading="lazy" /></picture>',
    );
  });

  it("keeps the relative timestamp in Vercel deployment tables", () => {
    expect(
      sanitizeHtmlFragment(
        '<relative-time datetime="2026-09-01T09:52:50.595Z">Sep 1, 2026 9:52am UTC</relative-time>',
      ),
    ).toBe(
      '<relative-time datetime="2026-09-01T09:52:50.595Z">Sep 1, 2026 9:52am UTC</relative-time>',
    );
  });

  it("drops a srcset with an unsafe candidate", () => {
    expect(
      sanitizeHtmlFragment(
        '<source srcset="https://x/a.png 1x, javascript:alert(1) 2x">',
      ),
    ).not.toContain("srcset");
  });

  it("drops HTML comments", () => {
    expect(sanitizeHtmlFragment("<!-- os-review --><b>hi</b>")).toBe(
      "<b>hi</b>",
    );
  });
});

describe("sanitizeHtmlFragment untrusted markup", () => {
  it("escapes tags that are not on the allowlist", () => {
    expect(sanitizeHtmlFragment("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(
      sanitizeHtmlFragment('<iframe src="https://evil.test"></iframe>'),
    ).toBe('&lt;iframe src="https://evil.test"&gt;&lt;/iframe&gt;');
    // A stray closing tag can't tear its way out of the container either.
    expect(sanitizeHtmlFragment("</section>")).toBe("&lt;/section&gt;");
    expect(sanitizeHtmlFragment("<unsafe-widget>x</unsafe-widget>")).toBe(
      "&lt;unsafe-widget&gt;x&lt;/unsafe-widget&gt;",
    );
  });

  it("drops every attribute that is not allowed for the tag", () => {
    expect(
      sanitizeHtmlFragment('<img src="x.png" onerror="alert(1)">'),
    ).not.toContain("onerror");
    expect(sanitizeHtmlFragment('<b style="position:fixed">x</b>')).toBe(
      "<b>x</b>",
    );
    expect(
      sanitizeHtmlFragment(
        '<a href="https://ok.test" onclick="alert(1)">x</a>',
      ),
    ).not.toContain("onclick");
  });

  it("drops a URL whose scheme is not http, https or mailto", () => {
    expect(sanitizeHtmlFragment('<a href="javascript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
    // Browsers ignore control characters when parsing a scheme.
    expect(sanitizeHtmlFragment('<a href="java\tscript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
    expect(sanitizeHtmlFragment('<img src="data:text/html,<script>">')).toBe(
      '<img class="md-inline-image" loading="lazy" />',
    );
  });

  it("cannot smuggle a scheme through an entity", () => {
    // The entity is not a scheme this allowlist knows, so the href goes;
    // were it kept, escaping the value would leave it literal text anyway.
    expect(
      sanitizeHtmlFragment('<a href="&#106;avascript:alert(1)">x</a>'),
    ).toBe("<a>x</a>");
  });

  it("cannot close its own attribute to add another", () => {
    const html = sanitizeHtmlFragment(
      '<a href="https://ok.test&quot; onmouseover=&quot;alert(1)">x</a>',
    );
    expect(html).not.toContain('onmouseover="');
  });
});
