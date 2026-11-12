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
  writes the morning brief. The Desk stays the OS app's quick-question session.
- **A lead** owns one project. It is a goal (`goal-runner.ts`) bound to a
  project, with a charter: scope, the loops it owns, its loop guards and its
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
- **Capacity, not dollars:** the instance runs on Claude subscription
  accounts with 5-hour and weekly usage windows, so a dollar budget is the
  wrong unit and risks stopping useful work. Instead:
  - **Headroom first:** lead wakes and other unattended goals on
    `pi/anthropic/*` wait 30 minutes (postponed, not paused; the goal shows
    why) while none of the shared Claude accounts that report usage has at
    least 20% of its 5-hour window and 10% of its weekly window left. When
    none reports any usage they run. A run refused for a usage limit or a
    429 holds that provider's goals for 30 minutes. Waiting goals start one
    a tick once there is room, and a lead that has waited a day tells its
    owner once. Headroom comes from a source per route
    (`claude-headroom.ts`, `localClaudeAccounts` today), so a later hub in
    front of the Claude accounts can report it from its own API.
    Interactive sessions and Pat never wait on it.
  - **Loop guard:** each wake may use a token limit (1,000,000 by default;
    input, output and cache writes in full, cache reads at a tenth), and a
    lead may wake 24 times a day by default, counted on the owner's local
    day. A wake past its token limit is asked to wrap up and stopped, the way
    the old mid-run budget hold worked, and holds the lead for 12 hours;
    the wake limit holds it until the owner's next day. Either asks the
    owner with a needs-you item, Resume or Keep paused, once per hold: a
    trip after a Resume asks again. Resume lifts the hold for the rest of
    the day, until the next trip.
  - **Dollar cap:** optional and off by default; `null` is off and 0 is
    refused. Leads stored before the guards at the old default of $50 read
    as off, and those held at $0 read as turned off; a cap the owner set
    stays. Raising or removing it is loosening.
- **Audit:** every decision is audited with the rule that made it.

### 4. A classifier routes; it can't grant

Each incoming event (ticket, incident, CI failure, lead proposal) can be
labelled by a small classifier (TypeSafe Jev): who decides, risk, urgency.
That steers what the supervisor raises and how loudly. It can move a decision
towards the owner, never away from them; the rules above are the ceiling. Jev
is optional and off by default; without a key, the rules alone decide.

### 5. The owner hears from one place

- **Pushes:** leads report to the supervisor. A decision waits for the
  morning brief; it pushes through `notifyUser` at once only when it can't
  wait (see "The morning brief" below), with two lines and the options,
  deep-linking into Blob.
- **Morning brief:** once a day, at a time the owner sets, the supervisor
  writes one brief of what ran alone, what it handled and what needs them.
  It replaced the counts-only daily digest push.
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

## betterbahn today

Read from the live instance on 2026-11-10:

- **Support** is the email inbox, at `draft` autonomy with a 10-minute veto
  and the default "never without a person" topics (refund, legal, security,
  data export and deletion, account deletion). Every message so far was spam,
  so the reply path hasn't met a real customer yet. Its knowledge jobs
  (mailbox, known problems) have run.
- **Incidents** are at `deploy-after-veto` with a 10-minute veto. Five signals:
  the status page, Deutsche Bahn (an outside provider), the site being up, and
  two certificates. 16 of the last 20 incidents closed without action, mostly
  status-page and provider flaps.
- **No production Runners, actions or releases** are set up, so the fix loop
  ends at a merged PR. It can't roll back or deploy.
- **No goals** exist yet.

What that means for the rollout:

- Step 1 has a real first job: tell flaps from outages, and propose signal rule
  changes rather than paging.
- Testing support needs test emails sent to the inbox, since real traffic is
  rare.
- Raising the inbox to `routine` stays the owner's call (`inboxes.ts` only lets
  the owner raise it), after step 1 shows the drafts are right.

## Before building

- **Sync I/O in goals:** `goals.ts` reads its files with synchronous `fs`, and
  the goal ticker runs in-process. That breaks the server rule against
  synchronous I/O on the gateway, and leads would lean on it harder. Move goals
  onto the catalog (as automations are) first.
- **The supervisor's voice:** voice secret minting is wired to the Desk
  (`mintVoiceSecret`). Generalize it to "the user's standing session" rather
  than copy it.

## Built (November 2026)

What landed from this proposal, and the decisions made on the way:

- **Goals on the catalog** (#146): the sync I/O prerequisite.
- **Supervisor session** (#147): its own standing session, separate from the Desk; Blob
  talks to it, voice included, and the Blob surface hint follows it.
- **Supervisor inbox** (#148): needs-you and fyi items, fixed push copy, per-person quiet
  hours (02:00 to 08:00 by default) with "down" breaking through, a daily digest at 09:00.
- **Project lead** (#149): settings block with the rules, watch stage, flap triage,
  overview, proposals to the inbox, budget held mid-run, fail-closed wake checks.
  The monthly dollar budget was later replaced by headroom waits and a loop guard
  (rule "Capacity, not dollars" above).
  Turned on per project in settings (#153).
- **How Blob reports** (#152): the first paragraph is what Blob says, the rest is shown;
  BLUF, SBAR or plain per person; Blob hands GitHub work to Pat, the public persona, and
  never posts as itself. The owner reversed the last part on 2026-11-11 (see "Blob speaks
  on GitHub as itself" below).
- **Native push** (#151): Bark as a second transport, AES-GCM optional, opening
  `blob://item/<id>`. The paid Apple team is unavailable, so Blob has no APNs of its own.
- **Long-lived supervisor** (#154): a ledger, weekly rotation reseeded from it, daily
  memory refresh, more recent context kept per compaction.
- **Watch:** the supervisor's conversation only talks with its owner. A per-person watch goal
  (`supervisor-watch.ts`) wakes on leads' new items, incidents, workers' reports and its own
  schedule (every 30 minutes from 08:00 to 22:00 by default), skips the model when nothing
  changed, and reports only through the inbox and the shared ledger. The conversation keeps no
  timers and hands follow-ups over with `watch_for` (`docs/research/always-on-agents.md`).
- **Recall** (this change): a rotation's seed also carries the last 20 owner/Blob
  exchanges, one line each; a memory writer on Haiku 5.5 turns the owner's own words
  into personal memory five quiet minutes after a turn (supervisor pref `memoryWriter`,
  on by default), and the supervisor reads only personal and team memory.
- **Voice** (#150, #155): Fish Audio read-aloud on the server; the OpenAI live call is
  opt-in in Blob because it is billed per minute.
- **Morning brief** (this change): the daily digest push is replaced by a brief the
  supervisor writes; see the next section.

### The morning brief

Showing every open needs-you item as a card, oldest first, buried what mattered under stale
and duplicate cards. Once a day the supervisor goes through the inbox instead and writes one
brief (`supervisor-brief.ts`).

- **The turn.** At the owner's digest time (09:00 local by default, never in quiet hours) the
  inbox sweep starts a brief turn in the owner's supervisor session. It is a server notice
  with no owner message, delivered the way a merge card's outcome is (`conversationNotice`),
  so the conversation keeps it instead of the watch. The charter's "The morning brief" says
  what to do: check each open item with tools, close stale and done ones with a reason and
  duplicates with "same as <kept id>" (`close_items`), act where the rules allow, pick at
  most three decisions with a recommendation, then `write_brief`. Closing answers nothing, so
  it never approves a lead's steps.
- **When it runs.** One automatic turn per owner per day: at the digest time, or earlier when
  the owner opens Blob after quiet hours and there is no brief for today
  (`GET /api/supervisor/brief` answers `preparing` and the turn finishes on its own). A fresh
  brief on request (`POST /api/supervisor/brief/refresh`) at most every 30 minutes. A turn
  that writes nothing in 20 minutes is over.
- **The record** lives in the owner's inbox document in the catalog (`brief`): `day`,
  `asOf`, `say` (spoken, at most 600 characters), `handled` (at most 10 one-line entries,
  each with an optional item id), `decisions` (at most 3, each one open needs-you item of the
  owner's and an optional recommended option), `later` (count and ids of the other open
  needs-you items) and `seenAt`. `write_brief` checks it against the inbox in the same
  compare-and-set it is stored with. A decision names one real item, and the owner answers it
  through the item API with that item's revision, so an approval stays bound to what they
  saw. Writing it counts the open fyi items as told, as the digest did.
- **Reading it.** `GET /api/supervisor/brief` returns today's brief or the latest, its
  decisions expanded to the item payloads the items route returns (`revision`, `act`), with
  `state` `ready`, `preparing` or `none`. `POST /api/supervisor/brief/seen` marks it seen.
  Both are the owner's only, with the items' auth. A written brief sends the socket frame
  `supervisor_brief_ready`.
- **The push.** A scheduled brief pushes "Your morning brief is ready" once, after quiet
  hours and only if the owner hasn't seen it yet: Blob's icon, opening Blob, and only the
  count of decisions as the Bark subtitle. When the scheduled turn couldn't run or wrote
  nothing and decisions wait, one "Decisions are waiting" push goes out instead.
- **Interrupts.** A new needs-you item pushes at once only when its urgency is `down`
  (something fully down, through quiet hours) or `now` (held in quiet hours): it expires
  before the next brief or something time-sensitive waits on it, such as an incident that
  needs the owner or a lead's approval whose steps expire within a day (`proposalUrgency`).
  Everything else waits for the next brief: no push, still open in the inbox.

### The act stage (#173 to #184)

A lead can now run what the owner approved, or what its rules let it run alone, and nothing
else. The code is in `packages/core/opensession-server/src/server/leads/`; the security side
is in `docs/security-model.md` ("Project leads").

- **Proposals with steps** (`report.ts`, `approvals.ts`): `propose` may carry typed steps, a
  condition and an expiry. The server checks that each step fits the category
  (`STEP_CATEGORIES`) and names this project's repositories, signals or support drafts
  (`checkLeadAct`). It records the proposal in the `lead-approvals` catalog namespace (one
  document per project, every change one compare-and-set), bound to the inbox item and the
  item's revision (its `updatedAt`). The body ends with server-written lines the lead can't
  word. A new proposal on the same item voids the earlier one as superseded.
- **Approvals bind to what the owner saw** (`goal.ts` `approveFromAnswer`, `approvals.ts`
  `approve`). Only the owner's first option approves, answered in the lead owner's own inbox,
  signed in as the lead owner's GitHub login on the team roster (`verifiedPerson`, so never a
  claimed name or an automation), naming the item revision the client showed. A different
  revision is refused as stale. An answer without a login or a revision approves nothing and
  only lands in the ledger. Any other option voids the proposal. An approval expires after 7
  days by default, at most 30; an unapproved proposal is voided after 30 days. States go
  waiting, ready, applying, then applied, failed or partial; waiting or ready can go to void.
  An apply still running after 30 minutes was interrupted: it is marked partial and never
  runs again.
- **Conditions** (`conditions.ts`): a pull request merged, checks green on a pull request at
  a pinned head, or an incident resolved. Each check reads the live state (GitHub as the App,
  the incident store). A read that fails is unknown, never met, so an approval becomes ready
  only on a positive answer.
- **Gate order in `lead_apply`** (`apply.ts`). The lead passes only the proposal id; the
  steps are the recorded ones. Every call checks, in order:
  1. The lead is off or the kill switch is on: refused.
  2. The category is only the owner's (pinned or set so): refused, and whatever still stands
     for the proposal is voided.
  3. The watch stage: refused.
  4. The proposal was voided, or it has a `spawn-worker` step: refused.
  5. The rules say act: at the act stage the proposal runs without an approval; at coordinate
     only a fix or CI repair (`COORDINATE_CATEGORIES`) whose steps are all `autofix-pr`.
  6. Otherwise an approval of exactly this proposal: ready (or waiting with its condition met
     now), not expired, at the coordinate or act stage.

  A condition is re-checked at apply time, whoever allowed the run. The settings and the
  record are read again and checks 1 to 6 re-run right before one compare-and-set claims the
  record. Before each step the settings are read again and a run they no longer allow stops.
  Each step's intent is audited before it runs, a step already done counts as done, and the
  first failure stops the run. Nothing re-runs; the lead proposes again instead.

- **`APPROVED_RUNS_ONLY_AT_ACT`** (`apply.ts`) is `false`, by the owner's decision of
  2026-11-11: his approval is the gate, so an approved asks-first action also runs at
  coordinate. Approvals are checked on each wake, and a merged pull request or a resolved
  incident wakes the lead, at coordinate and act. Watch still runs nothing, and an answer
  there approves nothing. What runs alone at coordinate is unchanged: only `autofix-pr`.
- **Steps available,** each through the mechanism that already does the job:
  - `merge-pr` (fixes, public releases, CI repair): `mergePinnedPr` as the GitHub App,
    pinned to the approved head (`incidents/response/merge.ts`).
  - `signal-patch` (signal rule changes): `updateSignal`, written only while the stored
    fields equal the proposal's `before`.
  - `autofix-pr` (CI repair): `fireAutoFix`, only while the pull request is open, from this
    repository and at the approved head.
  - `support-send` (routine support replies): `sendDraft`, only while the draft is the one
    proposed, it goes to the recipient the server pinned when the lead proposed it, and no
    person has stopped it or acted on the conversation since.
- **`spawn-worker` is refused,** at `propose` and at `lead_apply`, until a restricted spawn
  path exists. `spawn_task` would start a fully trusted session for the owner. The restricted
  path the incident fix loop uses hangs off an automation's coordinator session, and a lead
  has none yet.
- **Event wakes** (`goal.ts`, `goals.ts`): each wake first expires old approvals, settles
  interrupted applies, checks up to 5 waiting conditions (least recently checked first, 10
  seconds each), moves the met ones to ready and tells the owner once, "Ready to apply". A
  merged pull request (the GitHub webhook) or a resolved incident that a waiting approval
  names wakes the lead now (`wakeLeadFor`). A goal that is running or already due keeps that
  wake as `pendingWakeAt`, so the next wake its run schedules doesn't drop it
  (`takePendingWake`).
- **Blob shows the steps natively** (#182): `GET /api/supervisor/items` returns each item's
  `revision` and, for a lead item with a recorded proposal, a structured `act` read from the
  record, never from the Markdown body (`item-acts.ts`). Blob draws it as its own Steps
  section between the body and the options (`BlobDecisionView.swift` `BlobActSection`): the
  numbered steps, when they run and when they expire. It drops the body's text copy of those
  lines only when the body ends with exactly `act.bodySuffix`.
- **Stale answers are refused** (`routes/supervisor.ts`, `supervisor-inbox.ts`): an answer
  naming a revision the item no longer has gets a 409 `changed` and closes nothing. Blob says
  "This changed. Have another look." and shows the new card.

Not built yet: the `spawn-worker` step (it waits for a restricted spawn path), the steps
section outside Blob, the classifier (Haiku 5.5 rather than a separate vendor), more leads,
and Duo posture APIs.

## Blob speaks on GitHub as itself

Decided by the owner on 2026-11-11. Not built yet. It reverses the rule above that Blob
never posts as itself.

- **Blob has its own GitHub account.** It is a machine user in the organization, not a
  GitHub App. People can mention it and assign it like a teammate.
- **Blob may post on issues and pull requests.** It may comment, leave a review with
  comments, add existing labels and open an issue. It never approves a pull request.
- **Only server-side tools hold its token.** The supervisor and the leads call gateway
  tools, and the gateway posts as Blob. The token is never in a shell, `GH_CONFIG_DIR` or
  an agent's environment.
- **Guards fail closed.** Posting is off until the owner turns it on. The repository must
  be registered and allowed for Blob. A public repository must be listed by name. Writes
  are capped per owner and per thread, and each one is audited.
- **Nothing pushes or merges as Blob.** Its token can't write code. Merging stays with the
  owner and the existing loops' rules.
- **Pat stays the code worker persona.** Code sessions, commits and pull requests keep
  their current identities. Blob speaks for the supervisor and the leads, and hands code
  work to Pat as before.

See `docs/github-authority.md` ("Current policy") for the credential.
