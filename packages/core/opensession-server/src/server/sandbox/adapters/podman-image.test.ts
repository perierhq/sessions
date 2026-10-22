import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import type { ExecResult } from "../provider";
import {
  baseRuntimeSignature,
  REMOTE_GH_VERSION,
  REMOTE_JUST_VERSION,
  REMOTE_LINUX_PACKAGES,
  REMOTE_NODE_VERSION,
} from "./bootstrap";
import type { PodmanRunner, PodmanRunOpts } from "./podman-cli";
import {
  ensurePodmanImage,
  PODMAN_BASE_IMAGE,
  PODMAN_BUN_SHA256,
  PODMAN_BUN_VERSION,
  PODMAN_JUST_SHA256,
  podmanImageSignature,
  podmanContainerfile,
  podmanImageTag,
} from "./podman-image";

function fakeRunner(reply: (argv: string[], call: number) => ExecResult) {
  const calls: { argv: string[]; opts?: PodmanRunOpts }[] = [];
  const run: PodmanRunner = async (argv, opts) => {
    calls.push({ argv, opts });
    return reply(argv, calls.length);
  };
  return { run, calls };
}

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
const missing: ExecResult = { exitCode: 1, stdout: "", stderr: "" };

describe("podman image", () => {
  const file = podmanContainerfile();
  const lines = file.trim().split("\n");

  test("builds from the pinned multi-arch base", () => {
    expect(PODMAN_BASE_IMAGE).toMatch(
      /^docker\.io\/library\/ubuntu:24\.04@sha256:[0-9a-f]{64}$/,
    );
    expect(lines[0]).toBe(`FROM ${PODMAN_BASE_IMAGE}`);
  });

  test("bakes the base runtime's pins and packages", () => {
    for (const pin of [
      REMOTE_NODE_VERSION,
      REMOTE_JUST_VERSION,
      REMOTE_GH_VERSION,
    ])
      expect(file).toContain(pin);
    expect(REMOTE_LINUX_PACKAGES.length).toBeGreaterThan(5);
    for (const pkg of REMOTE_LINUX_PACKAGES)
      expect(file).toMatch(new RegExp(`\\b${pkg}\\b`));
  });

  test("verifies downloads and leaves no route to root", () => {
    expect(file).toContain("sha256sum -c");
    const gh = lines.find((l) => l.includes("cli/cli/releases"));
    expect(gh).toBeDefined();
    expect(file.slice(file.indexOf("gh_"))).toContain("sha256sum -c");
    expect(file).toContain("SHASUMS256.txt");
    expect(file).not.toMatch(/sudo/i);
    expect(file).not.toContain("NOPASSWD");
    expect(file).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(file).not.toMatch(/^SHELL /m);
  });

  test("installs pinned bun and just from release archives, checked by SHA-256", () => {
    expect(PODMAN_BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(file).not.toContain("bun.sh/install");
    expect(file).not.toContain("just.systems/install.sh");
    const bun = lines.find((l) => l.includes("oven-sh/bun/releases"));
    expect(bun).toContain(`bun-v${PODMAN_BUN_VERSION}/`);
    expect(file).toContain(
      `https://github.com/oven-sh/bun/releases/download/bun-v${PODMAN_BUN_VERSION}/SHASUMS256.txt`,
    );
    const just = lines.find((l) => l.includes("casey/just/releases"));
    expect(just).toContain(
      `/${REMOTE_JUST_VERSION}/just-${REMOTE_JUST_VERSION}-$target.tar.gz`,
    );
    for (const sum of [
      ...Object.values(PODMAN_BUN_SHA256),
      ...Object.values(PODMAN_JUST_SHA256),
    ]) {
      expect(sum).toMatch(/^[0-9a-f]{64}$/);
      expect(file).toContain(sum);
    }
    expect(Object.keys(PODMAN_BUN_SHA256).sort()).toEqual(["aarch64", "x64"]);
    expect(Object.keys(PODMAN_JUST_SHA256).sort()).toEqual([
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-musl",
    ]);
    expect(file.match(/sha256sum -c/g)?.length).toBeGreaterThanOrEqual(5);
  });

  test("the image signature carries the bun and just pins", () => {
    const signature = podmanImageSignature();
    expect(signature).toStartWith(baseRuntimeSignature());
    expect(signature).toContain(`bun@${PODMAN_BUN_VERSION}`);
    expect(signature).toContain(`just@${REMOTE_JUST_VERSION}`);
    expect(file).toContain(
      `LABEL opensession.sandbox-runtime=${JSON.stringify(signature)}`,
    );
  });

  test("ends as the unprivileged user in its home", () => {
    expect(lines.slice(-2)).toEqual(["USER 1000:1000", "WORKDIR /home/ubuntu"]);
    expect(lines.filter((l) => l.startsWith("USER "))).toEqual([
      "USER 1000:1000",
    ]);
  });

  test("the tag follows the runtime signature and is stable otherwise", () => {
    const tag = podmanImageTag();
    expect(tag).toMatch(/^localhost\/opensession-sandbox:[0-9a-f]{16}$/);
    expect(podmanImageTag()).toBe(tag);
    expect(podmanImageTag(baseRuntimeSignature())).toBe(tag);
    expect(podmanImageTag(`${baseRuntimeSignature()}+next`)).not.toBe(tag);
  });
});

describe("ensure podman image", () => {
  test("an existing image is not rebuilt", async () => {
    const { run, calls } = fakeRunner(() => ok);
    expect(await ensurePodmanImage(run)).toBe(podmanImageTag());
    expect(calls.map((c) => c.argv)).toEqual([
      ["image", "exists", podmanImageTag()],
    ]);
  });

  test("a missing image is built from stdin in an empty context", async () => {
    const { run, calls } = fakeRunner((argv, n) =>
      argv[0] === "image" ? (n === 1 ? missing : ok) : ok,
    );
    const logs: string[] = [];
    const tag = await ensurePodmanImage(run, (line) => logs.push(line));
    expect(tag).toBe(podmanImageTag());
    const build = calls[1]!;
    expect(build.argv.slice(0, 6)).toEqual([
      "build",
      "--pull=missing",
      "-t",
      tag,
      "-f",
      "-",
    ]);
    const context = build.argv[6]!;
    expect(build.argv).toHaveLength(7);
    expect(context.startsWith("/")).toBe(true);
    expect(context).not.toBe(process.cwd());
    expect(build.opts?.stdin).toBe(podmanContainerfile());
    expect(build.opts?.timeoutMs).toBeGreaterThanOrEqual(600_000);
    expect(calls[2]!.argv).toEqual(["image", "exists", tag]);
    expect(logs.length).toBeGreaterThan(0);
    await expect(access(context)).rejects.toThrow();
  });

  test("a failed build rejects with its output", async () => {
    const { run } = fakeRunner((argv) =>
      argv[0] === "image"
        ? missing
        : {
            exitCode: 125,
            stdout: "",
            stderr: "Error: no space left on device",
          },
    );
    await expect(ensurePodmanImage(run)).rejects.toThrow(
      "no space left on device",
    );
  });

  test("a build that leaves no image rejects", async () => {
    const { run } = fakeRunner((argv) => (argv[0] === "image" ? missing : ok));
    await expect(ensurePodmanImage(run)).rejects.toThrow(
      "not found after build",
    );
  });
});
