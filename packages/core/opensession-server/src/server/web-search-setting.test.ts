import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWebSearchSetting,
  readWebSearchSetting,
  writeWebSearchSetting,
} from "./web-search-setting";

const dir = mkdtempSync(join(tmpdir(), "web-search-setting-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("parses only the known choices", () => {
  for (const value of ["auto", "anthropic", "openai", "off"])
    expect(parseWebSearchSetting(value)).toBe(value as never);
  expect(parseWebSearchSetting("xai")).toBeNull();
  expect(parseWebSearchSetting(undefined)).toBeNull();
});

test("Automatic when unset or unreadable", async () => {
  expect(await readWebSearchSetting(join(dir, "missing.json"))).toBe("auto");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{");
  expect(await readWebSearchSetting(bad)).toBe("auto");
  writeFileSync(bad, JSON.stringify({ provider: "acme" }));
  expect(await readWebSearchSetting(bad)).toBe("auto");
});

test("a stored choice round-trips", async () => {
  const path = join(dir, "web-search.json");
  expect(await writeWebSearchSetting("off", path)).toBe("off");
  expect(await readWebSearchSetting(path)).toBe("off");
  await writeWebSearchSetting("openai", path);
  expect(await readWebSearchSetting(path)).toBe("openai");
});
