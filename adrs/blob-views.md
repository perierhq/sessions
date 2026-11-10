# Blob views: transcript blocks, not a new channel

Status: accepted. Written 2026-11-10.

## Context

Blob is the quiet iOS app where the supervisor agent shows up only when it has
something for you (see "What we're building" in `AGENTS.md`). The designs have
Blob answer with views, not paragraphs: a number, a timeline, a ranked list,
a decision with buttons, marks drawn on a screenshot. The first plan was a new
`blob_show` tool that sends a json-render style spec to the app over its own
channel.

Two things already exist that do most of that job:

- **Transcript blocks** (`docs/blocks.md`). An agent writes fenced blocks in
  its reply (`metrics`, `choices`, `csv`, `vega-lite`, `tree`, `slides`,
  callouts, placed images and before/after compares) and the clients render
  them. The model prompt (`server/run-instructions.ts`) already names every
  form, so the Desk agent can write them today.
- **Native renderers.** The iOS app draws the whole catalog itself
  (`Models/TranscriptRichBlocks.swift`, `Views/MarkdownBody.swift`,
  `Views/Blocks/`). Blob compiles the same sources.

## Decision

A Blob view is an ordinary Desk reply, rendered with the existing block
catalog. There is no `blob_show` tool and no second channel.

1. **Render.** Blob shows the Desk's answer through `MarkdownBody`, so every
   block the web and the OS app render also renders in Blob. `choices` chips
   send through the Desk's `QuickReplyRelay`, the same path as in OS.
2. **Space.** Each Blob message tells the Desk where it is shown: the app,
   how many panes it has (one closed, two open on the Duo) and its width class.
   The Desk turn gets it as wrapped per-turn context, the way it already gets
   `deskStateContext`, with a short rule: answer first, prefer blocks to
   prose, fit one pane unless two are available. A server change, in its own
   pull request.
3. **New kinds.** What the catalog lacks (a timeline, a decision card with
   consequences, marks on an image) is added as new block kinds under the
   existing contract in `docs/blocks.md`: one parser, a web renderer and a
   native renderer, a line in the model prompt, and a plain-text fallback
   wherever a client can't draw it.
4. **Safety.** A block only renders and relays text. Anything it triggers is
   a message to the agent, which runs under the agent's existing policy. A view
   can never do something the agent could not already do.

## Why not a separate tool and spec

- It would duplicate the catalog, its parsers and its renderers on a second
  path that only Blob reads.
- Views would vanish from the Desk transcript in the OS app and on the web,
  where blocks already render and stay in history.
- History comes for free: a past view is a past message.
- The streaming, reconnects, the outbox and read state are already solved for
  transcript entries.

## Consequences

- Blob gets views as soon as it renders replies with `MarkdownBody`, against
  any server that already runs the block catalog.
- Views follow the blocks' rule that no block is the only carrier of what the
  reader needs, so a reply still reads in Slack or an export.
- Layout across the Duo fold (one view per pane) needs the space hint and,
  later, a way to say which block goes in which pane. That is a later
  decision, made when a real reply needs it.
- Update 2026-11-10: the app splits a reply itself. On a wide surface the
  layout follows what is on the page, and Blob takes the largest space
  left: the whole surface with nothing to read, the trailing pane beside
  a reply that is only text, its corner when the reply's visual blocks
  (or a decision beside it) take the trailing pane. The conversation
  stays in the leading pane, so text never crosses the Duo's fold. History
  shows each exchange in the arrangement it had. Visuals spanning both
  panes are not done: a wide block stays in the trailing pane until a
  reply needs more.
