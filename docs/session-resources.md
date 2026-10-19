# What a session leaves running

Archiving or deleting a session stops what it started on the host, not only
its Portals. Everything here is in
`packages/core/opensession-server/src/server/session-resources.ts` (stop
paths) and `session-ownership.ts` (labels).

## What is stopped

| Resource                              | How the session is known                      | Stopped by                     |
| ------------------------------------- | --------------------------------------------- | ------------------------------ |
| Portals                               | Portal record (`portal-supervisor.ts`)        | Portal stop                    |
| Fresh-worktree setup and what it left | Session-resource record (`kind: "setup"`)     | systemd scope or process group |
| Containers (podman, docker)           | Label `opensession.session=<id>`              | `podman stop` / `docker stop`  |
| systemd user units and scopes         | `opensession.session=<id>` in the Description | `systemctl --user stop`        |

Agent shell commands on a Linux control-plane install each run in a
transient scope (`opensession-agent-cmd-*`). The scope outlives the command
while anything it put in the background (a dev server, `nohup`, `setsid`)
still runs, and it carries the session label, so it is stopped with the
session too.

Nothing without a matching record or label is ever stopped. Containers and
units started outside a session are never touched.

## Labelling containers

Every local agent shell, script run (`run_script`), Portal command and
session-tagged worktree setup gets these environment variables:

- `OPENSESSION_SESSION_ID`: the session's id.
- `OPENSESSION_UNIT_LABEL`: `opensession.session=<id> opensession.instance=<instance>`.

When podman or docker is installed, these environments also put a small
generated shim directory first on `PATH` (`<state>/container-shims/`). The
shim sees `podman run …`, `podman create …` and `podman container run|create …`
(the same for docker) and adds
`--label opensession.session=$OPENSESSION_SESSION_ID --label opensession.instance=<instance>`,
then execs the real CLI. It passes every other command through unchanged, and
it does nothing in a shell without `OPENSESSION_SESSION_ID`. Your own shells
and system services never have the shim on `PATH`, so podman and docker
behave as before outside sessions.

Why a shim rather than the alternatives:

- `containers.conf` has no per-session default label (and docker has no
  equivalent), so it cannot name the session.
- A convention in the run instructions alone depends on the agent remembering
  it every time. The run instructions still name the label for launchers the
  shim cannot see.

What the shim does not cover: compose, a CLI called by absolute path, or
global flags before the subcommand (`podman --remote run`). Those containers
carry no label unless the agent adds `opensession.session=$OPENSESSION_SESSION_ID`
itself, so archive leaves them alone. A unit an agent starts with
`systemd-run --user` is owned when it passes
`--description="$OPENSESSION_UNIT_LABEL"`.

The instance label is a hash of this installation's state root. A second
instance on the same host user (a dev gateway, for example) never treats
another instance's containers as ownerless.

## When it happens

- **Archive and delete**: after the archive is committed, `archive.ts` (and
  the Plain archive path) stops the session's Portals and then its session
  resources. Deleting a session does the same with reason `removed`. A stop
  that fails is logged and retried by the reaper; the label stays.
- **Lifecycle reaper** (every five minutes, with the Portal reaper): stops
  labelled containers and units whose session is archived. One whose session
  is missing from the session list is stopped only when its instance label is
  this installation's, the session list is not empty, a direct lookup does not
  find the session either, and it started at least ten minutes ago (`ORPHANED_RESOURCE_GRACE_MS`, the same grace setup records
  get while a session is being created). A start time that cannot be read
  keeps it.

## Hosts

The labels need nothing from the host. Discovery checks what is there: podman
and docker are used only when installed and answering, and systemd units only
when a user manager is reachable. A macOS dev host without them runs none of
these commands. Every listing and stop has a timeout, so a hung container
daemon cannot hold an archive. Runner and Sandbox sessions are on other
machines: a Sandbox sleeps on archive, and nothing here reaches a runner's
containers.

To see what carries labels on a host:

```sh
podman ps --filter label=opensession.session --format '{{.ID}} {{.Label "opensession.session"}} {{.Names}}'
docker ps --filter label=opensession.session --format '{{.ID}} {{.Label "opensession.session"}} {{.Names}}'
systemctl --user list-units --type=service,scope --state=active --plain | grep opensession.session=
```
