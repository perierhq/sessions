import { afterEach, expect, test } from "bun:test";
import { __setOwnerRosterForTest, personOwner, signalOwner } from "./owner";

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
