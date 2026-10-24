import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setAutomationEgressAllowlist,
  setPortalSandboxDefault,
} from "./config";

let dir = "";
let path = "";
const previous = process.env.OPENSESSION_SANDBOX_CONFIG;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbox-defaults-"));
  path = join(dir, "sandbox.json");
  process.env.OPENSESSION_SANDBOX_CONFIG = path;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("global defaults in sandbox config", () => {
  test("clearing the websites drops an empty automation key", async () => {
    await writeFile(path, JSON.stringify({ sessionDefault: "none" }));
    expect(setAutomationEgressAllowlist(["status.example.test"])).toEqual([
      "status.example.test",
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      sessionDefault: "none",
      automation: { egressAllowlist: ["status.example.test"] },
    });
    setAutomationEgressAllowlist([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      sessionDefault: "none",
    });
  });

  test("clearing the websites keeps other automation keys", async () => {
    await writeFile(
      path,
      JSON.stringify({ automation: { provider: "daytona" } }),
    );
    setAutomationEgressAllowlist(["a.example.test"]);
    setAutomationEgressAllowlist([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      automation: { provider: "daytona" },
    });
  });

  test("previews beside the session are stored as no key", async () => {
    await writeFile(path, JSON.stringify({ portalDefault: "daytona" }));
    expect(setPortalSandboxDefault("same")).toBeNull();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({});
  });
});
