import { expect, test } from "bun:test";
import * as server from "../server/incidents/json-mapping";
import * as shared from "./incidents-json-mapping";

const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * Imports that tie a shared module to the server or to Node: any specifier
 * (static, side-effect, re-export, dynamic, require, and type-only ones)
 * that is not a sibling `./` file.
 */
function foreignImports(src: string): string[] {
  const runtime = transpiler.scanImports(src).map((i) => i.path);
  // Comments may say "from" too.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const written = [
    ...code.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...code.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
    ...code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
  ].map((m) => m[1]!);
  return [...new Set([...runtime, ...written])]
    .filter((path) => !path.startsWith("./"))
    .sort();
}

test("the import check catches every form", () => {
  expect(
    foreignImports(`import "node:fs";
import type { A } from "../server/a";
export { b } from "../server/b";
const c = await import("node:os");
const d = require("node:path");
import { e } from "./incidents";`),
  ).toEqual(["../server/a", "../server/b", "node:fs", "node:os", "node:path"]);
});

test("one implementation, importable without the server", async () => {
  expect(server.mapJson).toBe(shared.mapJson);
  expect(server.STATUS_PAGE_PRESET_MAPPINGS).toBe(
    shared.STATUS_PAGE_PRESET_MAPPINGS,
  );
  for (const file of [
    "./incidents-json-mapping.ts",
    "./incidents-jsonpath.ts",
    "./incidents.ts",
  ]) {
    const src = await Bun.file(new URL(file, import.meta.url)).text();
    expect([file, foreignImports(src)]).toEqual([file, []]);
  }
  // The wire types import nothing at run time (type-only imports vanish).
  const types = await Bun.file(
    new URL("./incidents.ts", import.meta.url),
  ).text();
  expect(transpiler.scanImports(types)).toEqual([]);
  expect(shared.mapJson({ status: "ok" }, { preset: "plain" }).result).toBe(
    "ok",
  );
});
