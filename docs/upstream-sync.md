# Upstream sync

How this fork takes changes from upstream Open Session
(`tellahq/opensession`, remote `upstream`, push disabled). Read this before
porting any upstream commit.

## Default: take everything

This is a public fork. A feature nobody here uses today may be used by
someone who installs the fork, or by us later. So every upstream fix and
feature is ported by default, including native clients, integrations we
have not set up, and release pipelines.

Skip a commit only when it contradicts a fork decision (the "Perier
Sessions" section of `AGENTS.md`, or a decision named in an earlier sync
PR), or when it only makes sense for upstream's own accounts and has no
equivalent here. Every skip goes in the [Skipped](#skipped) table with its
reason, so the next sync does not triage it again.

Some known fork decisions an upstream commit can run into:

- Claude turns run on pi's own Anthropic provider with the account pool. The
  Claude CLI bridge is gone, and pi extensions are not loaded.
- `server/pi-runner.ts` is split into `server/pi-*.ts` modules (see the code
  map in `AGENTS.md`). Upstream diffs to `pi-runner.ts` land in whichever
  module now holds that code.
- Sandboxes include our Podman container provider, and per-project settings
  ("Where agents run", models, access) live in project settings. A new
  per-project default extends that model; it never becomes a parallel
  setting.
- Background git and GitHub fetches go through `githubServiceGitEnv`.
- Release workflows that sign or publish are gated by repo variables (see
  "Release workflows" in `AGENTS.md`) and skip cleanly when unset.

## 1. See what is pending

```sh
bun scripts/upstream-pending.ts          # pending commits, oldest first
bun scripts/upstream-pending.ts --all    # every upstream commit and its state
```

A commit counts as **ported** when a commit on `origin/main` carries its
`Upstream:` trailer, and as **skipped** when its sha is in the Skipped
table. The fork point comes from `NOTICE.md`.

## 2. Group into lanes

Split the pending commits into lanes by the files they touch, so parallel
workers never edit the same files. Use one branch and one PR per lane, named
`upstream-<lane>` and titled `Upstream sync: <lane>`. The lanes used so far:

| Lane      | Covers                                                                     |
| --------- | -------------------------------------------------------------------------- |
| `core`    | server and web frontend features and fixes, agent tools, models            |
| `clients` | native iOS and Mac apps, the Chrome extension, Apple release workflows     |
| `sandbox` | `server/sandbox/**`, Portals supervision, sandbox providers, GPU, identity |

When a commit spans lanes, the lane that owns most of it ports all of it, and
the other lanes leave those files alone. A lane bigger than one reviewable PR
splits into stacked PRs.

Before porting a lane, apply each commit to a scratch checkout of `origin/main`
on its own (`git apply -3 --check`). This shows which commits are
self-contained and which depend on earlier upstream commits or on fork code.

## 3. Port each commit

Work in upstream order, one fork commit per upstream commit:

1. Read the upstream diff and message: `git show <sha>`.
2. Apply it as a starting point: `git show <sha> | git apply -3`. Then adapt
   it to the fork (the decisions above). Never create merge or cherry-pick
   commits from upstream, so upstream authorship and history stay out of
   this repo's history.
3. Commit in our own words, ending the message with the trailer:

   ```
   Upstream: tellahq/opensession@<full sha>
   ```

   An adapted port says what changed and why in the body. A commit that
   folds several upstream commits carries one trailer line for each.

Special cases:

- **Format-only and merge commits:** fold them into the commit they format,
  and add their trailer there.
- **Reverts and partial reverts:** port the net effect of the series as one
  commit, with every trailer.
- **Generated files** (`docs/generated/*`): run `bun scripts/gen-catalogs.ts`
  rather than merging them by hand.
- **Dependencies:** run `bun install` and commit `bun.lock`. A `patches/`
  entry comes with its `package.json` change.
- **Upstream identities:** never carry over upstream's team IDs, bundle
  IDs, app IDs, domains, secrets names that point at their accounts, or
  internal hostnames. Use the fork's own, or placeholders listed in
  `AGENTS.md` "Release workflows" for whatever needs configuring first.
- **Public repo:** neutral text. Tests use `acme` and `example.test`.

## 4. Verify

- Run every test file the port touches, and its neighbours, one file at a
  time: `bun scripts/test-isolated.ts ./path.test.ts`.
- Then run typecheck, `format:check`, lint, `scripts/check-module-side-effects.ts`
  and `scripts/ui-audit.test.ts`.
- A user-visible change works on desktop and on the phone.
- Run it on staging with a real end-to-end run.
- Native and signing pieces that cannot run here are listed as not built.

## 5. Open the PR

The PR body maps every upstream sha to its fork commit, as ported, adapted
(with what changed) or skipped (with why). Skipped shas are also added to the
table below in the same PR.

## Skipped

Upstream commits deliberately not ported. `scripts/upstream-pending.ts`
reads the first column.

| Upstream sha                             | Subject                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19a1fdebf5b12a5ac1cef13a14969f19d5b50d9a | Pi: pass thinking level and summarized thinking to the Claude Agent SDK | The fork has no Claude Agent SDK provider: Claude turns run on pi's own Anthropic provider, which already maps the thinking level to `effort` (with the model's `thinkingLevelMap`) and requests adaptive thinking with `display: "summarized"`.                                                                                                                                                                                                                                                                                   |
| a1dcacdb313f3165f718095584177be72bd073bb | Release the SDK conversation when a one-shot settles                    | The fork has no Claude Agent SDK provider, so there is no live SDK conversation or `claude` process to release. Claude turns run on pi's own Anthropic provider, which keeps no per-run connection after a turn ends.                                                                                                                                                                                                                                                                                                              |
| 04af210ea736cbeca9bec6303a11d1eb34edcac9 | Archive a PR's own sessions when it closes                              | Already in the fork from #11 (`agents/github/pr-session-archive.ts`): close archives a PR's sessions as `auto`, reopen, push or a new run restores them, per-PR ordering, and a backfill. Upstream's differences contradict #11's decisions: its backfill runs on its own in the reconcile sweep, while the fork's is an operator-run endpoint that is a dry run unless asked to apply; and it archives `-followup` sessions, which #11 leaves alone because their PR is always closed while they are in use.                      |
| 77424a04bac96cc63ddcd5fc0de59bdb36625601 | Stop a session's containers on archive and delete                       | Already in the fork from #16 and its follow-ups (`session-ownership.ts`, `session-resources.ts`, `docs/session-resources.md`): podman and docker shims label `run` and `create`, archive and delete stop labelled containers and systemd units, and the reaper stops those of archived or missing sessions, with instance labels and grace checks upstream lacks. A Podman Sandbox's pod is stopped by archive sleep and destroyed on delete. Porting upstream's `session-containers.ts` would add a second, conflicting labeller. |
| d0c926e7bb99d26e5f252d124ad75a272bc61e0f | Serve a run's opensession-* MCP servers over one in-process relay       | Already in the fork from #17 (`runner-host/mcp-mounts.ts`, `run-rpc-client.ts`, `run-rpc-mcp-server.ts`): every opensession-* server is mounted in the run host on one shared run-rpc client, with a per-server rollback switch (`OPENSESSION_MCP_PROXY_MODE=per-server`, recorded in each run-host spec), no re-sent tool calls after a dropped connection, and tests that cover upstream's. Upstream's `run-rpc-relay.ts` would be a second relay beside it.                                                                     |
