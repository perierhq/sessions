import { describe, expect, test } from "bun:test";
import { recordOwnerSpoke, supervisorClockLine } from "./supervisor-clock";
import type { UnifiedSession } from "./types";

describe("supervisorClockLine", () => {
  // Tuesday 2026-11-10 13:05 UTC, 14:05 in Warsaw.
  const now = new Date("2026-11-10T13:05:00Z");

  test("names the owner's weekday, date and time in their zone", () => {
    expect(supervisorClockLine({ now, timeZone: "Europe/Warsaw" })).toStartWith(
      "The owner's local time is Tuesday 2026-11-10 14:05 (Europe/Warsaw).",
    );
  });

  test("a zone that does not resolve reads as UTC", () => {
    expect(supervisorClockLine({ now, timeZone: "Mars/Olympus" })).toContain(
      "Tuesday 2026-11-10 13:05 (UTC)",
    );
  });

  test("the first message of a conversation is the first today", () => {
    const line = supervisorClockLine({ now, timeZone: "Europe/Warsaw" });
    expect(line).toContain("This is their first message in this conversation.");
    expect(line).toContain("First conversation today: yes.");
  });

  test("counts the minutes since the previous message", () => {
    const line = supervisorClockLine({
      now,
      timeZone: "Europe/Warsaw",
      previousAt: "2026-11-10T12:53:30Z",
    });
    expect(line).toContain(
      "Their previous message in this conversation was 11 minutes ago.",
    );
    expect(line).toContain("First conversation today: no.");
    expect(
      supervisorClockLine({
        now,
        timeZone: "UTC",
        previousAt: "2026-11-10T13:04:00Z",
      }),
    ).toContain("was 1 minute ago.");
  });

  test("the day is the owner's local day, not UTC's", () => {
    // 23:30 UTC on the 9th is 00:30 on the 10th in Warsaw: the same day.
    const sameDay = supervisorClockLine({
      now,
      timeZone: "Europe/Warsaw",
      previousAt: "2026-11-09T23:30:00Z",
    });
    expect(sameDay).toContain("First conversation today: no.");
    // In UTC it was yesterday.
    const utc = supervisorClockLine({
      now,
      timeZone: "UTC",
      previousAt: "2026-11-09T23:30:00Z",
    });
    expect(utc).toContain("was 815 minutes ago.");
    expect(utc).toContain("First conversation today: yes.");
  });

  test("a previous time in the future or unreadable is ignored", () => {
    for (const previousAt of ["2026-11-10T14:00:00Z", "not a date"]) {
      expect(
        supervisorClockLine({ now, timeZone: "UTC", previousAt }),
      ).toContain("This is their first message in this conversation.");
    }
  });
});

describe("recordOwnerSpoke", () => {
  test("two owner turns: the second sees the first, and each is written", async () => {
    const session = { id: "sup-1" } as UnifiedSession;
    const writes: Array<{ id: string; at: string }> = [];
    const write = async (
      id: string,
      patch: { supervisorOwnerSpoke: { at: string } },
    ) => {
      writes.push({ id, at: patch.supervisorOwnerSpoke.at });
    };
    const turn = async (at: string) => {
      const now = new Date(at);
      const previousAt = await recordOwnerSpoke(session, now, write);
      return supervisorClockLine({ now, timeZone: "UTC", previousAt });
    };

    const first = await turn("2026-11-10T08:00:00Z");
    expect(first).toContain(
      "This is their first message in this conversation.",
    );
    expect(first).toContain("First conversation today: yes.");

    const second = await turn("2026-11-10T08:25:00Z");
    expect(second).toContain(
      "Their previous message in this conversation was 25 minutes ago.",
    );
    expect(second).toContain("First conversation today: no.");

    expect(writes).toEqual([
      { id: "sup-1", at: "2026-11-10T08:00:00.000Z" },
      { id: "sup-1", at: "2026-11-10T08:25:00.000Z" },
    ]);
    expect(session.supervisorOwnerSpoke).toEqual({
      at: "2026-11-10T08:25:00.000Z",
    });
  });
});
