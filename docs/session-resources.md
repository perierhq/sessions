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

Every local agent shell, script run (`run_script`) and Portal command gets
these environment variables:

- `OPENSESSION_SESSION_ID`: the session's id.
- `OPENSESSION_UNIT_LABEL`: `opensession.session=<id> opensession.instance=<instance>`.
- `XDG_RUNTIME_DIR`: the gateway's own, or `/run/user/<uid>` when the gateway
  has none and that directory exists. Rootless podman keeps its run root
  under it, so the agent's podman and the gateway's listing and stops use the
  same one. Without it, a minimal agent shell's podman would pick another run
  root and refuse with a database configuration mismatch.

Worktree setup (`.agents/setup`) gets none of them. Setup belongs to the
worktree, which sibling sessions can share, so a container it starts is not
labelled with the session that happened to create the worktree; archiving
that session leaves it running for the siblings. The setup's own process
tree is still tracked and stopped by its record.

When podman or docker is installed, these environments also put a small
generated shim directory first on `PATH` (`<state>/container-shims/`). The
shim sees `podman run …`, `podman create …` and `podman container run|create …`
(the same for docker), drops any `opensession.*` label the caller passed
(`--label`, `-l`, `--label=`; the last label wins, so a copied one could
claim the container for another session), adds
`--label opensession.session=$OPENSESSION_SESSION_ID --label opensession.instance=<instance>`,
then execs the real CLI. Other labels pass through. It passes every other command through unchanged, and
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
instance on the same host user (a dev gateway, for example) never stops
another instance's containers or units: archive teardown and the reaper act
only on resources whose instance label is this installation's, or that have
no instance label at all.

### A dev gateway started inside a session

A gateway started from an agent shell (a dev server for this repository)
inherits that shell's environment: `OPENSESSION_SESSION_ID`,
`OPENSESSION_UNIT_LABEL`, `XDG_RUNTIME_DIR` and the outer instance's
container shims on `PATH`.

- The dev gateway's own agent shells, scripts and Portals set their own
  session id and put the dev instance's shims first. A shim skips any other
  instance's shim directory when it looks for the real CLI, so their
  containers carry the dev session's and the dev instance's labels.
- Anything else the dev gateway process starts with the inherited
  environment (its worktree setup, a command run by hand from that shell)
  still has the outer session's id. A `podman run` there is labelled as the
  outer session's, with the outer instance, and is stopped when the outer
  session is archived.

Unset `OPENSESSION_SESSION_ID` before starting a dev gateway whose containers
should outlive the session it was started from.

## When it happens

- **Archive and delete**: after the archive is committed, `archive.ts` (and
  the Plain archive path) stops the session's Portals and then, in the
  background, its session resources. Deleting a session does the same with
  reason `removed`, also without holding the delete. Labelled stops run four
  at a time. A stop that fails is logged and retried by the reaper; the label
  stays.
- **Lifecycle reaper** (every five minutes, with the Portal reaper): stops
  labelled containers and units of this instance (or with no instance label)
  whose session is archived. One whose session
  is missing from the session list is stopped only when its instance label is
  this installation's, the session list is not empty, a direct lookup does not
  find the session either, and it started at least ten minutes ago (`ORPHANED_RESOURCE_GRACE_MS`, the same grace setup records
  get while a session is being created). A start time that cannot be read
  keeps it.

## Seeing what runs

The workspace summary (the session header's card) has a **Running** band
whenever the session still has something on the host: its Portals, worktree
setup, labelled containers and background processes, with memory where
systemd or the container CLI reports it. **Stop everything** asks first
("Stop N items?", Confirm or Cancel) and stops all of them once the session
is idle. The server refuses while a run is active, and asks again before
each stop: a run that starts part-way keeps what has not been stopped yet,
and the request answers 409 with the count stopped so far. Nothing outside
that list is stopped. Runner and Sandbox sessions run on other machines and
list nothing here.

The band refreshes every minute while it is on screen and not while the tab
is hidden. The server reuses one host-wide container and unit listing, with
the `stats --no-stream` memory figures, for 20 seconds across every
session's band and host health, and reads it again after any stop.

Host health (the server health popover, enabled in Preferences > Debug)
shows session workloads across the host, and lists what archived or deleted
sessions still have running. It says how many of those the lifecycle reaper
stops by itself and how many it leaves running: another instance's, a
missing session's without this instance's label, or one whose start time
cannot be read. Those need stopping by hand.

| Endpoint                                | Returns                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/sessions/:id/resources`       | The session's items (`portal`, `setup`, `container`, `unit`)                          |
| `POST /api/sessions/:id/resources/stop` | `{ stopped }`, or 409 while the session runs or once a run starts                     |
| `GET /api/host/session-resources`       | Counts by owner state (live, archived, missing), leftovers and which the reaper stops |
| `GET /api/health`                       | `sessionResources`: what the last reaper pass saw and stopped                         |

## Hosts

The labels need nothing from the host. Discovery checks what is there: podman
and docker are used only when installed and answering, and systemd units only
when a user manager is reachable. A macOS dev host without them runs none of
these commands. Every listing and stop has a timeout that kills the
command's whole process group and stops reading its output, so a hung
container daemon cannot hold an archive. A CLI whose listing timed out is
skipped for five minutes; a listing that fails is logged (at most every ten
minutes), since it reads as nothing running. Runner and Sandbox sessions are on other
machines: a Sandbox sleeps on archive, and nothing here reaches a runner's
containers.

To see what carries labels on a host:

```sh
podman ps --filter label=opensession.session --format '{{.ID}} {{.Label "opensession.session"}} {{.Names}}'
docker ps --filter label=opensession.session --format '{{.ID}} {{.Label "opensession.session"}} {{.Names}}'
systemctl --user list-units --type=service,scope --state=active --plain | grep opensession.session=
```
