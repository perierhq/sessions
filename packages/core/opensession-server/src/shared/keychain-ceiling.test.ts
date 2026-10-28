import { expect, test } from "bun:test";
import { ceilingWidening, pathWithinPrefix } from "./keychain-ceiling";

test("a prefix covers itself and the paths under it, on segment boundaries", () => {
  expect(pathWithinPrefix("/v1/items", "/v1/items")).toBe(true);
  expect(pathWithinPrefix("/v1/items/1", "/v1/items")).toBe(true);
  expect(pathWithinPrefix("/v1/items-admin", "/v1/items")).toBe(false);
  expect(pathWithinPrefix("/anything", "/")).toBe(true);
});

test("narrowing or keeping the limits widens nothing", () => {
  const before = {
    allowedMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/v1"],
    statusOnly: true,
  };
  expect(ceilingWidening(before, before)).toEqual([]);
  expect(
    ceilingWidening(before, {
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/v1/orders"],
      statusOnly: true,
    }),
  ).toEqual([]);
  // Unlimited stays unlimited.
  expect(ceilingWidening({}, {})).toEqual([]);
});

test("every way of widening is named", () => {
  expect(
    ceilingWidening(
      { allowedMethods: ["GET"] },
      { allowedMethods: ["GET", "DELETE"] },
    ),
  ).toEqual(["methods now include DELETE"]);
  expect(ceilingWidening({ allowedMethods: ["GET"] }, {})).toEqual([
    "any method is allowed",
  ]);
  expect(
    ceilingWidening(
      { allowedPathPrefixes: ["/v1/orders"] },
      { allowedPathPrefixes: ["/v1/orders/open", "/v2"] },
    ),
  ).toEqual(["paths now include /v2"]);
  expect(ceilingWidening({ allowedPathPrefixes: ["/v1"] }, {})).toEqual([
    "any path is allowed",
  ]);
  expect(ceilingWidening({ statusOnly: true }, { statusOnly: false })).toEqual([
    "responses are no longer status only",
  ]);
});
