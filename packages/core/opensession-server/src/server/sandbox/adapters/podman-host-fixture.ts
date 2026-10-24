/**
 * Output captured from rootless podman 5.8.2 (nftables 1.0.9, GNU coreutils
 * du 8.32) running the commands this adapter runs. Only names, paths, ids and
 * times are replaced with example values; the shapes are as podman printed
 * them.
 */

export const HOST_MOUNTPOINT =
  "/home/example/.local/share/containers/storage/volumes/opensession-sbx-sess-1-home/_data";

/** `podman volume ls --filter label=opensession.sandbox=1 --format json`. */
export const HOST_VOLUME_LS_JSON = `[
  {
    "Name": "opensession-sbx-sess-1-home",
    "Driver": "local",
    "Mountpoint": "${HOST_MOUNTPOINT}",
    "CreatedAt": "2026-01-01T00:00:00.000000000Z",
    "Labels": {
      "opensession.sandbox": "1",
      "opensession.sandbox.session": "sess-1"
    },
    "Scope": "local",
    "Options": {
      
    },
    "UID": 1000,
    "GID": 1000,
    "MountCount": 0,
    "NeedsCopyUp": true,
    "NeedsChown": true,
    "LockNumber": 4
  }
]
`;

/** `podman volume ls ... --format json` with no matching volume. */
export const HOST_VOLUME_LS_EMPTY = "[]\n";

/** `podman unshare du -s -x -B1 -- <mountpoint>`: a 3 MB file and a 1 GiB
 *  sparse file (block usage, so the sparse file counts for nothing). */
export const HOST_DU_OUTPUT = `3002368\t${HOST_MOUNTPOINT}\n`;

/** The same du with a path that vanished: exit 1, the others still summed. */
export const HOST_DU_VANISHED_STDERR =
  "du: cannot access '/home/example/gone': No such file or directory\n";

/** `du` run without `podman unshare`: exit 1, and the total is short. */
export const HOST_DU_DENIED_STDERR = `du: cannot read directory '${HOST_MOUNTPOINT}/d': Permission denied\n`;

/** `podman system df -v --format json` (what an earlier version ran). */
export const HOST_SYSTEM_DF_VERBOSE_JSON_STDERR =
  "Error: cannot combine --format and --verbose flags\n";

/** `podman pod ps -a ...` (what an earlier version ran). */
export const HOST_POD_PS_ALL_STDERR =
  "Error: unknown shorthand flag: 'a' in -a\nSee 'podman pod ps --help'\n";

/** `podman pod ps --filter label=opensession.sandbox=1 --format {{.Name}}`
 *  with one running, one stopped and one never-started pod: all listed. */
export const HOST_POD_PS_NAMES =
  "opensession-sbx-qual-0123456789ab\nopensession-sbx-sess-1\nopensession-sbx-sess-2\n";

/** `podman pod inspect --format {{.State}}` before start, running, after
 *  `pod stop`. */
export const HOST_POD_STATES = ["Created", "Running", "Exited"] as const;

/** `podman container inspect --format "{{.State.Running}} {{.State.Pid}}
 *  {{.State.StartedAt}}"` on a running workload: StartedAt has spaces. */
export const HOST_WORKLOAD_RUN =
  "true 4242 2026-01-01 00:00:01.000000000 +0000 UTC\n";

/** `podman container inspect --format {{.State.CgroupPath}}` on a workload
 *  started with the user's systemd session. */
export const HOST_CGROUP_PATH =
  "/user.slice/user-1001.slice/user@1001.service/user.slice/user-libpod_pod_0123.slice/libpod-4567.scope\n";

/** `podman container inspect --format {{.NetworkSettings.SandboxKey}}` on
 *  a running infra container. */
export const HOST_SANDBOX_KEY =
  "/run/user/1001/netns/netns-01234567-89ab-cdef-0123-456789abcdef\n";

/** `podman {pod,volume} inspect` of a missing name: exit 125. */
export const HOST_NO_SUCH_POD = "Error: no such pod opensession-sbx-gone\n";
export const HOST_NO_SUCH_VOLUME =
  "Error: no such volume opensession-sbx-gone-home\n";
