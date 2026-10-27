import { describe, expect, it } from "bun:test";
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
