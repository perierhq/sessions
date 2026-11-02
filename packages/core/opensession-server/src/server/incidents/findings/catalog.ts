// The findings block catalog: the one source the agents' "## Findings"
// brief and the reader of `show_findings` input share, the way
// `REPORT_RULES` feeds both the report parser and the briefs. Pure data and
// string builders; no imports with side effects.

import type { AgentRole } from "../../../shared/incident-response";
import {
  FINDINGS_LIMITS,
  OWNER_OPTION_ACTIONS,
  type FindingBlock,
  type FindingKind,
  type FindingRef,
  type LogExcerpt,
  type SignalWindow,
} from "../../../shared/findings";
import { REPORT_BLOCK_MAX_BYTES } from "../response/reports";
import type { REF_TYPES } from "./validate";

type RefType = (typeof REF_TYPES)[number];

const L = FINDINGS_LIMITS;

/** What each block kind is for and the fields it takes, in
 *  `FINDING_KINDS` order. */
export const FINDINGS_CATALOG: ReadonlyArray<{
  kind: FindingKind;
  use: string;
  fields: string;
}> = [
  {
    kind: "hypothesis",
    use: "what you think happened and how sure you are",
    fields: `statement (one sentence), confidence (low, medium or high), evidence (up to ${L.evidence} refs), claims (up to ${L.claims} texts of your report's claims it rests on, word for word)`,
  },
  {
    kind: "timeline",
    use: "what happened when, in order",
    fields: `events (up to ${L.timelineEvents}): {"at": "<ISO time>", "text": "…", "ref": <ref>} with ref optional; the page adds when the incident opened, when you started, the proof and the merge`,
  },
  {
    kind: "signal",
    use: "a window of one of this incident's signals, drawn from the stored checks",
    fields: `signal (the signal id), lane (optional), from and to (ISO times, at most ${L.windowMs / 86_400_000} days apart), markers (up to ${L.markers}): {"at": "<ISO time>", "label": "deploy", "ref": <ref>} with ref optional: a release, an observation or an event; a marker without one shows as your note, not as checked data`,
  },
  {
    kind: "log",
    use: "lines one of your own tool calls printed",
    fields: `source (a {"type": "tool"} ref), lines (up to ${L.logLines} lines, copied exactly), highlight (indexes of the lines that matter)`,
  },
  {
    kind: "change",
    use: "the pull request or commit that matters, with why",
    fields: `pr (a number) or commit (7 to 40 hex characters), not both; why (one line: what the change does for this incident, not how); file (optional: the one file in it that matters) and line (optional: a line of that file on the new side), which the page shows as one hunk; the page lists the files and links to the review for the rest`,
  },
  {
    kind: "claims",
    use: "the claim checks as a list; added on its own when your report has claims",
    fields: "none beyond title",
  },
  {
    kind: "compare",
    use: "two windows or two excerpts side by side, such as before and after a deploy",
    fields: `sides (exactly two): {"label": "before deploy", "signal": {"signal": …, "from": …, "to": …}} or {"label": "after", "log": {"source": …, "lines": […]}}`,
  },
  {
    kind: "question",
    use: "what you don't know yet, or what you need the owner to do or decide",
    fields: `text (the question), wouldAnswer (what would answer it), options (optional, up to ${L.options}): the owner's choices for this decision, each {"label": "…", "detail": "…", "action": "…"}; see Options below`,
  },
];

/** The references a block may cite, in `REF_TYPES` order. */
export const REF_CATALOG: ReadonlyArray<{
  type: RefType;
  shape: string;
  use: string;
}> = [
  {
    type: "observation",
    shape:
      '{"type": "observation", "signal": "<signal id>", "lane": "<lane>", "at": "<ISO time>"}',
    use: "one stored check of this incident's signals; lane is optional",
  },
  {
    type: "ledger",
    shape: '{"type": "ledger", "id": "<ledger entry id>"}',
    use: "an entry of this incident's ledger",
  },
  {
    type: "event",
    shape: '{"type": "event", "id": "<event id>"}',
    use: "one of this incident's events",
  },
  {
    type: "action",
    shape: '{"type": "action", "id": "<action run id>"}',
    use: "an action run on this incident",
  },
  {
    type: "release",
    shape: '{"type": "release", "at": "<ISO time>", "ref": "<tag>"}',
    use: "a release of the project; ref is optional",
  },
  {
    type: "pr",
    shape: '{"type": "pr", "number": 42}',
    use: "a pull request this incident's agents opened",
  },
  {
    type: "commit",
    shape: '{"type": "commit", "sha": "<7 to 40 hex>"}',
    use: "a commit on the project's default branch",
  },
  {
    type: "tool",
    shape:
      '{"type": "tool", "tool": "<tool name>", "nth": 1, "contains": "<text>"}',
    use: "one of your own tool calls with its result: nth 1 is your most recent call of that tool (the default), contains picks the newest call whose result has that text; calls from other sessions can't be cited",
  },
  {
    type: "block",
    shape: '{"type": "block", "id": "<block id>"}',
    use: "another block by id",
  },
];

/** A short worked investigator example: question, timeline, log,
 *  hypothesis. It passes `validateFindings` with no notes. */
export const FINDINGS_EXAMPLE: { blocks: unknown[] } = {
  blocks: [
    {
      id: "unknown",
      kind: "question",
      size: "half",
      text: "Why do checkout requests to api.example.test time out since release v1.4.0?",
      wouldAnswer: "The database logs on prod-1 around the release.",
    },
    {
      id: "when",
      kind: "timeline",
      size: "half",
      events: [
        {
          at: "2026-10-27T11:02:00Z",
          text: "Release v1.4.0 of acme goes out",
          ref: { type: "release", at: "2026-10-27T11:02:00Z" },
        },
        {
          at: "2026-10-27T11:04:00Z",
          text: "First failed check on api.example.test",
        },
      ],
    },
    {
      id: "errors",
      kind: "log",
      source: {
        type: "tool",
        tool: "host_command",
        contains: "pool exhausted",
      },
      lines: [
        "ERROR db: connection pool exhausted (size 5)",
        "WARN http: GET /checkout took 30012 ms",
      ],
      highlight: [0],
    },
    {
      id: "small-pool",
      kind: "hypothesis",
      statement: "The release cut the database pool from 20 to 5 connections.",
      confidence: "medium",
      evidence: [
        { type: "block", id: "errors" },
        { type: "release", at: "2026-10-27T11:02:00Z" },
      ],
      claims: ["The release set the database pool size to 5."],
    },
  ],
};

const KEEP = '{"id": "…", "keep": true}';

/** What each option action does, in `OWNER_OPTION_ACTIONS` order. */
export const OPTION_ACTIONS_CATALOG: ReadonlyArray<{
  action: (typeof OWNER_OPTION_ACTIONS)[number];
  does: string;
}> = [
  {
    action: "merge",
    does: "Sessions merges this round's pull request through its merge gate, then runs the project's deploy action or, without one, waits for the release; then it checks production. Give \"pr\" (the number) when you name it",
  },
  {
    action: "release-watch",
    does: "the owner merges and releases the pull request; Sessions waits for it and then watches and checks production",
  },
  {
    action: "send-back",
    does: 'another round for the investigator; put the note you suggest in "note" (the owner can edit it)',
  },
  { action: "close", does: "close the incident without action" },
  {
    action: "mark-fixed",
    does: "close the incident as fixed by hand",
  },
  {
    action: "answer",
    does: "the owner types an answer and it comes back to you as your next message, in this round; for a question only they can answer",
  },
];

/** A question block that offers options. It passes `validateFindings`
 *  with no notes. */
export const OPTIONS_EXAMPLE = {
  id: "ship",
  kind: "question",
  text: "CI can't start on acme/web until its Actions billing is fixed. How should PR #12 go out?",
  wouldAnswer: "The owner's choice.",
  options: [
    {
      label: "Yes, merge it",
      detail:
        "The tests passed in my session; Sessions merges #12 and checks production after the release.",
      action: "merge",
      pr: 12,
    },
    {
      label: "I'll fix billing first",
      detail: "Tell me when CI can run and I'll check the results.",
      action: "answer",
    },
    {
      label: "Close it",
      detail: "The problem stopped on its own.",
      action: "close",
    },
  ],
} as const;

/** How an agent offers the owner options: the "### Options" part of the
 *  findings brief. */
export function optionsBrief(): string[] {
  return [
    "### Options",
    "",
    "When the next step is a decision only the owner can make, offer the choices on one question block as options. The incident's card then shows only your options, with a field to type something else, instead of its own buttons.",
    "Offer only real choices: 2 to 4, the one you recommend first. Each option's label says what happens in a few words (\"Yes, merge it\", \"I'll restore billing\"); detail says what follows and why, in one sentence. Don't restate the card's question in them.",
    `Each option has one action: ${OWNER_OPTION_ACTIONS.join(", ")}.`,
    ...OPTION_ACTIONS_CATALOG.map((a) => `- ${a.action}: ${a.does}.`),
    "Sessions leaves off any option it can't do right now (a failing check, a pull request that isn't this incident's, no round left) and tells you here; when none is left the card shows its usual choices.",
    "Only one question block may offer options. Leave options off when you have no decision to ask for.",
    "",
    "A question with options:",
    "```json",
    JSON.stringify(OPTIONS_EXAMPLE, null, 2),
    "```",
    "",
  ];
}

/** The "## Findings" section of a brief, built from the catalogs and
 *  `FINDINGS_LIMITS`. */
export function findingsBrief(role: AgentRole | "post-release"): string[] {
  const days = L.windowMs / 86_400_000;
  const out = [
    "## Findings",
    "",
    "Show what you find on the incident page with the show_findings tool: send the whole list of blocks each time, in the order they should read. Each call replaces your blocks for this round, and the tool answers with what it saved and what it dropped, so fix the notes and call it again.",
  ];
  if (role === "investigator")
    out.push(
      "Start early with a question or a timeline and refine it as you learn.",
      `In a later round, carry the previous round's blocks forward instead of starting over: keep one unchanged with ${KEEP}, or send it again under the same id to edit it.`,
      'Don\'t write "Round 2:" or what changed into prose; the page marks new and changed blocks against the round before.',
    );
  else if (role === "verifier")
    out.push(
      "Your blocks show as \"from the verifier\". They follow the investigator's; add only what you checked yourself, such as a compare of before and after, and refer to the investigator's blocks by id.",
      "Your claim checks set each hypothesis's status; you don't set it.",
    );
  else
    out.push(
      'Your blocks show on their own, as "after release", below the round\'s findings. Show what production does now: a signal window or a compare from before the release to after it, the log lines around the release, and the claims you checked.',
    );
  out.push(
    `Prefer a few precise blocks: 3 to 8, at most ${L.blocks}.`,
    "Anything you need the owner to do or decide goes in a question block: the page shows open questions with the owner's decision. To offer the choices themselves, add options (see Options).",
    "Cite real data: every chart, quote and change must point at something Sessions can load, and a block whose data can't be found is dropped.",
    "Quote log lines exactly as the tool printed them; lines that aren't in the result are dropped.",
    `If you never called show_findings, put the same list under "findings" in your incident-report block. They count toward the block's ${REPORT_BLOCK_MAX_BYTES / 1024} KB, so keep them short there.`,
    "",
    `Every block has id (lowercase letters, digits and dashes, at most ${L.idMax}, unique in your list), kind, an optional title and size (full or half; two half blocks share a row).`,
    "Kinds:",
    ...FINDINGS_CATALOG.map(
      (k) => `- ${k.kind}: ${k.use}. Fields: ${k.fields}.`,
    ),
    "",
    "References:",
    ...REF_CATALOG.map((r) => `- ${r.shape}: ${r.use}.`),
    "",
    "Times in refs and fields are ISO 8601 with a time zone, like 2026-10-27T10:00:00Z.",
    "Don't write clock times in prose (statement, text, why, question): the page shows times in the reader's zone, so refer to a timeline event (\"at the first failed check\") instead.",
    `Limits: title at most ${L.title} characters; prose fields at most ${L.prose}; a statement or question at most ${L.statement}; timeline events at most ${L.eventText} characters; marker labels and compare labels at most ${L.markerLabel}; a log at most ${L.logLines} lines of ${L.logLineChars} characters; a signal window at most ${days} days.`,
    "",
    ...optionsBrief(),
    "Example:",
    "```json",
    JSON.stringify(FINDINGS_EXAMPLE, null, 2),
    "```",
    "",
  );
  return out;
}

const PROSE_MAX = 120;

/** `- <id> · <kind> · <ref summary>`; with prose, then
 *  ` — <title or statement, ≤ 120 chars>`. The ref summary names counts
 *  and ids only, never agent text, so the verifier's brief can list the
 *  investigator's blocks without its reasoning. */
export function briefLine(
  block: FindingBlock,
  opts: { prose: boolean },
): string {
  const summary = refSummary(block);
  let line = `- ${block.id} · ${block.kind}${summary ? ` · ${summary}` : ""}`;
  if (opts.prose) {
    const prose = oneLine(block.title ?? proseOf(block) ?? "");
    if (prose) line += ` — ${prose}`;
  }
  return line;
}

function proseOf(block: FindingBlock): string | undefined {
  switch (block.kind) {
    case "hypothesis":
      return block.statement;
    case "question":
      return block.text;
    case "change":
      return block.why;
    default:
      return undefined;
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PROSE_MAX ? `${flat.slice(0, PROSE_MAX - 1)}…` : flat;
}

function refSummary(block: FindingBlock): string {
  switch (block.kind) {
    case "hypothesis":
      return [
        ...(block.claims.length ? [count(block.claims.length, "claim")] : []),
        ...refCounts(block.evidence),
      ].join(", ");
    case "timeline":
      return [
        count(block.events.length, "event"),
        ...refCounts(block.events.flatMap((e) => (e.ref ? [e.ref] : []))),
      ].join(", ");
    case "signal":
      return [
        windowSummary(block),
        ...(block.markers.length
          ? [count(block.markers.length, "marker")]
          : []),
      ].join(", ");
    case "log":
      return logSummary(block);
    case "change":
      return block.change.type === "pr"
        ? `PR #${block.change.number}`
        : `commit ${block.change.sha.slice(0, 7)}`;
    case "compare":
      return block.sides
        .map((s) =>
          "signal" in s ? windowSummary(s.signal) : logSummary(s.log),
        )
        .join(" vs ");
    case "claims":
    case "question":
      return "";
  }
}

function logSummary(log: LogExcerpt): string {
  return `${log.source.tool} call, ${count(log.lines.length, "line")}`;
}

function windowSummary(w: SignalWindow): string {
  const from = w.from.slice(0, 10);
  const to = w.to.slice(0, 10);
  const clock = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 16);
  };
  const range =
    from === to
      ? `${clock(w.from)}–${clock(w.to)}`
      : `${from} ${clock(w.from)}–${to} ${clock(w.to)}`;
  return `${w.signalId}${w.lane ? ` lane ${w.lane}` : ""} ${range} UTC`;
}

const REF_NOUNS: Record<FindingRef["type"], [string, string]> = {
  observation: ["observation", "observations"],
  ledger: ["ledger entry", "ledger entries"],
  event: ["event", "events"],
  action: ["action run", "action runs"],
  release: ["release", "releases"],
  pr: ["PR", "PRs"],
  commit: ["commit", "commits"],
  tool: ["tool call", "tool calls"],
  block: ["block", "blocks"],
};

/** Counts by ref type, in order of first appearance. */
function refCounts(refs: readonly FindingRef[]): string[] {
  const counts = new Map<FindingRef["type"], number>();
  for (const r of refs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  return [...counts].map(([type, n]) => {
    const [one, many] = REF_NOUNS[type];
    return `${n} ${n === 1 ? one : many}`;
  });
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
