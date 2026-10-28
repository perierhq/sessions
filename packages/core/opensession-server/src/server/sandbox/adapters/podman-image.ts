/**
 * podman-image — the local image every "This machine (container)" Sandbox
 * runs (docs/self-hosting-sandboxes.md).
 *
 * The workload never has root, so everything `bootstrapRemoteSandbox` would
 * install as root is baked at build time instead: the workspace packages
 * plus ffmpeg and ImageMagick, the pinned Node (with corepack's pnpm shim),
 * just and gh in /usr/local/bin, and the pinned bun in
 * /home/ubuntu/.bun owned by the image's uid 1000. Every download is a
 * release archive checked by SHA-256 (Node, gh and bun against their
 * published sums, just and bun against sums pinned here); no install
 * script is ever run. On a Sandbox's first start podman copies that
 * home into the session's empty volume; bootstrapRemoteSandbox then only
 * verifies it. The image ends as uid 1000, carries no privilege escalation
 * tool and has no setuid or setgid file. Its RUN steps get the same
 * restricted pasta network as a Sandbox pod (no host gateway, no guest
 * mapping, no port forwards, no IPv6).
 *
 * The tag hashes the image signature (the base runtime's plus the bun and
 * just pins), the base digest and this Containerfile, so a change to any of them means a new image. Building
 * happens at qualification, never on a user's ensure.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseRuntimeSignature,
  remoteLayout,
  REMOTE_GH_VERSION,
  REMOTE_HOME,
  REMOTE_JUST_VERSION,
  REMOTE_LINUX_PACKAGES,
  REMOTE_NODE_VERSION,
} from "./bootstrap";
import {
  PODMAN_LONG_TIMEOUT_MS,
  PODMAN_PASTA_NETWORK,
  PODMAN_WORKLOAD_USER,
  type PodmanRunner,
} from "./podman-cli";

/** Ubuntu 24.04, pinned to its multi-arch (amd64 + arm64) index digest. Its
 *  `ubuntu` user is uid 1000 with home /home/ubuntu (REMOTE_HOME). */
export const PODMAN_BASE_IMAGE =
  "docker.io/library/ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac";

export const PODMAN_IMAGE_REPO = "localhost/opensession-sandbox";

/** Media tools the image adds to the workspace packages: ffmpeg for screen
 *  recordings (agent-browser records through it) and ImageMagick for
 *  resizing, cropping and comparing screenshots. Only this image carries
 *  them; other providers' bootstrap installs the workspace packages alone. */
export const PODMAN_MEDIA_PACKAGES = ["ffmpeg", "imagemagick"] as const;

/** bun in the image (the repo's own packageManager version). */
export const PODMAN_BUN_VERSION = "1.4.0";
/** SHA-256 of `bun-linux-<arch>.zip` for PODMAN_BUN_VERSION, from the
 *  release's SHASUMS256.txt. */
export const PODMAN_BUN_SHA256 = {
  x64: "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452",
  aarch64: "4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e",
} as const;
/** SHA-256 of `just-<REMOTE_JUST_VERSION>-<target>.tar.gz`, from the
 *  release's SHA256SUMS. Update with REMOTE_JUST_VERSION. */
export const PODMAN_JUST_SHA256 = {
  "x86_64-unknown-linux-musl":
    "6a3003f68fa4d86ada8afe33830a88ffdb6c2fcaff4e5a840b1cb90eaf6f46fc",
  "aarch64-unknown-linux-musl":
    "e28e1f18cecd45d35f9fb39ef3651dd79c0623cb29a2f375ea7a1a185ac32dc9",
} as const;

/** The image's runtime signature: the base runtime's plus the image-only
 *  pins, so changing any of them names a new image. */
export function podmanImageSignature(
  base: string = baseRuntimeSignature(),
): string {
  return `${base}+bun@${PODMAN_BUN_VERSION}+just-release@${REMOTE_JUST_VERSION}`;
}

/** One `RUN` whose steps run under `set -eu` and stop at the first failure.
 *  /bin/sh is dash, so no pipes carry a download into a shell. */
function run(steps: string[]): string {
  return `RUN set -eu; \\\n    ${steps.join("; \\\n    ")}`;
}

const ARCH_NODE =
  'case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; ' +
  '*) echo "unsupported architecture: $(uname -m)" >&2; exit 1;; esac';
const ARCH_BUN =
  'case "$(uname -m)" in ' +
  `x86_64) arch=x64; sum=${PODMAN_BUN_SHA256.x64};; ` +
  `aarch64|arm64) arch=aarch64; sum=${PODMAN_BUN_SHA256.aarch64};; ` +
  '*) echo "unsupported architecture: $(uname -m)" >&2; exit 1;; esac';
const ARCH_JUST =
  'case "$(uname -m)" in ' +
  `x86_64) target=x86_64-unknown-linux-musl; sum=${PODMAN_JUST_SHA256["x86_64-unknown-linux-musl"]};; ` +
  `aarch64|arm64) target=aarch64-unknown-linux-musl; sum=${PODMAN_JUST_SHA256["aarch64-unknown-linux-musl"]};; ` +
  '*) echo "unsupported architecture: $(uname -m)" >&2; exit 1;; esac';
const ARCH_GH =
  'case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; ' +
  '*) echo "unsupported architecture: $(uname -m)" >&2; exit 1;; esac';

/** The Containerfile, fed to `podman build` on stdin. */
export function podmanContainerfile(
  signature: string = baseRuntimeSignature(),
): string {
  const home = REMOTE_HOME;
  const path = remoteLayout("linux").path;
  return [
    `FROM ${PODMAN_BASE_IMAGE}`,
    `LABEL opensession.sandbox-runtime=${JSON.stringify(podmanImageSignature(signature))}`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    run([
      "apt-get update",
      `apt-get install -y --no-install-recommends ${[...REMOTE_LINUX_PACKAGES, ...PODMAN_MEDIA_PACKAGES].join(" ")}`,
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/*",
      "command -v ffmpeg",
      "command -v convert",
    ]),
    run([
      ARCH_NODE,
      `version=${REMOTE_NODE_VERSION}`,
      'archive="node-v$version-linux-$arch.tar.xz"',
      "tmp=$(mktemp -d)",
      'cd "$tmp"',
      'curl -fsSL "https://nodejs.org/download/release/v$version/$archive" -o "$archive"',
      'curl -fsSL "https://nodejs.org/download/release/v$version/SHASUMS256.txt" -o SHASUMS256.txt',
      'grep "  $archive$" SHASUMS256.txt > expected',
      "test -s expected",
      "sha256sum -c expected",
      'tar -xJf "$archive" --strip-components=1 -C /usr/local',
      "cd /",
      'rm -rf "$tmp"',
      `test "$(/usr/local/bin/node -p 'process.versions.node')" = "${REMOTE_NODE_VERSION}"`,
      // pnpm through Node's own corepack: the shim goes in now, since the
      // root is read-only at run time. It fetches the repository's
      // packageManager version (signature-checked) on first use.
      "corepack enable --install-directory /usr/local/bin pnpm",
      "test -x /usr/local/bin/pnpm",
    ]),
    run([
      ARCH_GH,
      `dist="gh_${REMOTE_GH_VERSION}_linux_$arch"`,
      "tmp=$(mktemp -d)",
      'cd "$tmp"',
      `curl -fsSL "https://github.com/cli/cli/releases/download/v${REMOTE_GH_VERSION}/$dist.tar.gz" -o "$dist.tar.gz"`,
      `curl -fsSL "https://github.com/cli/cli/releases/download/v${REMOTE_GH_VERSION}/gh_${REMOTE_GH_VERSION}_checksums.txt" -o checksums.txt`,
      'grep "  $dist.tar.gz$" checksums.txt > expected',
      "test -s expected",
      "sha256sum -c expected",
      'tar -xzf "$dist.tar.gz"',
      'install -m 0755 "$dist/bin/gh" /usr/local/bin/gh',
      "cd /",
      'rm -rf "$tmp"',
      `test "$(/usr/local/bin/gh --version | head -n1 | awk '{print $3}')" = "${REMOTE_GH_VERSION}"`,
    ]),
    run([
      ARCH_JUST,
      `archive="just-${REMOTE_JUST_VERSION}-$target.tar.gz"`,
      "tmp=$(mktemp -d)",
      'cd "$tmp"',
      `curl -fsSL "https://github.com/casey/just/releases/download/${REMOTE_JUST_VERSION}/just-${REMOTE_JUST_VERSION}-$target.tar.gz" -o "$archive"`,
      `printf '%s  %s\\n' "$sum" "$archive" > expected`,
      "sha256sum -c expected",
      'tar -xzf "$archive" just',
      "install -m 0755 just /usr/local/bin/just",
      "cd /",
      'rm -rf "$tmp"',
      `test "$(/usr/local/bin/just --version | awk '{print $2}')" = "${REMOTE_JUST_VERSION}"`,
    ]),
    run([
      ARCH_BUN,
      'archive="bun-linux-$arch.zip"',
      "tmp=$(mktemp -d)",
      'cd "$tmp"',
      `curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${PODMAN_BUN_VERSION}/$archive" -o "$archive"`,
      `curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${PODMAN_BUN_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt`,
      'grep "  $archive$" SHASUMS256.txt > published',
      "test -s published",
      "sha256sum -c published",
      `printf '%s  %s\\n' "$sum" "$archive" > pinned`,
      "sha256sum -c pinned",
      'unzip -q "$archive"',
      `mkdir -p ${home}/.bun/bin`,
      `install -m 0755 "bun-linux-$arch/bun" ${home}/.bun/bin/bun`,
      `ln -sf bun ${home}/.bun/bin/bunx`,
      "cd /",
      'rm -rf "$tmp"',
      `test "$(${home}/.bun/bin/bun --version)" = "${PODMAN_BUN_VERSION}"`,
      `mkdir -p ${home}/.local/bin`,
      `chown -R ${PODMAN_WORKLOAD_USER} ${home}`,
      `test "$(stat -c %u:%g ${home})" = "${PODMAN_WORKLOAD_USER}"`,
    ]),
    // The workload has no-new-privileges already; this keeps a setuid binary
    // from ever being a way back to the root that maps to the gateway user.
    run([
      "find / -xdev -type f -perm /6000 -exec chmod ug-s {} +",
      'test -z "$(find / -xdev -type f -perm /6000 -print -quit)"',
    ]),
    `ENV PATH=${path}`,
    // corepack caches what it fetches in the persistent home, whatever
    // HOME a command runs with, never pins a version into a repository's
    // package.json, and never waits on a prompt.
    `ENV COREPACK_HOME=${home}/.cache/node/corepack`,
    "ENV COREPACK_ENABLE_AUTO_PIN=0",
    "ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    `USER ${PODMAN_WORKLOAD_USER}`,
    `WORKDIR ${home}`,
    "",
  ].join("\n");
}

/** `localhost/opensession-sandbox:<16 hex>` for the current runtime. */
export function podmanImageTag(
  signature: string = baseRuntimeSignature(),
): string {
  const hash = createHash("sha256")
    .update(signature)
    .update("\n")
    .update(PODMAN_BASE_IMAGE)
    .update("\n")
    .update(podmanContainerfile(signature))
    .digest("hex");
  return `${PODMAN_IMAGE_REPO}:${hash.slice(0, 16)}`;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 800 ? `…${trimmed.slice(-800)}` : trimmed;
}

/**
 * Make sure the current image exists, building it when it does not.
 * Returns its tag. The build context is an empty temporary directory, so
 * nothing from this host is sent to the build.
 */
export async function ensurePodmanImage(
  runPodman: PodmanRunner,
  log: (line: string) => void = () => {},
): Promise<string> {
  const tag = podmanImageTag();
  if ((await runPodman(["image", "exists", tag])).exitCode === 0) return tag;
  log(`building ${tag} (this pulls ${PODMAN_BASE_IMAGE.split("@")[0]})…`);
  const context = await mkdtemp(join(tmpdir(), "opensession-podman-build-"));
  try {
    const result = await runPodman(
      [
        "build",
        "--pull=missing",
        "--network",
        PODMAN_PASTA_NETWORK,
        "-t",
        tag,
        "-f",
        "-",
        context,
      ],
      { stdin: podmanContainerfile(), timeoutMs: PODMAN_LONG_TIMEOUT_MS },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `podman image build failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout)}`,
      );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
  if ((await runPodman(["image", "exists", tag])).exitCode !== 0)
    throw new Error(`podman image ${tag} not found after build`);
  log(`built ${tag}`);
  return tag;
}
