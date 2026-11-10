# Supervisor and project leads

Status: proposed. Written 2026-11-10. First lead: betterbahn.

## What's missing

Sessions answers when asked. The goal is a system that runs the projects when
nobody is asking: bugs get fixed, support gets answered, production gets
watched, and the owner hears only about what needs them. When the owner is
away or unwell, the work keeps going inside rules the owner set, and it stops
at the decisions only the owner can make.

The Blob app (`packages/clients/ios/Blob`, `adrs/blob-views.md`) is the face of
this. Today it talks to the Desk, the standing per-user session behind the OS
app's quick questions. It should talk to the supervisor instead.

## What already exists

Most of the work loops are already here, per project, each with its own
autonomy rules. They don't yet have one owner that sees all of them.

| Loop          | Where                            | Runs alone today                                                                                                                                                    | Asks a person                                                                                                                                                |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Incidents     | `server/incidents/`, `response/` | Investigator and verifier on different models; fix proven against production's own signal; merge as the GitHub App; deploy after a veto window when autonomy allows | `evaluatePolicy`: kill switch, autonomy level, "never without you" facts (costs money, needs a secret, migration, outside scope, not reversible), night rule |
| Email support | `server/support/`                | Triage, cited and verified drafts, auto-send at `routine` autonomy within hourly caps                                                                               | `decideReply`: uncited, promises, sensitive topics, flags, `watch` or `draft` inboxes; bug reports only become a prepared issue for a person (`bugs.ts`)     |
| Plain support | `agents/plain/`                  | Triage and an internal note with a suggested reply                                                                                                                  | Every customer send and every refund                                                                                                                         |
| GitHub        | `agents/github/`                 | PR review, CI repair, conflict fixes, `os-auto-fix` loops                                                                                                           | Merging outside the incident gate                                                                                                                            |
| Goals         | `goals.ts`, `goal-runner.ts`     | One session resumed on its own schedule, with a ledger                                                                                                              | `ask_human`, `mark_paused`                                                                                                                                   |

Shared pieces to build on:

- **Policy:** `run-policy.ts` `runToolPolicy` strips tools per run kind;
  `pi-tools.ts` `rewriteArgs` sees every MCP call; `command-policy.ts` gates
  bash.
- **Asking a person:** `human-asks.ts`, with `registerAskDomainHandler`.
- **Notifying:** `notifyUser` is the only path (one row per subject, web push,
  per-user alert switches).
- **Audit:** `audit.ts`, with `audited()`.
- **Per-project settings:** `server/projects/store.ts`, with roles and the
  incident policy shape (`ProjectIncidentPolicy`).
- **The per-user standing session and per-turn briefing pattern:** `desk.ts`,
  `desk-state.ts`.

## Decision

### 1. One supervisor per person, one lead per project

- **The supervisor** is a standing per-user session, created like the Desk
  (`ensureDeskSession`'s store pattern), with its own flag and charter note.
  Blob connects to it. It does no project work itself. It keeps the briefing
  across leads, answers the owner, holds the decisions that are waiting, and
  writes the daily digest. The Desk stays the OS app's quick-question session.
- **A lead** owns one project. It is a goal (`goal-runner.ts`) bound to a
  project, with a charter: scope, the loops it owns, its spend ceiling and its
  autonomy. The charter lives in the project's settings document as a new
  `lead` block next to `incidents`.

### 2. A lead coordinates the existing loops before it adds new ones

The lead doesn't replace the incident, support or GitHub loops; those keep
their own rules. It owns the gaps between them:

- **One view of the project:** open incidents, support conversations waiting
  for a person, red CI, stale PRs, and spend.
- **Joining the dots:** a support report about a bug becomes a tracked fix (a
  worker session) instead of a prepared issue for a person. An incident's fix
  is checked against the support conversations it caused.
- **Deciding what reaches the owner,** within the rules below, and reporting it
  to the supervisor rather than paging the owner directly.

Delegating needs one change: goals can't spawn sessions today
(`goalMcpServers()` leaves out `opensession-sessions`). A lead gets
`spawn_task` and `send_to_session`, with the spawn depth cap unchanged.

### 3. Rules are server-side and only ever tighten

One autonomy level per action category, per project:

- **Alone:** the lead acts.
- **Asks first:** the action waits for the owner.
- **Only you:** the lead may prepare it, never do it.

Rules:

- **Defaults,** from how the owner works today:
  - Alone: fixes verified by a second agent, CI repair, routine support replies
    within `decideReply`.
  - Asks first: major dependency upgrades, banning users, rotating keys,
    public releases.
  - Only you: refunds, pricing, disputes, tax and legal, contracts, writes to
    production data.
- **Enforced where tools are already enforced,** never in the prompt. An "only
  you" action's tools are stripped from the lead's runs (`runToolPolicy`). An
  "asks first" action is a `human-asks` request whose domain handler grants
  that one call. The existing loops keep their own policies; the lead's level
  can only lower theirs, never raise them.
- **The kill switch:** `agentsPaused` stops every lead on the project.
- **Spend:** every lead has a monthly ceiling, checked the way
  `IncidentBudget` is.
- **Audit:** every decision is audited with the rule that made it.

### 4. A classifier routes; it can't grant

Each incoming event (ticket, incident, CI failure, lead proposal) can be
labelled by a small classifier (TypeSafe Jev): who decides, risk, urgency.
That steers what the supervisor raises and how loudly. It can move a decision
towards the owner, never away from them; the rules above are the ceiling. Jev
is optional and off by default; without a key, the rules alone decide.

### 5. The owner hears from one place

- **Pushes:** leads report to the supervisor. The supervisor pushes through
  `notifyUser` only for something the owner must decide, with two lines and
  the options, deep-linking into Blob.
- **Digest:** one digest a day, at a time the owner sets, of what ran alone.
- **Quiet hours** apply to every kind, not just incidents: the incident night
  rule and `sweepHeldIncidents`, extended. Something fully down still gets
  through.
- **Blob:** shows all of it as blocks (`adrs/blob-views.md`). The per-turn
  surface hint (#144) follows the supervisor session, not the Desk.

### 6. Rollout

Each step runs at least a week on betterbahn before the next.

1. **Watch.** The betterbahn lead reads incidents, support and CI, writes the
   daily digest and proposes. It changes nothing, and every proposal goes to
   the owner.
2. **Coordinate.** It may spawn fix workers for support-reported bugs and
   leave PRs. Merging and deploying stay with the existing loops' rules.
3. **Act within the rules.** Alone categories run without the owner. Asks
   first and only you behave as above.

## Not in this proposal

- Leads for other projects, and leads that talk to each other.
- New signal sources (PostHog, Sentry); they go through the existing `http`
  and `webhook` signal kinds for now.
- An autonomous send path for Plain. betterbahn's support channel decides
  whether it's needed.

## Before building

- **Sync I/O in goals:** `goals.ts` reads its files with synchronous `fs`, and
  the goal ticker runs in-process. That breaks the server rule against
  synchronous I/O on the gateway, and leads would lean on it harder. Move goals
  onto the catalog (as automations are) first, or as part of step 1.
- **Owner confirmation needed:** which support channel betterbahn uses (email
  inbox or Plain), and its current incident and inbox autonomy settings.
- **The supervisor's voice:** voice secret minting is wired to the Desk
  (`mintVoiceSecret`). Generalize it to "the user's standing session" rather
  than copy it.
