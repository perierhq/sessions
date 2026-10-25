import { afterEach, describe, expect, test } from "bun:test";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { ForbiddenError, actorFor, requireInstanceOwner } from "./actor";

afterEach(() => __setOwnerRosterForTest(undefined));

const team = [
  { name: "Ada Lovelace", github: "ada-l" },
  { name: "Bea Smith", github: "bea-s" },
];

describe("actorFor", () => {
  test("the configured notify user is the instance owner", () => {
    __setOwnerRosterForTest(team, "Ada");
    expect(actorFor("Ada", true, "ada-l")).toEqual({
      name: "Ada",
      verified: true,
      isInstanceOwner: true,
    });
    expect(actorFor("Bea", true, "bea-s").isInstanceOwner).toBe(false);
  });

  test("without a notify user, the first directory member is", () => {
    __setOwnerRosterForTest(team);
    expect(actorFor("Ada", true, "ada-l").isInstanceOwner).toBe(true);
    expect(actorFor("Ada", true, "ADA-L").isInstanceOwner).toBe(true);
  });

  test("the owner is matched by GitHub login, never by first name", () => {
    __setOwnerRosterForTest(
      [...team, { name: "Ada Byron", github: "ada-b" }],
      "Ada",
    );
    expect(actorFor("Ada", true, "ada-b").isInstanceOwner).toBe(false);
    expect(actorFor("Ada", true).isInstanceOwner).toBe(false);
    expect(actorFor("Ada", true, "ada-l").isInstanceOwner).toBe(true);
  });

  test("an owner without a GitHub login on the roster is nobody's", () => {
    __setOwnerRosterForTest([{ name: "Ada Lovelace" }], "Ada");
    expect(actorFor("Ada", true, "ada").isInstanceOwner).toBe(false);
  });

  test("a claimed name is never the instance owner", () => {
    __setOwnerRosterForTest(team, "Ada");
    expect(actorFor("Ada", false, "ada-l")).toEqual({
      name: "Ada",
      verified: false,
      isInstanceOwner: false,
    });
  });

  test("nobody is the instance owner when there is none", () => {
    __setOwnerRosterForTest([], "");
    expect(actorFor("Ada", true, "ada-l").isInstanceOwner).toBe(false);
    expect(actorFor("", true, "ada-l")).toMatchObject({
      verified: false,
      isInstanceOwner: false,
    });
  });
});

describe("requireInstanceOwner", () => {
  test("throws a 403 for anyone else", () => {
    const actor = { name: "Bea", verified: true, isInstanceOwner: false };
    let error: unknown;
    try {
      requireInstanceOwner(actor, "Only the instance owner can do that");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).status).toBe(403);
    expect((error as Error).message).toBe(
      "Only the instance owner can do that",
    );
    expect(() =>
      requireInstanceOwner(
        { name: "Ada", verified: true, isInstanceOwner: true },
        "x",
      ),
    ).not.toThrow();
  });

  test("an unverified actor never passes, whatever it claims", () => {
    expect(() =>
      requireInstanceOwner(
        { name: "Ada", verified: false, isInstanceOwner: true },
        "x",
      ),
    ).toThrow(ForbiddenError);
  });
});
