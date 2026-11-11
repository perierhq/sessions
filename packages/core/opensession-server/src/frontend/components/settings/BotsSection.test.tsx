// Settings, Members: the Bots group under the people. Blob's row with its
// picture, Bot badge and role, its state for you, each lead's stage linking
// to the project's Lead section, the needs-you count, and the loading and
// unreadable states. Rendered to markup; no effects run.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BlobSummary } from "../../lib/blob-member";

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
  // The roster fetch never lands here: the built-in Blob is what shows.
  fetch: () => new Promise<Response>(() => {}),
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { BotsSection, BlobMemberCard } = await import("./BotsSection");

const blob = {
  kind: "bot" as const,
  name: "Blob",
  fullName: "Blob",
  image: "/bot-icon/blob.png",
};

const summary: BlobSummary = {
  prefs: {
    quietStart: "22:00",
    quietEnd: "07:00",
    digestAt: "09:00",
    timezone: "",
    effectiveTimezone: "Europe/Warsaw",
    watch: { enabled: true, activeStart: "08:00", activeEnd: "20:00" },
  },
  leads: [
    {
      project: "acme-web",
      label: "Acme web",
      enabled: true,
      stage: "coordinate",
    },
    { project: "acme-api", label: "Acme API", enabled: true, stage: "watch" },
    { project: "acme-docs", label: "Acme docs", enabled: false, stage: "act" },
  ],
  needsYou: 3,
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;|\u2019/g, "'")
    .replace(/\s+/g, " ");

describe("BotsSection", () => {
  test("lists the built-in Blob under Bots before any server answers", () => {
    const html = renderToStaticMarkup(<BotsSection />);
    const shown = text(html);
    expect(shown).toContain("Bots");
    expect(shown).toContain("Blob Bot");
    expect(shown).toContain(
      "Your supervisor. Runs the project leads and tells you what needs you.",
    );
    expect(html).toContain('src="/bot-icon/blob.png"');
    expect(html).not.toMatch(/remove/i);
  });
});

describe("BlobMemberCard", () => {
  const html = renderToStaticMarkup(
    <BlobMemberCard bot={blob} summary={summary} />,
  );
  const shown = text(html);

  test("summarises the supervisor's state for you", () => {
    expect(shown).toContain("Watch On, 08:00 to 20:00");
    expect(shown).toContain("Quiet hours 22:00 to 07:00");
    expect(shown).toContain("Daily digest 09:00");
    expect(shown).toContain("Time zone Europe/Warsaw");
    expect(shown).toContain("Needs you 3 open");
  });

  test("shows each lead's stage, Off when disabled, linking to its Lead section", () => {
    expect(shown).toContain("Acme web Coordinate");
    expect(shown).toContain("Acme API Watch");
    expect(shown).toContain("Acme docs Off");
    expect(html).toContain('href="/settings/projects/acme-web/lead"');
    expect(html).toContain('href="/settings/projects/acme-docs/lead"');
  });

  test("links to Blob's settings and offers no edit or remove", () => {
    expect(html).toContain('href="/settings/notifications"');
    expect(shown).toContain("Notification settings");
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/remove|delete/i);
  });

  test("loading keeps the rows' shape, and unreadable parts say so", () => {
    const loading = renderToStaticMarkup(
      <BlobMemberCard bot={blob} summary={null} />,
    );
    expect(loading).toContain('aria-busy="true"');
    expect(text(loading)).toContain("Quiet hours");

    const failed = text(
      renderToStaticMarkup(
        <BlobMemberCard
          bot={blob}
          summary={{ prefs: null, leads: null, needsYou: null }}
        />,
      ),
    );
    expect(failed).toContain("Couldn't load Blob's settings.");
    expect(failed).toContain("Couldn't load the project leads.");

    const none = text(
      renderToStaticMarkup(
        <BlobMemberCard bot={blob} summary={{ ...summary, leads: [] }} />,
      ),
    );
    expect(none).toContain("No project has a lead yet.");
  });
});
