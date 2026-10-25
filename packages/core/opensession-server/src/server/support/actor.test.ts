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
    expect(actorFor("Ada", true)).toEqual({
      name: "Ada",
      verified: true,
      isInstanceOwner: true,
    });
    expect(actorFor("Bea", true).isInstanceOwner).toBe(false);
  });

  test("without a notify user, the first directory member is", () => {
    __setOwnerRosterForTest(team);
    expect(actorFor("Ada", true).isInstanceOwner).toBe(true);
    expect(actorFor("ada-l", true).isInstanceOwner).toBe(true);
  });

  test("a claimed name is never the instance owner", () => {
    __setOwnerRosterForTest(team, "Ada");
    expect(actorFor("Ada", false)).toEqual({
      name: "Ada",
      verified: false,
      isInstanceOwner: false,
    });
  });

  test("nobody is the instance owner when there is none", () => {
    __setOwnerRosterForTest([], "");
    expect(actorFor("Ada", true).isInstanceOwner).toBe(false);
    expect(actorFor("", true)).toMatchObject({
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
