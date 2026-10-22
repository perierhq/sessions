/**
 * podman-image — the local image every "This machine (container)" Sandbox
 * runs (docs/self-hosting-sandboxes.md).
 *
 * The workload never has root, so everything `bootstrapRemoteSandbox` would
 * install as root is baked at build time instead: the workspace packages,
 * the pinned Node, just and gh in /usr/local/bin (Node and gh checked
 * against their published SHA-256 sums), and bun in /home/ubuntu/.bun owned
 * by the image's uid 1000. On a Sandbox's first start podman copies that
 * home into the session's empty volume; bootstrapRemoteSandbox then only
 * verifies it. The image ends as uid 1000 and carries no privilege
 * escalation tool.
 *
 * The tag hashes the base runtime signature, the base digest and this
 * Containerfile, so a change to any of them means a new image. Building
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
  PODMAN_WORKLOAD_USER,
  type PodmanRunner,
} from "./podman-cli";

/** Ubuntu 24.04, pinned to its multi-arch (amd64 + arm64) index digest. Its
 *  `ubuntu` user is uid 1000 with home /home/ubuntu (REMOTE_HOME). */
export const PODMAN_BASE_IMAGE =
  "docker.io/library/ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac";

export const PODMAN_IMAGE_REPO = "localhost/opensession-sandbox";

/** One `RUN` whose steps run under `set -eu` and stop at the first failure.
 *  /bin/sh is dash, so no pipes carry a download into a shell. */
function run(steps: string[]): string {
  return `RUN set -eu; \\\n    ${steps.join("; \\\n    ")}`;
}

const ARCH_NODE =
  'case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; ' +
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
    `LABEL opensession.sandbox-runtime=${JSON.stringify(signature)}`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    run([
      "apt-get update",
      `apt-get install -y --no-install-recommends ${REMOTE_LINUX_PACKAGES.join(" ")}`,
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/*",
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
      "curl -fsSL https://just.systems/install.sh -o /tmp/just-install.sh",
      `bash /tmp/just-install.sh --tag ${REMOTE_JUST_VERSION} --to /usr/local/bin`,
      "rm -f /tmp/just-install.sh",
      `test "$(/usr/local/bin/just --version | awk '{print $2}')" = "${REMOTE_JUST_VERSION}"`,
    ]),
    run([
      "curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh",
      `HOME=${home} bash /tmp/bun-install.sh`,
      "rm -f /tmp/bun-install.sh",
      `test -x ${home}/.bun/bin/bunx || ln -sf ${home}/.bun/bin/bun ${home}/.bun/bin/bunx`,
      `mkdir -p ${home}/.local/bin`,
      `chown -R ${PODMAN_WORKLOAD_USER} ${home}`,
      `test "$(stat -c %u:%g ${home})" = "${PODMAN_WORKLOAD_USER}"`,
    ]),
    `ENV PATH=${path}`,
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
      ["build", "--pull=missing", "-t", tag, "-f", "-", context],
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
