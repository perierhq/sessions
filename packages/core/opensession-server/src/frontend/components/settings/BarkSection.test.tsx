// Settings, Notifications, iPhone through Bark: what the section shows for
// the settings the server returns. The server turns Bark on with the first
// device key (server/bark.ts), and the section shows what it returns.
// Rendered to markup; no effects run.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SWRConfig, unstable_serialize } from "swr";
import type { BarkSettings } from "../../lib/api/bark";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  fetch: () => new Promise<Response>(() => {}),
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { BarkSection } = await import("./BarkSection");
const { getCurrentUser } = await import("../UserPicker");

const base: BarkSettings = {
  enabled: false,
  serverUrl: "https://api.day.app",
  openIn: "blob",
  speak: false,
  speakAvailable: false,
  deviceKey: null,
  encryption: null,
};

function render(settings: BarkSettings) {
  const key = unstable_serialize(["api", "supervisor-bark", getCurrentUser()]);
  return renderToStaticMarkup(
    <SWRConfig value={{ fallback: { [key]: settings } }}>
      <BarkSection />
    </SWRConfig>,
  );
}

/** The opening tag of the element carrying this attribute. */
function tag(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

function sendTest(html: string): string {
  const at = html.indexOf("Send test</span></button>");
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", open) + 1);
}

describe("BarkSection", () => {
  test("no key: the switch is off and locked, and there is nothing to test", () => {
    const html = render(base);
    const toggle = tag(html, 'aria-label="Send to Bark"');
    expect(toggle).toContain('aria-checked="false"');
    expect(toggle).toContain('aria-disabled="true"');
    expect(sendTest(html)).toContain('disabled=""');
  });

  test("after the first key is saved: the switch shows on and Send test stays", () => {
    const html = render({ ...base, enabled: true, deviceKey: "••••abcd" });
    const toggle = tag(html, 'aria-label="Send to Bark"');
    expect(toggle).toContain('aria-checked="true"');
    expect(toggle).not.toContain("aria-disabled");
    expect(html).toContain("Saved: ••••abcd");
    expect(sendTest(html)).not.toContain('disabled=""');
  });
});
