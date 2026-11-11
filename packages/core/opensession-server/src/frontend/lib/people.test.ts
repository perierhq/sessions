import { afterEach, describe, expect, test } from "bun:test";
import {
  ensurePeople,
  getBots,
  getPeople,
  peopleMentionMatches,
  type Person,
} from "./people";

const roster: Person[] = [
  { name: "Michiel", fullName: "Michiel Westerbeek" },
  { name: "Kent", fullName: "Kent de Bruin" },
  { name: "Jaap", fullName: "Jaap Frolich" },
];

const blob: Person = {
  kind: "bot",
  name: "Blob",
  fullName: "Blob",
  image: "/bot-icon/blob.png",
};

describe("peopleMentionMatches", () => {
  test("a bare trigger returns the complete roster with the current person first", () => {
    expect(
      peopleMentionMatches("", roster, "Kent", []).map((row) => row.insert),
    ).toEqual(["Kent", "Michiel", "Jaap"]);
  });

  test("offers Blob after the people, inserting @Blob without a subtitle", () => {
    const rows = peopleMentionMatches("", roster, "Kent", [blob]);
    expect(rows.map((row) => row.insert)).toEqual([
      "Kent",
      "Michiel",
      "Jaap",
      "Blob",
    ]);
    expect(rows.at(-1)).toEqual({
      display: "Blob",
      insert: "Blob",
      kind: "person",
    });
  });

  test("typing filters Blob like anyone else", () => {
    expect(
      peopleMentionMatches("bl", roster, "Kent", [blob]).map(
        (row) => row.insert,
      ),
    ).toEqual(["Blob"]);
    expect(
      peopleMentionMatches("kent", roster, "Kent", [blob]).map(
        (row) => row.insert,
      ),
    ).toEqual(["Kent"]);
  });

  test("a current user named like a bot does not lift the bot", () => {
    expect(
      peopleMentionMatches("", roster, "Blob", [blob]).map((row) => row.insert),
    ).toEqual(["Michiel", "Kent", "Jaap", "Blob"]);
  });

  test("filters by any part of a full name", () => {
    expect(peopleMentionMatches("bruin", roster, "Kent", [])).toEqual([
      {
        display: "Kent",
        insert: "Kent",
        kind: "person",
        sub: "Kent de Bruin",
      },
    ]);
  });

  test("an exact name outranks a longer name it prefixes", () => {
    const johns: Person[] = [
      { name: "Johnny", fullName: "Johnny Lin" },
      { name: "John", fullName: "John Soutar" },
    ];
    expect(
      peopleMentionMatches("john", johns, "Johnny", []).map(
        (row) => row.insert,
      ),
    ).toEqual(["John", "Johnny"]);
  });
});

describe("the directory fetch", () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  test("keeps bots out of the people pickers read", async () => {
    Object.defineProperty(globalThis, "window", {
      value: new EventTarget(),
      configurable: true,
    });
    const directory = async () =>
      Response.json({
        people: [{ kind: "person", name: "Ada", fullName: "Ada Lovelace" }],
        bots: [blob],
      });
    globalThis.fetch = Object.assign(directory, {
      preconnect: originalFetch.preconnect,
    });
    await ensurePeople();
    expect(getPeople().map((p) => p.name)).toEqual(["Ada"]);
    expect(getBots().map((p) => p.name)).toEqual(["Blob"]);
    expect(peopleMentionMatches("").map((row) => row.insert)).toEqual([
      "Ada",
      "Blob",
    ]);
  });
});
