import { expect, test } from "bun:test";
import { parseJsonPath, queryJsonPath } from "./jsonpath";

const doc = {
  status: { indicator: "minor" },
  components: [
    { name: "API", status: "operational", group: false },
    { name: "Search", status: "partial_outage" },
    { name: "Group", status: "operational", group: true },
  ],
};

test("keys, brackets, indexes", () => {
  expect(queryJsonPath(doc, "$.status.indicator")).toEqual(["minor"]);
  expect(queryJsonPath(doc, "$['status'][\"indicator\"]")).toEqual(["minor"]);
  expect(queryJsonPath(doc, "$.components[-1].name")).toEqual(["Group"]);
  expect(queryJsonPath(doc, "status.indicator")).toEqual(["minor"]);
});
test("wildcards", () => {
  expect(queryJsonPath(doc, "$.components[*].name")).toEqual([
    "API",
    "Search",
    "Group",
  ]);
  expect(queryJsonPath({ a: { x: 1, y: 2 } }, "$.a.*")).toEqual([1, 2]);
});
test("filters, including a missing key against !=", () => {
  expect(queryJsonPath(doc, "$.components[?(@.group!=true)].name")).toEqual([
    "API",
    "Search",
  ]);
  expect(
    queryJsonPath(doc, "$.components[?(@.name=='Search')].status"),
  ).toEqual(["partial_outage"]);
});
test("missing paths and bad input", () => {
  expect(queryJsonPath(doc, "$.nope.deeper")).toEqual([]);
  expect(queryJsonPath("not an object", "$.a")).toEqual([]);
  expect(parseJsonPath("$..status")).toEqual({
    error: expect.stringContaining("not supported"),
  });
  expect(parseJsonPath("$." + "a".repeat(300))).toEqual({
    error: expect.any(String),
  });
  expect(queryJsonPath(doc, "$[")).toEqual([]);
});
test("caps results", () => {
  const big = { items: Array.from({ length: 5000 }, (_, i) => i) };
  expect(queryJsonPath(big, "$.items[*]")).toHaveLength(1000);
});
