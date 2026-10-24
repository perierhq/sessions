import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workloadIdentityClientSource } from "./workload-identity-client-source";

const client = join(
  import.meta.dir,
  "../../../../../../../scripts/workload-identity-client.ts",
);
const out = mkdtempSync(join(tmpdir(), "identity-client-bundle-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("workload identity client source", () => {
  test("is the client script", async () => {
    expect(await workloadIdentityClientSource()).toBe(
      readFileSync(client, "utf8"),
    );
  });

  // A release runs from a bundle with no repository tree beside it, so the
  // source must travel inside the bundle rather than be read from disk.
  test("travels inside a bundle run away from the repository", async () => {
    const entry = join(out, "entry.ts");
    await Bun.write(
      entry,
      `import { workloadIdentityClientSource } from ${JSON.stringify(
        join(import.meta.dir, "workload-identity-client-source.ts"),
      )};\nprocess.stdout.write(await workloadIdentityClientSource());\n`,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: join(out, "dist"),
      target: "bun",
    });
    expect(built.success).toBe(true);
    const proc = Bun.spawn([process.execPath, built.outputs[0]!.path], {
      cwd: out,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr: stderr.slice(0, 300) }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(stdout).toBe(readFileSync(client, "utf8"));
  });
});
