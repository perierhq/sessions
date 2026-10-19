import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptEnv } from "./script-workspace";

const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const state = mkdtempSync(join(tmpdir(), "os-script-env-"));
process.env.OPENSESSION_STATE_DIR = state;

afterAll(() => {
  rmSync(state, { recursive: true, force: true });
  if (previousStateDir == null) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
});

test("a script run names the session that owns what it starts", () => {
  const env = scriptEnv("os-script-1");
  expect(env.OPENSESSION_SESSION_ID).toBe("os-script-1");
  expect(env.OPENSESSION_UNIT_LABEL).toStartWith(
    "opensession.session=os-script-1 opensession.instance=",
  );
  expect(env.OPENSESSION_SCRATCH).toBe(env.TMPDIR);
  // Still the minimal environment: no server tokens.
  expect(Object.keys(env).some((key) => key.includes("TOKEN"))).toBe(false);
});
