import { expect, test } from "bun:test";
import {
  editMapping,
  listToValues,
  mappingErrorField,
  mappingErrorText,
  previewRows,
  PRESET_LABELS,
  valuesToList,
} from "./mapping-preview";

const doc = {
  status: { indicator: "minor", description: "Partly degraded" },
  components: [
    { name: "API", status: "operational" },
    { name: "Search", status: "major_outage" },
  ],
};

test("statuspage preview: result, lanes, what each path found", () => {
  const { outcome, found } = previewRows(doc, { preset: "statuspage" });
  expect(outcome.result).toBe("fail");
  expect(outcome.lanes.map((l) => [l.lane, l.result])).toEqual([
    ["API", "ok"],
    ["Search", "fail"],
  ]);
  expect(found.find((f) => f.path === "$.status.indicator")?.values).toBe(
    '"minor"',
  );
  expect(found.find((f) => f.path === "$.status.description")?.values).toBe(
    '"Partly degraded"',
  );
});

test("an explicit path overrides the preset; missing paths say so", () => {
  const { found } = previewRows(doc, {
    preset: "plain",
    result: { path: "$.state", ok: ["green"] },
  });
  expect(found.find((f) => f.path === "$.state")?.values).toBe("Nothing here");
});

test("found values: the first three, compact", () => {
  const { found } = previewRows(
    { xs: [1, 2, 3, 4] },
    { result: { path: "$.xs[*]", ok: [1] } },
  );
  expect(found[0]).toEqual({ path: "$.xs[*]", values: "1, 2, 3" });
});

test("value lists", () => {
  expect(listToValues("ok, 1, true, null, Up ")).toEqual([
    "ok",
    1,
    true,
    null,
    "Up",
  ]);
  expect(listToValues(" , ")).toEqual([]);
  expect(valuesToList(["ok", 1, true])).toBe("ok, 1, true");
});

test("preset labels", () => {
  expect(PRESET_LABELS.statuspage).toBe("Atlassian Statuspage (summary.json)");
  expect(PRESET_LABELS.plain).toBe("A plain status field");
});

test("editing one part of a preset rule keeps the rest of it", () => {
  const next = editMapping({ preset: "statuspage" }, "resultPath", "$.x");
  expect(next.result).toEqual({
    path: "$.x",
    ok: ["none"],
    fail: ["minor", "major", "critical"],
  });
  const lanes = editMapping({ preset: "statuspage" }, "laneName", "title");
  expect(lanes.lanes?.name).toBe("title");
  expect(lanes.lanes?.items).toBe("$.components[?(@.group!=true)]");
  expect(editMapping({}, "value", "$.ms")).toEqual({ value: "$.ms" });
  expect(editMapping({ value: "$.ms" }, "value", "")).toEqual({});
  expect(editMapping({}, "resultOk", "up, 1")).toEqual({
    result: { path: "", ok: ["up", 1] },
  });
});

test("validation errors point at their field", () => {
  expect(mappingErrorField("result.path: Invalid JSONPath")).toBe("resultPath");
  expect(mappingErrorField("lanes.result.ok is required")).toBe("laneOk");
  expect(mappingErrorField("lanes.items: bad")).toBe("laneItems");
  expect(mappingErrorField("value: bad")).toBe("value");
  expect(mappingErrorField("Mapping needs a preset or at least one path")).toBe(
    "format",
  );
});

test("validation errors read as field messages", () => {
  expect(mappingErrorText("result.path must be a JSON path")).toBe(
    "Enter a JSON path like $.status",
  );
  expect(mappingErrorText("lanes.result.ok needs at least one value")).toBe(
    "Enter at least one value",
  );
  expect(mappingErrorText("result.path: unexpected end at 2")).toBe(
    "Unexpected end at 2",
  );
  expect(mappingErrorText("Mapping needs a preset or at least one path")).toBe(
    "Mapping needs a preset or at least one path",
  );
});
