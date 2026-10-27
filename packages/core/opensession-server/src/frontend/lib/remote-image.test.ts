import { afterEach, describe, expect, it } from "bun:test";
import {
  inlineImageSrc,
  isSlackHostedImage,
  remoteMediaMarkup,
} from "./remote-image";

// Outside a browser the app's own origin is the configured public base, which
// falls back to the local server (brand.ts).
const OWN = "http://127.0.0.1:3850";

describe("inlineImageSrc", () => {
  it("keeps same-origin paths as written", () => {
    expect(inlineImageSrc("/media?path=%2Ftmp%2Fshot.png")).toBe(
      "/media?path=%2Ftmp%2Fshot.png",
    );
    expect(inlineImageSrc("shot.png")).toBe("shot.png");
    expect(inlineImageSrc("/gh-asset/abc?repo=acme")).toBe(
      "/gh-asset/abc?repo=acme",
    );
  });

  it("keeps data: and blob: images, which fetch nothing", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    expect(inlineImageSrc(data)).toBe(data);
    const blob = `blob:${OWN}/7c1d`;
    expect(inlineImageSrc(blob)).toBe(blob);
  });

  it("serves an absolute URL on this app's origin from the current origin", () => {
    expect(inlineImageSrc(`${OWN}/media?path=%2Ftmp%2Fa.png#x`)).toBe(
      "/media?path=%2Ftmp%2Fa.png#x",
    );
  });

  it("refuses every other host", () => {
    for (const href of [
      "https://acme.example.test/pixel.png?q=1",
      "http://acme.example.test/a.png",
      "//acme.example.test/a.png",
      "/\\acme.example.test/a.png",
      " https://acme.example.test/a.png",
      "https://avatars.githubusercontent.com/u/1",
      `${OWN}.example.test/a.png`,
      "http://127.0.0.1:3851/a.png",
    ])
      expect(inlineImageSrc(href)).toBeNull();
  });

  it("refuses an empty or unusable source", () => {
    expect(inlineImageSrc("")).toBeNull();
    expect(inlineImageSrc(undefined)).toBeNull();
    expect(inlineImageSrc("http://[::1")).toBeNull();
  });
});

describe("inlineImageSrc on this instance's other origins", () => {
  // SAFETY: tests run without a DOM. The instance blob is read when an image
  // is checked, so setting a window here stands in for the served page.
  const scope = globalThis as { window?: unknown };
  const before = scope.window;
  // What a served page could hold, malformed entries included.
  type Blob = {
    appOrigins?: string | readonly (string | number)[];
    mediaOrigins?: string | readonly (string | number)[];
  };
  const instance = (blob: Blob) => {
    scope.window = { __OPENSESSION_INSTANCE__: blob };
  };
  afterEach(() => {
    scope.window = before;
  });

  const INGRESS = "https://ingress.acme.example.test";
  const MEDIA = "https://media.acme.example.test";
  const shot = "/pr-images/0123456789abcdef0123456789abcdef/after.png";

  it("loads a PR screenshot from the public ingress or image host as written", () => {
    instance({ mediaOrigins: [INGRESS, MEDIA] });
    expect(inlineImageSrc(`${INGRESS}${shot}`)).toBe(`${INGRESS}${shot}`);
    expect(inlineImageSrc(`${MEDIA}${shot}?v=2`)).toBe(`${MEDIA}${shot}?v=2`);
  });

  it("serves a private app alias from the current origin", () => {
    instance({ appOrigins: ["https://os.acme.example.test"] });
    expect(
      inlineImageSrc("https://os.acme.example.test/media?path=%2Ftmp%2Fa.png"),
    ).toBe("/media?path=%2Ftmp%2Fa.png");
  });

  it("matches the whole origin, not a host that starts the same", () => {
    instance({
      appOrigins: ["https://os.acme.example.test"],
      mediaOrigins: [INGRESS],
    });
    for (const href of [
      `http://ingress.acme.example.test${shot}`,
      `${INGRESS}:8443${shot}`,
      `${INGRESS}.example.test${shot}`,
      "https://acme.example.test/a.png",
    ])
      expect(inlineImageSrc(href)).toBeNull();
  });

  it("ignores a blob entry that is not a list of web origins", () => {
    instance({ mediaOrigins: "https://acme.example.test" });
    expect(inlineImageSrc("https://acme.example.test/a.png")).toBeNull();
    instance({ mediaOrigins: ["javascript:alert(1)", 7] });
    expect(inlineImageSrc("javascript:alert(1)")).toBeNull();
  });
});

describe("remoteMediaMarkup", () => {
  const href = "https://acme.example.test/pixel.png?q=1&r=2";

  it("names the host and links out instead of loading", () => {
    const html = remoteMediaMarkup(href, { kind: "image", alt: "Chart" });
    expect(html).not.toContain("<img");
    expect(html).toStartWith(
      `<a href="https://acme.example.test/pixel.png?q=1&amp;r=2" class="md-remote-media" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"`,
    );
    expect(html).toContain(
      '<span class="md-remote-media-label">Image from acme.example.test</span>',
    );
    expect(html).toContain('<span class="md-remote-media-action">Open</span>');
    expect(html).toContain('title="Chart"');
  });

  it("says video for a video", () => {
    expect(
      remoteMediaMarkup("https://acme.example.test/a.mp4", { kind: "video" }),
    ).toContain("Video from acme.example.test");
  });

  it("is not a second link inside a link", () => {
    const html = remoteMediaMarkup(href, { kind: "image", inLink: true });
    expect(html).toStartWith(
      '<span class="md-remote-media md-remote-media-inline" title="acme.example.test">',
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("md-remote-media-action");
  });

  it("never links a scheme that is not the web", () => {
    const html = remoteMediaMarkup("javascript:void(0)", { kind: "image" });
    expect(html).toStartWith('<span class="md-remote-media"');
    expect(html).not.toContain("href=");
    expect(html).toContain("Image from another site");
  });

  it("escapes what it echoes", () => {
    const html = remoteMediaMarkup(href, {
      kind: "image",
      alt: '"><b>x</b>',
    });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&quot;&gt;&lt;b&gt;");
  });
});

describe("isSlackHostedImage", () => {
  it("accepts the workspace emoji Slack serves from its own CDN", () => {
    expect(
      isSlackHostedImage("https://emoji.slack-edge.com/T01/party/abc.png"),
    ).toBe(true);
  });

  it("refuses any other host, or Slack's over plain http", () => {
    for (const href of [
      "https://acme.example.test/party.png",
      "https://slack-edge.com.example.test/a.png",
      "http://emoji.slack-edge.com/T01/party/abc.png",
      "not a url",
    ])
      expect(isSlackHostedImage(href)).toBe(false);
  });
});
