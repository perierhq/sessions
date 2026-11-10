# Always-on personal agents: how others split talking from background work

Research for Blob, 10 November 2026. The question: how do open-source always-on
agents and companion apps keep background work (checks, wakes, worker reports)
from colliding with the owner's live conversation, and what should Blob copy?

Method: GitHub stats via `gh api repos/...` on 10 November 2026; behaviour from
each project's own docs or source (fetched this session). Claims marked
**(unverified)** come from third-party pages or could not be confirmed in the
project's own docs or code.

## Where Blob is today (from this repo)

- `server/supervisor.ts`: one standing ask-mode session per person. It thinks
  only when the owner talks or when a prompt it scheduled
  (`schedule-mcp.ts`, `scheduled-prompts.ts`) fires into the same session.
- `server/supervisor-inbox.ts`: needs-you and fyi items, one catalog document
  per person, 60 s sweep, quiet hours (`supervisor-quiet-hours.ts`) with `down`
  breaking through, daily digest, Bark push.
- `server/goals.ts` and `goal-runner.ts`: a goal is one resumed session woken
  by a 60 s ticker at `nextWakeAt`, with `minWakeMinutes`, `maxWakes`, monthly
  `spend` and a fact ledger. Project leads (`leads/goal.ts`) are goals with a
  fail-closed `leadWakeCheck`, a budget, and `handleLeadAnswer`, which writes
  the owner's answer to the lead's ledger and pulls `nextWakeAt` to now.
- `server/supervisor-ledger.ts` and `supervisor-memory.ts`: a per-person ledger
  that outlives weekly session rotation and seeds the next session.
- `server/pi-steer-controller.ts`: mid-turn steers queued and delivered at
  the tool boundary.

So the lead already runs as a separate background loop. The collision is in
the supervisor itself: its own checks and self-scheduled wakes land as turns
in the conversation session.

## Projects at a glance

| Project                | Repo                                                                                          |   Stars | Last push  | Licence                                | Kind                                      |
| ---------------------- | --------------------------------------------------------------------------------------------- | ------: | ---------- | -------------------------------------- | ----------------------------------------- |
| OpenClaw               | [openclaw/openclaw](https://github.com/openclaw/openclaw)                                     | 394,300 | 2026-11-10 | MIT                                    | Always-on personal agent gateway          |
| Hermes Agent           | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)                     | 262,353 | 2026-11-10 | MIT                                    | Always-on personal agent                  |
| NanoClaw               | [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw)                                     |  31,100 | 2026-11-10 | MIT                                    | Containerised OpenClaw alternative        |
| Letta (MemGPT)         | [letta-ai/letta](https://github.com/letta-ai/letta)                                           |  25,408 | 2026-10-18 | Apache-2.0                             | Stateful agents, sleep-time agents        |
| Claude Subconscious    | [letta-ai/claude-subconscious](https://github.com/letta-ai/claude-subconscious)               |   2,910 | 2026-09-25 | MIT                                    | Demo: background agent beside Claude Code |
| LangChain Agent Inbox  | [langchain-ai/agent-inbox](https://github.com/langchain-ai/agent-inbox)                       |   1,097 | 2026-09-18 | MIT                                    | Inbox UI for ambient agents (archived)    |
| Executive AI Assistant | [langchain-ai/executive-ai-assistant](https://github.com/langchain-ai/executive-ai-assistant) |   2,206 | 2026-07-27 | MIT                                    | Ambient email agent (archived)            |
| Agents from scratch    | [langchain-ai/agents-from-scratch](https://github.com/langchain-ai/agents-from-scratch)       |   2,443 | 2026-08-11 | MIT                                    | Ambient agent course                      |
| Khoj                   | [khoj-ai/khoj](https://github.com/khoj-ai/khoj)                                               |  38,099 | 2026-08-02 | AGPL-3.0                               | Second brain with scheduled automations   |
| Leon                   | [leon-ai/leon](https://github.com/leon-ai/leon)                                               |  17,655 | 2026-11-10 | MIT                                    | Personal assistant, 2.0 on `develop`      |
| elizaOS                | [elizaOS/eliza](https://github.com/elizaOS/eliza)                                             |  19,830 | 2026-11-10 | MIT                                    | Agent runtime with task workers           |
| Open Interpreter 01    | [openinterpreter/01](https://github.com/openinterpreter/01)                                   |   5,166 | 2024-11-01 | AGPL-3.0                               | Voice device, inactive                    |
| AutoGPT Platform       | [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT)               | 187,981 | 2026-11-10 | Polyform Shield (platform), MIT (rest) | Workflow agents with triggers             |
| n8n                    | [n8n-io/n8n](https://github.com/n8n-io/n8n)                                                   | 210,003 | 2026-11-10 | Sustainable Use (fair-code)            | Workflow automation with AI agent node    |
| Activepieces           | [activepieces/activepieces](https://github.com/activepieces/activepieces)                     |  25,465 | 2026-11-10 | MIT (EE dirs excluded)                 | Workflow automation with agents           |
| Pipecat                | [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat)                                   |  17,173 | 2026-11-10 | BSD-2-Clause                           | Voice agent framework                     |
| LiveKit Agents         | [livekit/agents](https://github.com/livekit/agents)                                           |  15,162 | 2026-11-10 | Apache-2.0                             | Voice agent framework                     |
| AIRI                   | [moeru-ai/airi](https://github.com/moeru-ai/airi)                                             |  51,258 | 2026-11-10 | MIT                                    | "Self hosted, you-owned Grok Companion"   |
| Open-LLM-VTuber        | [Open-LLM-VTuber/Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)         |  14,667 | 2026-05-15 | MIT (GitHub shows NOASSERTION)         | Voice + Live2D companion                  |
| Utsuwa                 | [JuiceBoxxGames/utsuwa](https://github.com/JuiceBoxxGames/utsuwa)                             |     144 | 2026-11-07 | AGPL-3.0 (MIT up to 0.12.0)            | Grok Companion alternative, VRM           |
| SillyTavern            | [SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern)                         |  35,494 | 2026-10-02 | AGPL-3.0                               | Character chat frontend                   |
| a16z companion-app     | [a16z-infra/companion-app](https://github.com/a16z-infra/companion-app)                       |   5,983 | 2024-04-23 | MIT                                    | Companion starter, inactive               |

## How each one separates foreground from background

### OpenClaw (the most complete design)

- **Background runs are automation jobs** with an explicit session target
  ([payloads](https://docs.openclaw.ai/automation/cron-jobs/payloads)):
  `main` (a turn in the owner's conversation, for reminders and system
  events), `isolated` (fresh `cron:<jobId>` session per run, for reports and
  chores), `current` (child run of the creating chat), `session:<id>`
  (persistent named session that builds on its history).
- **The heartbeat was retired.** It used to run every 30 min in the main
  session, read `HEARTBEAT.md`, and drop a reply of `HEARTBEAT_OK`. It is now
  an ordinary job ("Proactive check") with per-job scratch instead of the file
  ([heartbeat migration](https://docs.openclaw.ai/gateway/heartbeat)). Silence
  is `NO_REPLY` or `record_result: no_change`.
- **Foreground wins:** `idleOnly: true` "waits for agent-wide quiet, including
  other cron jobs and foreground sessions, without occupying a running slot";
  `activeHours` is a timezone-aware window, recurring jobs outside it skip the
  occurrence ([schedules](https://docs.openclaw.ai/automation/cron-jobs/schedules)).
- **Event triggers without model cost:** condition watchers (`--trigger-script`)
  run a read-only script every N seconds (min 30 s) that returns
  `{fire, message, state}`; `fire: false` records nothing and calls no model.
  `stream` schedules fire on matched lines from a long-lived command; `on-exit`
  fires when a watched command exits.
- **Owner speaks during a run:** queue modes `steer` (default), `followup`,
  `collect`, `interrupt`, 500 ms debounce, cap 20, `drop: "summarize"`
  ([queue](https://docs.openclaw.ai/concepts/queue)). Steers land at tool
  boundaries; unstarted sequential calls are skipped with a synthetic result
  ([steering](https://docs.openclaw.ai/concepts/queue-steering)). The owner can
  steer an automation turn, keeping the owner's provenance while the turn
  keeps its own permissions; owner guidance does not answer a pending
  question under the automation's authority.
- **Cost:** per-job `--model`, `--tools`, `--thinking`; docs recommend a
  lighter model for routine checks; `skipIfScratchEmpty`; auto-disable after
  repeated failures. No spend cap on the automations pages.
- **Delivery:** `announce` / `webhook` / `none`; `delivery.target: "owner"`
  goes to the owner's DM.

### Hermes Agent

- **Cron jobs run in a fresh session each time**, never in the chat
  ([cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)).
  Opt-in continuity: `continuity=true` feeds the job's previous output,
  `context_from` other jobs' output, and `attach_to_session` writes the
  delivered brief into the chat as a labelled turn
  `[Cron delivery: <name>]` so the owner can reply to it.
- **Silence:** `[SILENT]` suppresses delivery; a pre-run script can return
  `{"wakeAgent": false}` to skip the model for that tick.
- **Owner speaks while busy:** `display.busy_input_mode` is `interrupt`
  (default, restart generation at the next tool-result boundary), `queue` or
  `steer` ([messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)).
  `/bg <prompt>` runs an isolated background session and posts the result back.
- **Memory:** `MEMORY.md` (2,200 chars) and `USER.md` (1,375 chars) as a
  frozen per-session snapshot to keep the prompt cache, FTS over all sessions,
  and a post-turn background review fork that may update memory, optionally on
  a cheaper model and with `write_approval`
  ([memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).
- **Cost:** `cron.model` separate from the chat model, `max_parallel_jobs`,
  `blocked_config` pre-flight that makes no LLM call, failure alerts deduped
  (`failure_repeat_alert_hours`, default 6).

### NanoClaw

- Scheduled tasks "run in its own system session, separate from normal chat
  sessions", with no chat attached; the prompt must name the destination
  ([scheduled-tasks.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/scheduled-tasks.md)).
- Script gates: a Bash script (30 s, 1 MB) whose last line
  `{"wakeAgent": false}` ends the run without a model call, or
  `{"wakeAgent": true, "data": ...}` wakes it with small data.
- Each run appends a work-log entry. Host does a 60 s sweep (same as ours).

### Letta sleep-time agents and "dreaming"

- Original design ([blog](https://letta.com/blog/sleep-time-compute), Letta
  0.7.0): creating a sleep-time agent makes two agents. The **primary** talks
  and has no core-memory edit tools; the **sleep-time agent** owns memory edits
  and rewrites the primary's memory blocks in the background. Different models
  (fast primary, bigger sleep-time). Frequency is `sleeptime_agent_frequency`
  (every N turns; field confirmed in Letta's group schema via a vendored copy,
  default not documented).
- Paper ([arXiv 2504.13171](https://arxiv.org/abs/2504.13171)): about 5x less
  test-time compute for the same accuracy, up to 13% / 18% better accuracy,
  2.5x lower cost per query when amortised across related queries. Benchmarks
  are math tasks, not assistants.
- Current docs replace this with "dreaming": background subagents review
  recent conversations and commit to a git-backed MemFS, triggered after N
  steps or on compaction ([memory](https://docs.letta.com/configuration/memory/)).
- Claude Subconscious (demo) puts a Letta agent beside Claude Code: transcript
  in after each response (async), "whispers" back before the next prompt,
  never blocks the foreground.

### LangGraph ambient agents and Agent Inbox

- Definition ([blog](https://blog.langchain.com/introducing-ambient-agents/)):
  agents that "listen to an event stream and act on it", run on cron, and talk
  to the human in three ways: **notify**, **question**, **review**.
- Agent Inbox schema ([repo](https://github.com/langchain-ai/agent-inbox)):
  `HumanInterrupt {action_request, config {allow_ignore, allow_respond,
allow_edit, allow_accept}, description}` and
  `HumanResponse {type: accept | ignore | response | edit, args}`. Both the
  inbox repo and the email assistant were archived in 2026.
- Double texting ([docs](https://docs.langchain.com/langsmith/double-texting)):
  `enqueue` (default), `reject`, `interrupt`, `rollback`. Platform-only.
- EAIA triage: `triage_no` / `triage_notify` / `triage_email` before any draft.

### Leon 2.0 (develop branch)

- From [ARCHITECTURE.md](https://github.com/leon-ai/leon/blob/develop/core/context/ARCHITECTURE.md):
  a "pulse manager" generates autonomous matters from memory and context
  deltas, persists them to `PULSE.md`, "execute[s] at most one matter per
  tick, and suppress[es] repeated matters after owner declines". Pulse work
  uses the owning conversation's normal turn; "owner messages interrupt stale
  work to redirect or cancel the task". So Leon keeps one thread, like Blob
  today, and relies on interruption.

### elizaOS

- `TaskWorker` in [task.ts](https://github.com/elizaOS/eliza/blob/develop/packages/core/src/types/task.ts):
  a cheap `shouldRun` gate with no message or state before `execute`, and
  `execute` may return `nextInterval` / `nextWakeAt` to adapt its own cadence,
  with `baseInterval` restored after backoff. Same shape as our goals.

### Khoj, AutoGPT, n8n, Activepieces

- Khoj: scheduled automations email the result
  ([docs](https://docs.khoj.dev/features/automations)); no chat coupling
  documented.
- AutoGPT Platform: schedules with fixed inputs, webhook trigger blocks, a
  Human In The Loop block that parks the run in `REVIEW`, credits per block
  (from docs via search; per-block prices **unverified**).
- n8n: Chat Trigger vs Schedule Trigger; scheduled runs have no session id so
  memory keys are manual; tool-level human review since 2.6, routed to Slack,
  Telegram, email and others (from docs via search).
- Activepieces: agents are steps in flows; "Wait for Approval" pauses a run;
  credit pricing (blog sources disagree, **unverified**).
- Lesson for Blob: background work is a separate run with its own trigger, and
  approvals are a parked item, never a chat turn.

### Voice: Pipecat and LiveKit Agents

- Pipecat ([function calling](https://docs.pipecat.ai/guides/learn/function-calling)):
  tools cancel on barge-in by default; `cancel_on_interruption=False` makes a
  call async. If the result arrives after the conversation moved on it is
  injected as a developer message and triggers a new reply.
- LiveKit ([async tools](https://docs.livekit.io/agents/logic/tools/async/)):
  a tool that calls `ctx.update()` becomes non-blocking; later updates go into
  context and "the agent replies once it is idle"; `ctx.foreground()` holds
  other speech for an interactive step; user speech does not cancel a running
  tool by default.
- Lesson: background results join the conversation only when it is idle, as a
  labelled non-owner message.

### Companion apps (Grok Ani-style)

- **AIRI** ([core-agent README](https://github.com/moeru-ai/airi/blob/main/packages/core-agent/README.md)):
  every send carries a mode. `background` ("work beside the conversation...
  It never speaks"), `scene` (a reply to Discord etc., never speaks) and
  `notice` ("text that is not owner speech, for example a finished task";
  stored as `notice`, reply marked `proactive`). Game bots talk to the
  character over a "Spark" protocol: `spark:notify` with kind and urgency,
  `spark:command` with `interrupt: soft | force`, `spark:emit` progress
  ([server-shared README](https://github.com/moeru-ai/airi/blob/main/packages/server-shared/README.md)).
  Interrupted turns are kept locally with `interrupted: true`.
- **Open-LLM-VTuber**: an `ai-speak-signal` from the client runs
  `proactive_speak_prompt` and marks the turn `skip_memory` and
  `skip_history`, so unprompted chatter never pollutes memory
  ([conversation_handler.py](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/conversations/conversation_handler.py)).
  The trigger itself (idle timer in the frontend) is **unverified**.
- **Utsuwa**: avatar timers and reminders she sets for herself, shown in a
  bell dropdown; mood and relationship stats; notices absence. No background
  agent.
- SillyTavern and a16z companion-app: chat-only, no background loop.
- None of the companion apps has a real background worker or inbox. They are
  references for the voice and character layer only.

## Comparison

| Project           | Foreground vs background                                   | Owner speaks mid-work                                                    | Memory shared by                                                  | Notification                                    | Cost control                                                               |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| OpenClaw          | Jobs choose `main`, `isolated`, `current` or named session | steer / followup / collect / interrupt; owner may steer automation turns | Main session; job scratch                                         | announce to owner DM, webhook, none; `NO_REPLY` | Script gates, per-job model/tools, `idleOnly`, `activeHours`, auto-disable |
| Hermes            | Cron in fresh session; `/bg`                               | interrupt (default) / queue / steer                                      | Shared MEMORY.md, USER.md, FTS; optional brief mirrored into chat | Deliver to platform; `[SILENT]`; notify flag    | Separate cron model, `wakeAgent:false`, parallel cap                       |
| NanoClaw          | Task in its own system session                             | Inbound queue (**unverified** detail)                                    | Per-group CLAUDE.md                                               | Prompt names destination                        | Script gate                                                                |
| Letta             | Primary + sleep-time agent (now dreaming subagents)        | Primary never waits for background                                       | Shared memory blocks / MemFS                                      | None (memory only)                              | Frequency N, cheaper primary                                               |
| LangGraph ambient | Separate graph runs on cron/events                         | enqueue / reject / interrupt / rollback                                  | Store / threads                                                   | Agent Inbox: notify, question, review           | Not documented                                                             |
| Leon 2.0          | Pulse in the same conversation                             | Owner interrupts stale work                                              | Layered memory, `PULSE.md`                                        | In chat                                         | One matter per tick, suppress after decline                                |
| AIRI              | `background` / `scene` / `notice` send modes               | `interrupt` soft or force                                                | One character store                                               | `notice` marked proactive                       | Not documented                                                             |
| Pipecat / LiveKit | Async tools beside the voice turn                          | Barge-in; results wait for idle                                          | Chat context                                                      | Spoken when idle                                | Timeouts                                                                   |

## Recommendation for Blob

The split we proposed matches the dominant pattern: OpenClaw `isolated` jobs,
Hermes cron, NanoClaw system sessions, Letta's primary plus sleep-time agent
and LangGraph ambient runs all keep background thinking out of the thread the
owner talks in. Only Leon keeps one thread, and it needs interruption rules to
make that work.

### Adopt

| Pattern                                                        | Seen in                                                                        | Blob piece to build on                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watch as its own resumed session, woken by schedule and events | OpenClaw `session:<id>`, Letta sleep-time                                      | A goal per person (`goals.ts`, `goal-runner.ts`), modelled on the lead goal in `leads/goal.ts`: `nextWakeAt`, `minWakeMinutes`, `maxWakes`, monthly `spend`. An event (new needs-you item, worker done, incident, lead proposal) pulls `nextWakeAt` to now, exactly as `handleLeadAnswer` does today. |
| Cheap gate before the model                                    | OpenClaw trigger scripts, Hermes/NanoClaw `wakeAgent:false`, eliza `shouldRun` | A server-side check in the watch goal's wake check (like `leadWakeCheck`): skip the run when nothing changed since the last wake. No model call, no transcript row.                                                                                                                                   |
| Silence by default                                             | `NO_REPLY`, `[SILENT]`, `HEARTBEAT_OK`                                         | The watch never posts to the conversation. It only calls `post_item` (`supervisor-mcp.ts`) or does nothing.                                                                                                                                                                                           |
| Notify / question / review, one inbox                          | LangGraph Agent Inbox, n8n and AutoGPT approvals                               | Already the supervisor inbox: `fyi` = notify, `needs-you` = question. Add a review variant only when the act stage lands (accept, edit, respond, ignore maps onto answer and dismiss). Keep quiet hours, `down` breakthrough and the digest as they are.                                              |
| Background results join the chat only when idle, labelled      | LiveKit "replies once idle", Hermes `[Cron delivery: ...]`, AIRI `notice`      | Keep `supervisorInboxContext` as the only bridge: the conversation sees new items in its next turn's briefing, labelled untrusted. Do not schedule prompts into the conversation session from the watch.                                                                                              |
| Owner speech wins                                              | OpenClaw `idleOnly`, Hermes interrupt                                          | Watch runs in its own session, so no steer is needed. If a future background turn must touch the conversation session, deliver it through `pi-steer-controller` as a followup, never as owner speech, and skip it while the owner's run is busy (`isAgentSessionBusy`).                               |
| One memory, single writer per file                             | Letta (sleep-time owns memory), Hermes frozen snapshot                         | Ledger stays the shared memory. Let both sessions read it; make the watch the main writer of observations and the conversation the writer of the owner's decisions and preferences, both through `append_ledger`. The daily snapshot rebuild in `supervisor-memory.ts` already copes with the cache.  |
| Cheaper model for routine wakes                                | OpenClaw per-job model, Hermes `cron.model`, Letta                             | Goal `model` and `fallbackModel` fields: a small model for watch wakes, the default model for the conversation.                                                                                                                                                                                       |
| Suppress repeats                                               | Leon "suppress repeated matters after owner declines", Hermes alert dedupe     | Inbox `dedupeKey` already exists; record declines in the ledger so the watch stops re-raising them.                                                                                                                                                                                                   |
| Failure circuit-breaker                                        | OpenClaw auto-disable, Hermes failure nudges                                   | Goal pause with `pauseReason` after repeated errors, raised once as an fyi item.                                                                                                                                                                                                                      |

### Skip

- **One thread with interrupts (Leon style).** It is what collides today.
- **Fresh amnesiac session per wake (Hermes default, Khoj).** The watch needs
  to know what it already raised; a resumed goal plus ledger gives that, and
  `automations.ts` already covers the amnesiac case if ever needed.
- **Mirroring every background report into the chat.** Hermes makes it opt-in
  because each delivery costs a turn. The briefing already carries items.
- **Unattended trigger scripts with full tools (OpenClaw warns about this).**
  Keep gates server-side code, not agent-authored scripts.
- **A second memory system (vector store, MemFS, relationship stats).** The
  ledger and memory snapshot cover it; add only when there is evidence the
  ledger falls short.
- **Workflow platforms (n8n, Activepieces, AutoGPT).** Licences are fair-code
  or Polyform for the parts that matter, and goals already do the job.
- **Companion-app mechanics (affection meters, idle chatter).** If Blob ever
  speaks unprompted, copy Open-LLM-VTuber's rule: proactive turns skip memory
  and history unless they carry an inbox item.
- **A heartbeat that runs whether or not anything happened.** OpenClaw retired
  its own; event wakes plus one daily schedule are enough.

### Open questions to check before building

- Whether one watch goal per person or folding the watch into existing leads
  is simpler: the leads already watch projects; the person-level watch would
  only add cross-project events (workers finishing, needs-you aging). Check by
  listing which events no lead sees today.
- How a worker's completion reaches the server as an event today (assumption:
  session end hooks exist; check `session-loop.ts` and run-session terminal
  events).
