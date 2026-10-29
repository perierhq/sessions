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
import {
  PODMAN_PASTA_NETWORK,
  type PodmanRunner,
  type PodmanRunOpts,
} from "./podman-cli";
import {
  ensurePodmanImage,
  PODMAN_BASE_IMAGE,
  PODMAN_BUN_SHA256,
  PODMAN_BUN_VERSION,
  PODMAN_MEDIA_PACKAGES,
  PODMAN_JUST_SHA256,
  podmanImageSignature,
  podmanContainerfile,
  podmanImageTag,
  prunePodmanImages,
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

  test("bakes ffmpeg and ImageMagick for recordings and image work", () => {
    expect(PODMAN_MEDIA_PACKAGES).toEqual(["ffmpeg", "imagemagick"]);
    const install = lines.find((line) => line.includes("apt-get install"));
    for (const pkg of PODMAN_MEDIA_PACKAGES)
      expect(install).toMatch(new RegExp(`\\b${pkg}\\b`));
    expect(file).toContain("command -v ffmpeg");
    expect(file).toContain("command -v convert");
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

  test("provides pnpm through Node's corepack, ready on a read-only root", () => {
    const enable = lines.findIndex((l) =>
      l.includes("corepack enable --install-directory /usr/local/bin pnpm"),
    );
    expect(enable).toBeGreaterThan(
      lines.findIndex((l) => l.includes("nodejs.org/download/release")),
    );
    expect(file).toContain("test -x /usr/local/bin/pnpm");
    // Its downloads are cached in the persistent home, never pinned into a
    // repository's package.json, and never wait on a prompt.
    expect(lines).toContain(
      "ENV COREPACK_HOME=/home/ubuntu/.cache/node/corepack",
    );
    expect(lines).toContain("ENV COREPACK_ENABLE_AUTO_PIN=0");
    expect(lines).toContain("ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0");
    expect(lines.indexOf("ENV COREPACK_ENABLE_AUTO_PIN=0")).toBeLessThan(
      lines.indexOf("USER 1000:1000"),
    );
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

  test("strips every setuid and setgid bit before dropping root", () => {
    const strip = lines.findIndex((l) =>
      l.includes("find / -xdev -type f -perm /6000 -exec chmod ug-s {} +"),
    );
    expect(strip).toBeGreaterThan(
      lines.findIndex((l) => l.includes("bun-linux-$arch.zip")),
    );
    expect(file).toContain(
      'test -z "$(find / -xdev -type f -perm /6000 -print -quit)"',
    );
    expect(strip).toBeLessThan(lines.indexOf("USER 1000:1000"));
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
    const context = build.argv[8]!;
    expect(build.argv).toEqual([
      "build",
      "--pull=missing",
      "--network",
      PODMAN_PASTA_NETWORK,
      "-t",
      tag,
      "-f",
      "-",
      context,
    ]);
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

  test("callers that find the same image missing share one build", async () => {
    let built = false;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { run, calls } = fakeRunner((argv) => {
      if (argv[0] === "image") return built ? ok : missing;
      return ok;
    });
    const slow: PodmanRunner = async (argv, opts) => {
      if (argv[0] === "build") {
        await gate;
        built = true;
      }
      return run(argv, opts);
    };
    const first = ensurePodmanImage(slow);
    const second = ensurePodmanImage(slow);
    await Bun.sleep(5);
    finish();
    expect(await Promise.all([first, second])).toEqual([
      podmanImageTag(),
      podmanImageTag(),
    ]);
    expect(calls.filter((c) => c.argv[0] === "build")).toHaveLength(1);
    // Settled: the next caller checks again rather than reusing it.
    expect(await ensurePodmanImage(slow)).toBe(podmanImageTag());
    expect(calls.filter((c) => c.argv[0] === "build")).toHaveLength(1);
  });
});

describe("old sandbox images", () => {
  const REPO = "localhost/opensession-sandbox";
  const image = (
    tag: string,
    created: number,
    containers = 0,
    size = 1_000_000_000,
  ) => ({
    Id: `${tag}${"0".repeat(48)}`,
    Names: [`${REPO}:${tag}`],
    Created: created,
    Size: size,
    Containers: containers,
  });

  test("keep the current and the previous image, and any a container uses", async () => {
    const listing = [
      image("0000000000000004", 400), // current
      image("0000000000000003", 300), // previous: kept for a rollback
      image("0000000000000002", 200, 2), // a sleeping sandbox still uses it
      image("0000000000000001", 100, 0, 800_000_000),
      image("0000000000000000", 50, 0, 700_000_000),
    ];
    const { run, calls } = fakeRunner((argv) =>
      argv[0] === "image" && argv[1] === "ls"
        ? { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" }
        : ok,
    );
    const result = await prunePodmanImages(run, `${REPO}:0000000000000004`);
    expect(result).toEqual({
      removed: [`${REPO}:0000000000000001`, `${REPO}:0000000000000000`],
      bytes: 1_500_000_000,
    });
    expect(calls.map(({ argv }) => argv)).toEqual([
      ["image", "ls", "--filter", `reference=${REPO}`, "--format", "json"],
      ["image", "rm", `${REPO}:0000000000000001`],
      ["image", "rm", `${REPO}:0000000000000000`],
    ]);
  });

  test("a refused removal (in use after all) is skipped, not counted", async () => {
    const listing = [
      image("0000000000000004", 400),
      image("0000000000000003", 300),
      image("0000000000000001", 100),
    ];
    const { run } = fakeRunner((argv) =>
      argv[1] === "ls"
        ? { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" }
        : {
            exitCode: 2,
            stdout: "",
            stderr: "image is in use by a container",
          },
    );
    expect(await prunePodmanImages(run, `${REPO}:0000000000000004`)).toEqual({
      removed: [],
      bytes: 0,
    });
  });

  test("nothing is removed when the current image is not there, or the list fails", async () => {
    const listing = [image("0000000000000003", 300), image("01", 100)];
    const { run, calls } = fakeRunner((argv) =>
      argv[1] === "ls"
        ? { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" }
        : ok,
    );
    expect(
      (await prunePodmanImages(run, `${REPO}:0000000000000004`)).removed,
    ).toEqual([]);
    expect(calls).toHaveLength(1);
    const broken = fakeRunner(() => ({
      exitCode: 125,
      stdout: "",
      stderr: "database is locked",
    }));
    await expect(
      prunePodmanImages(broken.run, `${REPO}:0000000000000004`),
    ).rejects.toThrow(/database is locked/);
  });

  test("only this provider's image repository is ever named", async () => {
    const listing = [
      image("0000000000000004", 400),
      image("0000000000000003", 300),
      {
        ...image("x", 10),
        Names: ["docker.io/library/postgres:17-alpine"],
      },
    ];
    const { run, calls } = fakeRunner((argv) =>
      argv[1] === "ls"
        ? { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" }
        : ok,
    );
    await prunePodmanImages(run, `${REPO}:0000000000000004`);
    expect(calls.filter(({ argv }) => argv[1] === "rm")).toEqual([]);
  });
});
