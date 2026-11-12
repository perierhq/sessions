// Settings, Providers: the Mainspring section in each of its states. Not set
// up (address and key fields, switches off), set up (masked key, Test,
// Remove key, the model list), and the switches. Rendered to markup; no
// effects run.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Mainspring } from "../../lib/mainspring";

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

const { MainspringSection, MainspringView } =
  await import("./MainspringSection");

const notSetUp: Mainspring = {
  url: null,
  keySet: false,
  keyHint: null,
  routeClaude: false,
  fallbackDirect: false,
  models: [],
  modelsAt: null,
};

const setUp: Mainspring = {
  url: "https://mainspring.example.test",
  keySet: true,
  keyHint: "wxyz",
  routeClaude: true,
  fallbackDirect: false,
  models: [
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "gpt-5.6-terra" },
  ],
  modelsAt: "2026-11-12T10:00:00.000Z",
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;|\u2019/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

/** The opening tag of the switch with this accessible name. */
const switchTag = (html: string, label: string) =>
  html.match(new RegExp(`<span[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

/** The opening tag of the button labelled `label`. */
const buttonTag = (html: string, label: string) =>
  html.match(
    new RegExp(`<button[^>]*>(?=<span[^>]*>${label}</span></button>)`),
  )?.[0] ?? "";

const view = (
  settings: Mainspring,
  extra: Partial<React.ComponentProps<typeof MainspringView>> = {},
) => renderToStaticMarkup(<MainspringView settings={settings} {...extra} />);

describe("MainspringSection", () => {
  test("renders nothing until the owner's settings load", () => {
    expect(renderToStaticMarkup(<MainspringSection />)).toBe("");
  });

  test("not set up: address and key fields, Test and the route switch off", () => {
    const html = view(notSetUp);
    const shown = text(html);
    expect(shown).toContain("Mainspring");
    expect(shown).toContain(
      "Mainspring's address and a key from its Keys page.",
    );
    expect(html).toContain('type="url"');
    expect(html).toContain('type="password"');
    expect(html).toContain('placeholder="sk-ms-…"');
    expect(shown).toContain("Save an address and a key first.");
    expect(shown).not.toContain("Remove key");
    expect(shown).not.toContain("Models");
    // Test and the route switch wait for an address and a key.
    expect(buttonTag(html, "Test")).toContain('disabled=""');
    expect(switchTag(html, "Route Claude through Mainspring")).toContain(
      'aria-disabled="true"',
    );
  });

  test("set up: the key shows only masked, with Test, Remove key and the models", () => {
    const html = view(setUp);
    const shown = text(html);
    expect(shown).toContain("https://mainspring.example.test · sk-ms-…wxyz");
    expect(html).toContain('placeholder="sk-ms-…wxyz (paste to replace)"');
    expect(html).toContain('value=""');
    expect(shown).toContain("Remove key");
    expect(shown).toContain("2 models, listed Nov 12");
    expect(shown).toContain("pi/mainspring/<model>");
    expect(shown).toContain("claude-sonnet-5-5");
    expect(shown).toContain("gpt-5.6-terra");
    expect(buttonTag(html, "Test")).not.toContain('disabled=""');
    expect(switchTag(html, "Route Claude through Mainspring")).toContain(
      'aria-checked="true"',
    );
    expect(switchTag(html, "Fall back to direct accounts")).toContain(
      'aria-checked="false"',
    );
  });

  test("a test result and an error read as sentences", () => {
    const ok = text(
      view(setUp, {
        testResult: { ok: true, text: "Connected. 2 models listed." },
      }),
    );
    expect(ok).toContain("Connected. 2 models listed.");
    const refused = text(
      view(setUp, {
        testResult: { ok: false, text: "Mainspring key was refused." },
        error: "A Mainspring key starts with sk-ms-.",
      }),
    );
    expect(refused).toContain("Mainspring key was refused.");
    expect(refused).toContain("A Mainspring key starts with sk-ms-.");
  });
});
