import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { $ } from "bun";
import { hostWorkspaceExec } from "./workspace-exec";

// Bun's `$.env()` sets the environment of every later `$` command in the
// process. A credential handed to one workspace command (a person's
// GH_TOKEN for "update from base") must not ride along with the next one.
test("a host workspace command's env stays with that command", async () => {
  const exec = hostWorkspaceExec(tmpdir());
  const seen = await exec(["sh", "-c", 'echo "[$GH_TOKEN]"'], {
    env: { GH_TOKEN: "ghu_person" },
  });
  expect(seen.stdout.trim()).toBe("[ghu_person]");
  const after = await $`sh -c ${'echo "[$GH_TOKEN]"'}`.text();
  expect(after.trim()).toBe(`[${process.env.GH_TOKEN ?? ""}]`);
});
