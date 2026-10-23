import { afterEach, expect, test } from "bun:test";
import {
  __setOwnerRosterForTest,
  instanceOwner,
  isPersonName,
  personOwner,
  signalOwner,
} from "./owner";

afterEach(() => __setOwnerRosterForTest(undefined));

test("with a roster, a name not on it is no owner", () => {
  __setOwnerRosterForTest([{ name: "Ada Lovelace" }, { name: "Bo Diddley" }]);
  expect(personOwner("ada lovelace")).toBe("Ada");
  expect(personOwner("Adaa")).toBeNull();
  // A creator off the roster falls back to the instance owner.
  expect(signalOwner({ createdBy: "Adaa" })).toBe("Ada");
});

test("without a roster, a person's name stays as given", () => {
  __setOwnerRosterForTest([]);
  expect(personOwner(" Adaa ")).toBe("Adaa");
});

test("an attribution-only identity is no owner", () => {
  __setOwnerRosterForTest([
    { name: "Acme Bot", aliases: ["acmebot"], directory: false },
    { name: "Ada Lovelace" },
  ]);
  expect(personOwner("Acme Bot")).toBeNull();
  expect(personOwner("acmebot")).toBeNull();
  expect(signalOwner({ owner: "Acme Bot" })).toBe("Ada");
});

test("the anonymous placeholder is no person", () => {
  __setOwnerRosterForTest([]);
  expect(isPersonName("Anonymous")).toBe(false);
  expect(isPersonName(" anonymous ")).toBe(false);
  expect(personOwner("ANONYMOUS")).toBeNull();
  __setOwnerRosterForTest([{ name: "Ada Lovelace" }]);
  // A signal created without sign-in falls back to the instance owner.
  expect(signalOwner({ createdBy: "Anonymous" })).toBe("Ada");
});

test("the instance owner is the configured notify user, else the first directory member", () => {
  const team = [
    { name: "Acme Bot", directory: false },
    { name: "Ada Lovelace" },
    { name: "Bo Diddley", aliases: ["bo"] },
  ];
  __setOwnerRosterForTest(team);
  expect(instanceOwner()).toBe("Ada");
  __setOwnerRosterForTest(team, "bo");
  expect(instanceOwner()).toBe("Bo");
  expect(signalOwner({ createdBy: "Automation" })).toBe("Bo");
  // A notify user who is no directory member is passed over.
  __setOwnerRosterForTest(team, "U0ACME");
  expect(instanceOwner()).toBe("Ada");
  __setOwnerRosterForTest(team, "Acme Bot");
  expect(instanceOwner()).toBe("Ada");
  // Without a roster, the notify user is taken as given.
  __setOwnerRosterForTest([], "Ada");
  expect(instanceOwner()).toBe("Ada");
});
