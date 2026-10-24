/**
 * Every podman argv shape this adapter runs, each one run against rootless
 * podman 5.8.2 (with nftables 1.0.9 and GNU coreutils du in its user
 * namespace) and its output read by this adapter's parsers. The test
 * stand-in (podman-test-fixture.ts) refuses any argv outside this list, so a
 * new or changed command fails the tests until it has been checked on a
 * real host and added here.
 *
 * nft is checked through createPodmanRunner itself (Bun.spawn, as the
 * gateway's own SELinux context), not through a shell or ssh: its output
 * only reaches the gateway through the pipes NFT_PIPE_SCRIPT sets up.
 */

const NAME = String.raw`[a-z0-9][a-z0-9_.-]*`;
const PATH = String.raw`/[A-Za-z0-9_./-]+`;
const FORMAT_FIELDS = [
  "{{.State.Running}}",
  "{{.State.Running}} {{.State.Pid}} {{.State.StartedAt}}",
  "{{.State.Pid}}",
  "{{.State.CgroupPath}}",
  "{{.NetworkSettings.SandboxKey}}",
];

/** A copy of podman-egress.ts's NFT_PIPE_SCRIPT, kept here on purpose: a
 *  changed script fails the tests until it has been run on a host. */
const NFT_PIPE_SCRIPT =
  'set -o pipefail; { nsenter --net="$1" nft "${@:2}" 2>&1 >&3 3>&- | cat >&2 3>&-; } 3>&1 | cat';

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Shapes over the argv joined with NUL (so values may hold spaces). */
const SHAPES: RegExp[] = [
  `info\x00--format\x00(json|\\{\\{\\.Store\\.GraphRoot\\}\\})`,
  `(pod|container|volume)\x00exists\x00${NAME}`,
  `image\x00exists\x00[^\x00]+`,
  `(pod|volume)\x00inspect\x00--format\x00\\{\\{index \\.Labels "opensession\\.sandbox"\\}\\}\x00${NAME}`,
  `pod\x00inspect\x00--format\x00\\{\\{\\.State\\}\\}\x00${NAME}`,
  `container\x00inspect\x00--format\x00(${FORMAT_FIELDS.map(escape).join("|")})\x00${NAME}`,
  `volume\x00create\x00--label\x00[^\x00]+\x00--label\x00[^\x00]+\x00${NAME}`,
  `pod\x00create\x00--name\x00${NAME}\x00--infra-name\x00${NAME}\x00--network\x00pasta:[^\x00]+(\x00--dns\x00[0-9.]+)+\x00--dns-search\x00\\.\x00--no-hosts\x00--hostname\x00sandbox\x00--share\x00net,uts,ipc\x00--label\x00[^\x00]+\x00--label\x00[^\x00]+`,
  `create\x00--pod\x00${NAME}\x00--name\x00${NAME}\x00--label\x00[^\x00]+\x00--user\x001000:1000\x00--cap-drop\x00ALL\x00--security-opt\x00no-new-privileges\x00--security-opt\x00label=type:container_t\x00--read-only\x00--read-only-tmpfs=true\x00--tmpfs\x00/tmp:rw,nosuid,nodev,size=1g\x00--init\x00--pids-limit\x00\\d+\x00--memory\x00\\d+m\x00--memory-swap\x00\\d+m(\x00--cpus\x00[0-9.]+)?\x00--ulimit\x00nofile=65536:65536\x00-v\x00${NAME}:/home/ubuntu:Z,nosuid,nodev\x00[^\x00]+\x00sleep\x00infinity`,
  `start\x00${NAME}`,
  `pod\x00stop(\x00-t\x00\\d+)?\x00${NAME}`,
  `pod\x00kill\x00${NAME}`,
  `rm\x00-f\x00-t\x00[0-9]+\x00${NAME}`,
  `pod\x00rm\x00-f\x00-t\x00\\d+\x00${NAME}`,
  `volume\x00rm\x00${NAME}`,
  `pod\x00ps\x00--filter\x00label=opensession\\.sandbox=1\x00--format\x00\\{\\{\\.Name\\}\\}`,
  `volume\x00ls\x00--filter\x00label=opensession\\.sandbox=1\x00--format\x00(json|\\{\\{\\.Name\\}\\})`,
  `unshare\x00/bin/bash\x00-c\x00${escape(NFT_PIPE_SCRIPT)}\x00bash\x00${PATH}\x00(-f\x00-|-j\x00list\x00ruleset|-j\x00list\x00table\x00inet\x00opensession)`,
  `unshare\x00du\x00-s\x00-x\x00-B1\x00--(\x00${PATH})+`,
  `exec(\x00-i)?(\x00-d)?\x00--user\x001000:1000(\x00--workdir\x00${PATH})?(\x00--env-file\x00${PATH})?\x00${NAME}(\x00/usr/bin/timeout\x00-k\x005\x00\\d+)?\x00/bin/bash\x00-c\x00[\\s\\S]*`,
  `build\x00--pull=missing\x00--network\x00pasta:[^\x00]+\x00-t\x00[^\x00]+\x00-f\x00-\x00${PATH}`,
].map((shape) => new RegExp(`^${shape}$`));

/** Whether `argv` (after `podman`) is a shape checked on a real host. */
export function isVerifiedPodmanArgv(argv: readonly string[]): boolean {
  const joined = argv.join("\x00");
  return SHAPES.some((shape) => shape.test(joined));
}
