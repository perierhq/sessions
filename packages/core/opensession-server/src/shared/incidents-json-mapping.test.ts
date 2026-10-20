import { expect, test } from "bun:test";
import * as server from "../server/incidents/json-mapping";
import * as shared from "./incidents-json-mapping";

test("one implementation, importable without the server", async () => {
  expect(server.mapJson).toBe(shared.mapJson);
  expect(server.STATUS_PAGE_PRESET_MAPPINGS).toBe(
    shared.STATUS_PAGE_PRESET_MAPPINGS,
  );
  for (const file of [
    "./incidents-json-mapping.ts",
    "./incidents-jsonpath.ts",
  ]) {
    const src = await Bun.file(new URL(file, import.meta.url)).text();
    expect(src).not.toMatch(/from "\.\.\/server|from "node:/);
  }
  expect(shared.mapJson({ status: "ok" }, { preset: "plain" }).result).toBe(
    "ok",
  );
});
