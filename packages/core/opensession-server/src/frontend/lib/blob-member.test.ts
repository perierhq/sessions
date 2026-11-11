// Blob's summary in Settings, Members: the three reads, the needs-you count
// and its cap, the wording of each fact, and a missing route (an old server)
// leaving only that part empty.
import { describe, expect, test } from "bun:test";
import type { LeadRosterEntry } from "../../shared/project-lead";
import {
  blobFacts,
  leadStateLabel,
  loadBlobSummary,
  needsYouCopy,
  NEEDS_YOU_LIMIT,
  type BlobPrefs,
  type GetFetch,
} from "./blob-member";

const prefs: BlobPrefs = {
  quietStart: "02:00",
  quietEnd: "08:00",
  digestAt: "09:00",
  timezone: "",
  effectiveTimezone: "Europe/Warsaw",
  watch: { enabled: true, activeStart: "08:00", activeEnd: "22:00" },
};

/** The bodies the three routes answer; a missing one is a 404. */
interface StubRoutes {
  "/api/supervisor/prefs"?: { prefs: BlobPrefs & { reportStyle?: string } };
  "/api/supervisor/leads"?: { leads: LeadRosterEntry[] };
  "/api/supervisor/items"?: { items: { id: string }[] };
}

function stubFetch(routes: StubRoutes) {
  const seen: string[] = [];
  const impl: GetFetch = async (url) => {
    seen.push(url);
    const path = url.split("?")[0];
    const body =
      path === "/api/supervisor/prefs" ||
      path === "/api/supervisor/leads" ||
      path === "/api/supervisor/items"
        ? routes[path]
        : undefined;
    return body
      ? Response.json(body)
      : new Response("not found", { status: 404 });
  };
  return { impl, seen };
}

describe("loadBlobSummary", () => {
  test("reads prefs, leads and open needs-you items for the user", async () => {
    const { impl, seen } = stubFetch({
      "/api/supervisor/prefs": { prefs: { ...prefs, reportStyle: "short" } },
      "/api/supervisor/leads": {
        leads: [
          { project: "acme", label: "Acme", enabled: true, stage: "watch" },
        ],
      },
      "/api/supervisor/items": { items: [{ id: "a" }, { id: "b" }] },
    });
    const summary = await loadBlobSummary("Ada Lovelace", impl);
    expect(summary.prefs?.digestAt).toBe("09:00");
    expect(summary.leads).toEqual([
      { project: "acme", label: "Acme", enabled: true, stage: "watch" },
    ]);
    expect(summary.needsYou).toBe(2);
    expect(seen).toContain(
      `/api/supervisor/items?user=Ada%20Lovelace&state=open&kind=needs-you&limit=${NEEDS_YOU_LIMIT}&fields=id`,
    );
    expect(seen).toContain("/api/supervisor/prefs?user=Ada%20Lovelace");
  });

  test("an old server without the leads route leaves only the leads empty", async () => {
    const { impl } = stubFetch({
      "/api/supervisor/prefs": { prefs },
      "/api/supervisor/items": { items: [] },
    });
    const summary = await loadBlobSummary("Ada", impl);
    expect(summary.leads).toBeNull();
    expect(summary.prefs).not.toBeNull();
    expect(summary.needsYou).toBe(0);
  });

  test("a failing fetch reads as unknown, never throws", async () => {
    const summary = await loadBlobSummary("Ada", async () => {
      throw new Error("offline");
    });
    expect(summary).toEqual({ prefs: null, leads: null, needsYou: null });
  });
});

describe("copy", () => {
  test("facts read plainly", () => {
    expect(blobFacts(prefs, 0)).toEqual([
      { label: "Watch", value: "On, 08:00 to 22:00" },
      { label: "Quiet hours", value: "02:00 to 08:00" },
      { label: "Daily digest", value: "09:00" },
      { label: "Time zone", value: "Europe/Warsaw" },
      { label: "Needs you", value: "Nothing open" },
    ]);
    const off = blobFacts(
      {
        ...prefs,
        quietStart: "00:00",
        quietEnd: "00:00",
        effectiveTimezone: "",
        watch: { ...prefs.watch, enabled: false },
      },
      null,
    );
    expect(off.map((f) => f.value)).toEqual([
      "Off",
      "None",
      "09:00",
      "Not set",
    ]);
    expect(
      blobFacts(
        { ...prefs, watch: { ...prefs.watch, activeEnd: "08:00" } },
        1,
      )[0]!.value,
    ).toBe("On all day");
  });

  test("the count is honest at the list's cap", () => {
    expect(needsYouCopy(4)).toBe("4 open");
    expect(needsYouCopy(NEEDS_YOU_LIMIT)).toBe(
      `${NEEDS_YOU_LIMIT} or more open`,
    );
  });

  test("a lead reads as its stage, or Off", () => {
    expect(leadStateLabel({ enabled: true, stage: "coordinate" })).toBe(
      "Coordinate",
    );
    expect(leadStateLabel({ enabled: false, stage: "act" })).toBe("Off");
  });
});
