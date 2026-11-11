---
name: blob-review
description: Review how the owner uses Blob and rank concrete improvements from the data. Use when asked to analyze past Blob or supervisor usage, find what is slow, misunderstood or annoying in Blob, or tune the supervisor charter, Blob's voice or UI to the owner's usage patterns.
argument-hint: "[--days 14]"
---

# Blob review

Turn the owner's own Blob usage into a short, ranked list of improvements, each backed by numbers and by the turns that show it. Every claim cites a field of the review or a sampled turn; anything you could not check is labelled an assumption with the check that would settle it.

## 1. Pull the review

From the repository root, with the owner's server and bearer token in the environment (`OPENSESSION_URL`, `OS1_TOKEN`):

```bash
REVIEW="$(mktemp -t blob-review.XXXXXX)"
bun scripts/blob-review.ts --days 14 --entries --out "$REVIEW"
```

The file holds the start of the owner's sampled messages, so it is written readable by you only and deleted in the last step. Use the window the owner asked for (`--days`, 1 to 90). On a server without sign-in, add `--user <name>`. The endpoint, `GET /api/blob/review`, answers only the instance owner.

Done when the file parses and `window`, `app`, `transcript`, `inbox` and `samples` are present. Note `sources`: `app.turns` is 0 until the Blob app has sent metrics, and then the transcript, inbox and ledger sections carry the review alone. Say so in the report. Also check the two caps: `sources.sessionsTruncated` (more supervisor sessions fell in the window than one review reads, so the oldest are missing) and `sources.inboxTruncated` / `inbox.truncated` (the inbox list hit its cap, so older items are missing). When either is true, say which section is partial and suggest a shorter `--days`.

## 2. Read the numbers

What each section measures (server: `blob-review.ts`; app: `BlobMetrics.swift`):

- `app`: per-turn metrics the Blob app measured. `latencyMs` splits a turn into stages: `speech` (talking), `transcribe`, `sendToAccepted` (the server took the message), `acceptedToFirstToken` (the model's first words), `firstTokenToFirstAudio` (until Blob is heard). Also transcriber and voice usage, `endOfSpeech` (auto or tap), `interruptions` (hush or tap while Blob speaks, as a share of spoken replies), `reasks`, `byOutcome` (answered, failed, abandoned), reply length, block kinds, thinking steps, posture (closed or open) and app versions.
- `app.transcriberReasons` and `app.parakeetLoadMs`: why voice turns used Parakeet, Fish or Apple. `parakeet` means Parakeet wrote the text. Other `parakeet-*` reasons say why it didn't: `absent` (not downloaded), `downloading`, `loading-timeout` (not loaded within 15 s of the stop, 45 s when Apple heard nothing, 2 s with Fish until Parakeet; usually a first load after the download, an OS update or a memory warning), `failed` (the download or load failed), `skipped` (still loading when the owner tapped to send Apple's text now), `error`, `empty` and `deadline` (it was loaded but gave no usable text in time). `fish` and `fish-missed` cover the Fish path, `apple-chosen` means Apple is picked in Settings, and `too-short` means under 0.3 s of audio. With Parakeet picked and "Fish until Parakeet" on, a `fish` or `fish-missed` turn also carries `parakeetMiss`, the Parakeet reason it fell back from. `app.parakeetMisses` counts every Parakeet miss: the reason itself, or `parakeetMiss` on Fish turns. `parakeetLoadMs` is the time from `warm()` to ready of a completed load, recorded once per load on the first turn that used it or waited for it; a load let go before it finished records nothing. `parakeetWaitMs` is how long the recording waited for a load still under way after the owner stopped, while Blob showed "Getting my ears ready"; turns that did not wait leave it out. A high `parakeetWaitMs` p50 means loads start too late, and many `parakeet-loading-timeout` misses with a p50 load above 15 s mean the model loads too slowly to be ready when the owner stops talking.
- `app.glossaryFixes`: `turns` is how many voice turns had a misheard project name, teammate, persona or term corrected by the app's glossary (`GET /api/blob/glossary`), `words` how many corrections in all. No text is kept. A rising share alongside re-asks means the transcribers still mishear names; a high share with few re-asks means the correction works.
- `app.drops`: voice turns that never went out (outcome `abandoned`, kept out of the transcriber stats above), by `byReason`: `nothing-heard` (no text at the end), `moved-on` (the owner sent something else first), `backgrounded` (the app left with nothing heard), `no-endpoint` (the listen ran to its 60 s cap with no text), plus their `transcriberReasons` and `parakeetStates` (where Parakeet was). Blob showed a notice for each. Many `nothing-heard` with `parakeetStates.loading` mean Parakeet's first load still beats the owner to it. The device's `Library/Caches/blob-talk.log` has the step-by-step log behind a drop (packages/clients/ios/README.md).
- Transcriber timings (`latencyMs.transcribe`, `transcribers.*.ms`, `parakeetLoadMs`) come only from turns that carry `transcriberReason`. On those, `transcribeMs` is the time in the transcriber that wrote the text; for Apple it is the time Apple took to finish its last phrase. Older builds timed the whole fallback chain, so their voice turns are left out and counted in `app.untimedVoiceTurns`; they still count in `transcribers.*.turns`.
- `transcript`: owner messages in the supervisor sessions. `latencyMs.firstReply` and `turn` (to the last reply), `unanswered`, `reasks` (a similar-length follow-up within 60 s of the reply), `toolCallsPerTurn`, `topTools`, `toolErrors`, reply length buckets, and `hours` in the owner's time zone.
- `inbox`: supervisor and lead items: answer, dismiss and expiry rates, `timeToAnswerMs` from the push, how often the recommended (first) option was chosen, and lead proposals by state.
- `ledger.entries`: what the supervisor wrote down in the window.
- `samples`: ids of the slowest, failed, interrupted or re-asked, and unanswered turns, with `sessionId` and `entryId` (the owner message) and `replyEntryId`. With `--entries`, `entries["<sessionId>/<entryId>"]` holds the first 600 characters of each.

Done when you have a one-line reading of every section, including the ones that look fine.

## 3. Read the sampled turns

For each sample, read the owner message and the reply under `entries`. One whole entry, unclamped, is `GET /api/sessions/<sessionId>/entry/<entryId>`. When you need the turn's tool calls or more context, read the entries around it: `GET /api/sessions/<sessionId>/entry/<entryId>/around?before=5&after=10` (each at most 50) answers `{ index, total, from, entries }`. Send the same `Authorization: Bearer $OS1_TOKEN` header. Don't fetch the whole transcript. Classify each sampled turn as one of:

- **slow**: which stage took the time (model, tools, transcription, speech), and whether the work needed doing at all.
- **misunderstood**: the reply answered something other than what was asked, or the owner had to ask again.
- **annoying**: Blob talked too long, repeated a list it already gave, read out the live state, or was interrupted.
- **broken**: a tool error, a failed or abandoned turn, no reply.

Done when every sampled turn has a class and one sentence of why.

## 4. Compare against the rules

Check each pattern against what Blob is meant to do:

- The supervisor charter: `supervisorNote` in `packages/core/opensession-server/src/server/supervisor.ts` (short answers, answer only what was asked, delegate real work, one or two sentences in Blob).
- Blob's design rules: `adrs/blob-views.md` (replies use the block catalog and fit the panes the turn reports) and `adrs/supervisor-and-leads.md` (the inbox, quiet hours, what leads may raise).
- Blob's speech: `BlobReply` reads only the first paragraph aloud (`packages/clients/ios/Blob/BlobReply.swift`).

A long first paragraph is a voice problem; heavy tool use on a greeting is a charter problem; low answer rates on lead proposals are a routing problem.

## 5. Report

Keep it to one screen:

1. **What's slow**: the slowest stage with its p50 and p90, and its main cause.
2. **What's misunderstood**: re-ask and unanswered rates, with two sampled turns.
3. **What's annoying**: interruption rate, reply length against the charter's one or two sentences, repeated or unwanted content.
4. **Improvements**, ranked by how many turns they would fix: each one concrete (the charter line to change, the UI or voice setting, the routing rule), with its evidence (fields and turn ids) and how the next review would show it worked.

Quote no more of the owner's messages than the point needs. Everything stays on this machine: the report goes to the owner, never into an issue, pull request or commit.

Done when every improvement names its evidence and its measure.

## 6. Clean up

Delete the review file, whether or not the report is finished:

```bash
rm -f "$REVIEW"
```

Done when the file is gone.
