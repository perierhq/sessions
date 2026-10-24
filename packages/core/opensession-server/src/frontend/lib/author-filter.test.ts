import { beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">,
});

const {
  ANYONE,
  OUTSIDE_TEAM,
  authorFilterLabel,
  authorMarker,
  isPersonFilter,
  matchesAuthorFilter,
  readAuthorFilter,
  resolveAuthorFilter,
  writeAuthorFilter,
} = await import("./author-filter");

beforeEach(() => store.clear());

const team = { person: "alex", authorKind: "team" as const };
const outsider = { person: null, authorKind: "outside" as const };
const bot = { person: null, authorKind: "bot" as const };
const assignedOutsider = { person: "alex", authorKind: "outside" as const };
// A row known only from a session: there is no GitHub author to classify.
const sessionOnly = { person: "sam" };

describe("matchesAuthorFilter", () => {
  test("anyone shows every row", () => {
    for (const row of [team, outsider, bot, sessionOnly])
      expect(matchesAuthorFilter(row, ANYONE)).toBe(true);
  });

  test("outside the team shows outsiders and bots, never the team", () => {
    expect(matchesAuthorFilter(outsider, OUTSIDE_TEAM)).toBe(true);
    expect(matchesAuthorFilter(bot, OUTSIDE_TEAM)).toBe(true);
    expect(matchesAuthorFilter(assignedOutsider, OUTSIDE_TEAM)).toBe(true);
    expect(matchesAuthorFilter(team, OUTSIDE_TEAM)).toBe(false);
    expect(matchesAuthorFilter(sessionOnly, OUTSIDE_TEAM)).toBe(false);
  });

  test("a person shows the rows attributed to them", () => {
    expect(matchesAuthorFilter(team, "alex")).toBe(true);
    expect(matchesAuthorFilter(assignedOutsider, "alex")).toBe(true);
    expect(matchesAuthorFilter(outsider, "alex")).toBe(false);
    expect(matchesAuthorFilter(sessionOnly, "alex")).toBe(false);
  });
});

describe("authorMarker", () => {
  test("marks outsiders and bots, leaves the team unmarked", () => {
    expect(authorMarker("outside")).toBe("Outside");
    expect(authorMarker("bot")).toBe("Bot");
    expect(authorMarker("team")).toBeNull();
    expect(authorMarker(undefined)).toBeNull();
  });
});

describe("labels", () => {
  test("names the scope on the trigger", () => {
    expect(authorFilterLabel(ANYONE)).toBe("Anyone");
    expect(authorFilterLabel(OUTSIDE_TEAM)).toBe("Outside the team");
    expect(authorFilterLabel("alex")).toBe("Alex");
    expect(isPersonFilter("alex")).toBe(true);
    expect(isPersonFilter(ANYONE)).toBe(false);
    expect(isPersonFilter(OUTSIDE_TEAM)).toBe(false);
  });
});

describe("remembering the choice", () => {
  test("each page keeps its own, defaulting to anyone", () => {
    expect(readAuthorFilter("prs")).toBe(ANYONE);
    writeAuthorFilter("prs", OUTSIDE_TEAM);
    writeAuthorFilter("issues", "alex");
    expect(readAuthorFilter("prs")).toBe(OUTSIDE_TEAM);
    expect(readAuthorFilter("issues")).toBe("alex");
  });

  test("anyone is stored as its absence", () => {
    writeAuthorFilter("prs", OUTSIDE_TEAM);
    writeAuthorFilter("prs", ANYONE);
    expect(store.size).toBe(0);
  });

  test("a damaged value reads as anyone", () => {
    store.set("opensession-prs-author-filter", "x".repeat(200));
    expect(readAuthorFilter("prs")).toBe(ANYONE);
  });

  test("a remembered person who left the roster falls back to anyone", () => {
    expect(resolveAuthorFilter("alex", ["alex", "sam"])).toBe("alex");
    expect(resolveAuthorFilter("kim", ["alex", "sam"])).toBe(ANYONE);
    // The roster has not loaded yet: keep the choice.
    expect(resolveAuthorFilter("kim", [])).toBe("kim");
    expect(resolveAuthorFilter(OUTSIDE_TEAM, ["alex"])).toBe(OUTSIDE_TEAM);
  });
});
