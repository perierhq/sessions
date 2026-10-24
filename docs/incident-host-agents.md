# Incident agents on the host

> **Experimental, off by default, not recommended.** Configure a sandbox for
> each project whose incidents agents should work on. The host path below
> runs only when the service environment sets
> `OPENSESSION_INCIDENT_HOST_AGENTS=1`. Without it, an incident whose project
> has no sandbox goes to Needs you with "Agents can't start: this project
> has no sandbox" and a button to Settings → Sandboxes, and its agents never
> start on the host. Try again is offered once a sandbox is ready. If its
> signals recover before anyone acts, the incident closes by itself.

An incident's investigator and verifier work in the project's sandbox when it
has one (Daytona, Boat, and later a Mac VM on a paired Mac). Without one, they
work in This machine (container) when it is Ready
([self-hosting-sandboxes.md](self-hosting-sandboxes.md#this-machine-container)).
With the host path turned on and neither available, they can run in an ordinary session worktree
on the Sessions server, with their shell commands run as a separate
low-privilege system user: the incident agent user. The incident page then
says "Runs on this server, not in a sandbox".

This path exists only for incident agents, never for other automation
descendants, and only when it is turned on and the incident agent user is
set up as below. Without a sandbox and without a working incident agent user,
an incident's agents do not start: the incident goes to Needs you with the
step that is missing, and Retry tries again.

## Setup (Linux)

The steps use the default user name `opensession-incident`. To use another
name, set `OPENSESSION_INCIDENT_AGENT_USER` in the service environment (a
plain lower-case system user name; anything else falls back to the
default). `<gateway user>` is the user the Sessions service runs as.

1. Create the user, with no home and no login shell:

   ```sh
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin opensession-incident
   ```

2. Put the worktrees outside the gateway user's home and state directory,
   and share them through a group. Set `paths.worktreesDir` in
   `~/.opensession/config.json` (or `OPENSESSION_WORKTREES_DIR`) to a
   directory such as `/srv/opensession-worktrees`, then:

   ```sh
   sudo groupadd -f opensession-work
   sudo usermod -aG opensession-work opensession-incident
   sudo usermod -aG opensession-work <gateway user>
   sudo chgrp -R opensession-work <worktreesDir>
   sudo chmod -R g+rwX <worktreesDir>
   sudo find <worktreesDir> -type d -exec chmod g+s {} +
   ```

   A worktree's commits are written to its repository's `.git` directory, so
   give the group the same access to each registered repository that
   incident agents work in, and make Git keep it:

   ```sh
   sudo chgrp -R opensession-work <repo>/.git
   sudo chmod -R g+rwX <repo>/.git
   sudo find <repo>/.git -type d -exec chmod g+s {} +
   git -C <repo> config core.sharedRepository group
   ```

   Every directory above those paths needs the execute bit for the group or
   for others, so the user can reach them.

3. Make the state directory private to the gateway user:

   ```sh
   chmod 700 ~/.opensession
   ```

   (or the directory `OPENSESSION_STATE_DIR` names). The user must be able
   neither to list nor to enter it.

4. Let the service run `/bin/bash` as the user, keeping the environment it
   builds, without opening a login session. Create
   `/etc/sudoers.d/opensession-incident`:

   ```
   <gateway user> ALL=(opensession-incident) NOPASSWD:SETENV: /bin/bash
   Defaults>opensession-incident !pam_session
   ```

   and check it with `sudo visudo -cf /etc/sudoers.d/opensession-incident`.
   Without `!pam_session`, sudo's PAM session on some distributions moves the
   command into a login session of its own, where Sessions cannot stop it.

5. Set `OPENSESSION_INCIDENT_HOST_AGENTS=1` in the service environment and
   restart Sessions. Nothing changes in Settings. The next incident without
   a sandbox runs its agents as this user.

Sessions checks all of this before it starts an agent on the host, at most
once a minute: the platform is Linux; the user exists and is neither root
nor the gateway user; `sudo -n -E -u opensession-incident -- /bin/bash` runs
without a password; the user can neither list nor enter the state
directory; the user can write the worktrees directory; Sessions runs as its
systemd service on a kernel with cgroup v2 `cgroup.kill` (Linux 5.14 or
newer); and a command run through sudo stays in the caller's cgroup. The
first check that fails is what the incident shows.

## What the user can and cannot reach

It can read and write its worktree and the repository objects that worktree
links to, read the shared ask checkouts, and read world-readable system
files. Its shell commands get the same minimal environment as any automation
run, with its home, `TMPDIR` and tool configuration under
`/tmp/opensession-incident-<session>`, a directory it creates itself and
must own.

It cannot read the Sessions state directory (the catalog, sessions,
transcripts, the keychain store, the audit log), the gateway user's home or
other users' homes, unless they are world-readable.

Processes the incident agent user starts cannot be signalled by the gateway
user, so Sessions stops them through their cgroup instead. A turn normally
runs in a detached run host, a transient system unit: when the turn ends,
systemd stops the unit and kills everything in it, including commands the
agent left running in the background as the incident agent user. A turn
that runs in the Sessions process itself gives each shell command its own
transient user scope in the agent workload slice, and kills that scope
whole through `cgroup.kill` when the command ends, times out or is
cancelled. Without such a scope, a command as the incident agent user is
refused. Either way the work counts against the workload slice's memory
and task limits.

## Limits

- Only the shell runs as the incident agent user. The read, edit, write,
  find, ls and grep tools run in Sessions itself, as the gateway user,
  confined to the worktree by resolving every path (symlinks included)
  before use. An agent that swaps a symlink between that check and the
  access could race it; the incident agent user is the boundary for
  commands, the path check for the file tools.
- A background process an agent starts on purpose (a dev server for its
  checks) lives at most until its turn ends.
- The user is shared by every incident agent on the host. Two agents
  running at once can see each other's worktrees and `/tmp` homes.
- `/tmp/opensession-incident-<session>` is not removed with the session;
  the system's `/tmp` cleanup removes it.
- A sandbox remains the stronger boundary. Use one where you can.
