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
test("at most 32 segments", () => {
  expect(Array.isArray(parseJsonPath("$" + ".a".repeat(32)))).toBe(true);
  expect(parseJsonPath("$" + ".a".repeat(33))).toEqual({
    error: expect.stringContaining("32 segments"),
  });
});
test("number, boolean and null filter literals", () => {
  const items = {
    list: [
      { id: "a", code: 2, live: true, owner: null },
      { id: "b", code: 2.5, live: false, owner: "ops" },
      { id: "c", code: -1e2, live: true },
    ],
  };
  expect(queryJsonPath(items, "$.list[?(@.code==2)].id")).toEqual(["a"]);
  expect(queryJsonPath(items, "$.list[?(@.code==2.5)].id")).toEqual(["b"]);
  expect(queryJsonPath(items, "$.list[?(@.code==-1e2)].id")).toEqual(["c"]);
  expect(queryJsonPath(items, "$.list[?(@.live==false)].id")).toEqual(["b"]);
  expect(queryJsonPath(items, "$.list[?(@.owner==null)].id")).toEqual(["a"]);
  expect(queryJsonPath(items, "$.list[?(@.code=='2')].id")).toEqual([]);
  expect(parseJsonPath("$.list[?(@.code==two)]")).toEqual({
    error: expect.stringContaining("literal"),
  });
});
test("slices are refused", () => {
  for (const path of ["$.a[0:2]", "$.a[:2]", "$.a[1:]"])
    expect(parseJsonPath(path)).toEqual({
      error: "Slices are not supported",
    });
});
test("escaped quotes in keys and literals", () => {
  const quoted = { "it's": { 'say "hi"': 1 }, list: [{ n: "it's" }] };
  expect(queryJsonPath(quoted, String.raw`$['it\'s']['say \"hi\"']`)).toEqual([
    1,
  ]);
  expect(queryJsonPath(quoted, `$["it's"]`)).toEqual([{ 'say "hi"': 1 }]);
  expect(queryJsonPath(quoted, String.raw`$.list[?(@.n=='it\'s')].n`)).toEqual([
    "it's",
  ]);
  expect(parseJsonPath("$['open")).toEqual({ error: "Unterminated string" });
});
