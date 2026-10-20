import { expect, test } from "bun:test";
import { STATUS_PAGE_PRESET_HINTS } from "../../shared/incidents";
import {
  STATUS_PAGE_PRESET_MAPPINGS,
  mapJson,
  resolveMapping,
  validateJsonMapping,
} from "./json-mapping";

test("statuspage summary.json: overall, detail, component lanes without groups", () => {
  const out = mapJson(
    {
      status: { indicator: "minor", description: "Partially degraded service" },
      components: [
        { name: "API", status: "operational", group: false },
        { name: "Search", status: "partial_outage" },
        { name: "Group", status: "operational", group: true },
        { name: "Docs", status: "under_maintenance" },
      ],
    },
    { preset: "statuspage" },
  );
  expect(out.result).toBe("fail");
  expect(out.detail).toBe("Partially degraded service");
  expect(out.lanes.map((l) => [l.lane, l.result])).toEqual([
    ["API", "ok"],
    ["Search", "fail"],
    ["Docs", "unknown"],
  ]);
});
test("instatus", () => {
  expect(
    mapJson(
      {
        page: { status: "UP" },
        components: [{ name: "Web", status: "MAJOROUTAGE" }],
      },
      { preset: "instatus" },
    ),
  ).toMatchObject({ result: "ok", lanes: [{ lane: "Web", result: "fail" }] });
});
test("betterstack index.json", () => {
  expect(
    mapJson(
      {
        data: { attributes: { aggregate_state: "downtime" } },
        included: [
          {
            type: "status_page_resource",
            attributes: { public_name: "Checkout", status: "downtime" },
          },
          { type: "status_page_section", attributes: { name: "ignored" } },
        ],
      },
      { preset: "betterstack" },
    ),
  ).toMatchObject({
    result: "fail",
    lanes: [{ lane: "Checkout", result: "fail" }],
  });
});
test("kener and plain", () => {
  expect(mapJson({ status: "DEGRADED" }, { preset: "kener" }).result).toBe(
    "fail",
  );
  expect(mapJson({ status: "Healthy" }, { preset: "plain" }).result).toBe("ok");
  expect(mapJson({ status: true }, { preset: "plain" }).result).toBe("ok");
  expect(mapJson({ status: "starting" }, { preset: "plain" }).result).toBe(
    "unknown",
  );
});
test("cachet: worst lane, numeric strings, lanesInclude", () => {
  const doc = {
    data: [
      { name: "API", status: 1 },
      { name: "Mail", status: "3" },
    ],
  };
  expect(mapJson(doc, { preset: "cachet" }).result).toBe("fail");
  expect(mapJson(doc, { preset: "cachet", lanesInclude: ["API"] }).result).toBe(
    "ok",
  );
});
test("custom result without fail list; value; missing path", () => {
  expect(
    mapJson(
      { s: "nope", depth: "42" },
      { result: { path: "$.s", ok: ["yes"] }, value: "$.depth" },
    ),
  ).toMatchObject({ result: "fail", value: 42 });
  expect(mapJson({}, { result: { path: "$.s", ok: ["yes"] } })).toMatchObject({
    result: "unknown",
    detail: "Nothing at $.s",
  });
  expect(mapJson({}, { value: "$.x" }).result).toBeNull();
});
test("explicit fields override the preset", () => {
  expect(
    resolveMapping({
      preset: "plain",
      result: { path: "$.state", ok: ["green"] },
    }).result?.path,
  ).toBe("$.state");
});
test("unnamed lanes, lane cap and preview matches", () => {
  const doc = {
    data: Array.from({ length: 30 }, (_, i) => ({
      name: i === 0 ? "" : `C${i}`,
      status: 1,
    })),
  };
  const out = mapJson(doc, { preset: "cachet" });
  expect(out.lanes).toHaveLength(24);
  expect(out.lanes[0].lane).toBe("#1");
  expect(out.matches["$.data[*]"]).toHaveLength(20);
});
test("validation", () => {
  expect(validateJsonMapping({ preset: "nope" })).toEqual({
    error: expect.any(String),
  });
  expect(validateJsonMapping({ result: { path: "$..x", ok: ["a"] } })).toEqual({
    error: expect.any(String),
  });
  expect(validateJsonMapping({ result: { path: "$.x", ok: [] } })).toEqual({
    error: expect.any(String),
  });
  expect(
    validateJsonMapping({ preset: "statuspage", lanesInclude: ["API"] }),
  ).toEqual({ preset: "statuspage", lanesInclude: ["API"] });
  expect(validateJsonMapping({ preset: "plain", extra: 1 })).toEqual({
    preset: "plain",
  });
});
test("worst lane counts every item, not only the 24 returned", () => {
  const doc = {
    data: Array.from({ length: 30 }, (_, i) => ({
      name: `C${i + 1}`,
      status: i === 29 ? 4 : 1,
    })),
  };
  const out = mapJson(doc, { preset: "cachet" });
  expect(out.lanes).toHaveLength(24);
  expect(out).toMatchObject({ result: "fail", detail: "C30: 4" });
});
test("included lanes come first and are counted past the cap", () => {
  const doc = {
    data: Array.from({ length: 30 }, (_, i) => ({
      name: `C${i + 1}`,
      status: i === 27 ? 2 : 1,
    })),
  };
  const out = mapJson(doc, { preset: "cachet", lanesInclude: ["c28", "C2"] });
  expect(out.result).toBe("fail");
  expect(out.lanes).toHaveLength(24);
  expect(out.lanes.slice(0, 3).map((l) => l.lane)).toEqual(["C2", "C28", "C1"]);
});
test("lanesInclude implies worst-lane", () => {
  const doc = {
    status: { indicator: "none", description: "All good" },
    components: [
      { name: "API", status: "operational" },
      { name: "Search", status: "major_outage" },
    ],
  };
  expect(
    mapJson(doc, { preset: "statuspage", lanesInclude: ["Search"] }).result,
  ).toBe("fail");
  expect(
    mapJson(doc, { preset: "statuspage", lanesInclude: ["API"] }).result,
  ).toBe("ok");
  expect(
    validateJsonMapping({
      result: { path: "$.s", ok: ["up"] },
      lanesInclude: ["API"],
    }),
  ).toEqual({ error: expect.any(String) });
});
test("an explicit result turns off a preset's aggregate", () => {
  const doc = { overall: "up", data: [{ name: "Mail", status: 4 }] };
  const out = mapJson(doc, {
    preset: "cachet",
    result: { path: "$.overall", ok: ["up"] },
  });
  expect(out.result).toBe("ok");
  expect(out.lanes).toMatchObject([{ lane: "Mail", result: "fail" }]);
});
test("instatus without a page status falls back to the worst lane", () => {
  expect(
    mapJson(
      {
        components: [
          { name: "Web", status: "OPERATIONAL" },
          { name: "API", status: "MAJOROUTAGE" },
        ],
      },
      { preset: "instatus" },
    ),
  ).toMatchObject({ result: "fail", detail: "API: MAJOROUTAGE" });
  expect(mapJson({}, { preset: "instatus" })).toMatchObject({
    result: "unknown",
    detail: "Nothing at $.page.status",
  });
});
test("the cachet hint documents pagination", () => {
  expect(STATUS_PAGE_PRESET_HINTS.cachet).toContain("?per_page=");
});
test("the preset table cannot be changed through a resolved mapping", () => {
  const resolved = resolveMapping({ preset: "cachet" });
  resolved.lanes!.result.ok.push(9);
  expect(STATUS_PAGE_PRESET_MAPPINGS.cachet.lanes!.result.ok).toEqual([1]);
  expect(
    Object.isFrozen(STATUS_PAGE_PRESET_MAPPINGS.cachet.lanes!.result.ok),
  ).toBe(true);
});
