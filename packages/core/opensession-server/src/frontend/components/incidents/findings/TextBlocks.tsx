import {
  type ClaimRow,
  droppedLinesCopy,
  FINDINGS_COPY,
  type FindingBlock,
  type HypothesisStatus,
  type LogExcerpt,
  provenanceLabel,
} from "../../../../shared/findings";
import type { Incident } from "../../../../shared/incidents";
import {
  CLAIM_STATUS_COPY,
  CONFIDENCE_COPY,
  type FindingItem,
  timelineRows,
} from "../../../lib/incidents/findings";
import {
  AUDIT_ROW,
  FINDINGS_CLAIM_ROW,
  FINDINGS_INLINE_PROSE,
  FINDINGS_LABEL,
  FINDINGS_LOG,
  FINDINGS_LOG_MARK,
  FINDINGS_PROSE,
  FINDINGS_PROSE_QUIET,
  FINDINGS_SOURCE,
  FINDINGS_SOURCE_QUIET,
  FINDINGS_STATUS_TONE,
} from "../../../lib/incident-classes";
import { parseAnsi, renderAnsiHtml } from "../../../lib/ansi-block";
import { renderMarkdown } from "../../../lib/markdown";
import { clockTime, fullTime } from "../../../lib/time";
import { cn } from "../../../ui/cn";
import { MarkdownBody } from "../../MarkdownBody";

type BlockOf<K extends FindingBlock["kind"]> = Extract<
  FindingBlock,
  { kind: K }
>;

/** Agent prose: Markdown through the shared renderer (raw HTML stays text,
 *  images follow #106's rules), never upgraded into live blocks. */
function Prose({ text, quiet = false }: { text: string; quiet?: boolean }) {
  return (
    <MarkdownBody
      html={renderMarkdown(text)}
      enhance={false}
      className={quiet ? FINDINGS_PROSE_QUIET : FINDINGS_PROSE}
    />
  );
}

/** One line of agent prose inside a row (a claim, its evidence): the same
 *  Markdown path, without paragraph margins. */
function InlineProse({ text, className }: { text: string; className: string }) {
  return (
    <MarkdownBody
      html={renderMarkdown(text)}
      enhance={false}
      className={cn(FINDINGS_INLINE_PROSE, className)}
    />
  );
}

/** The block's own fields when `item` holds that kind, else null; the
 *  section only hands each component its own kind. */
function blockOf<K extends FindingBlock["kind"]>(
  item: FindingItem,
  kind: K,
): BlockOf<K> | null {
  // SAFETY: `kind` is the discriminant just compared; TypeScript cannot
  // narrow a generic union member from it.
  return item.block.kind === kind ? (item.block as BlockOf<K>) : null;
}

function StatusWord({ status }: { status: HypothesisStatus }) {
  return (
    <span className={FINDINGS_STATUS_TONE[status]}>
      {FINDINGS_COPY.status[status]}
    </span>
  );
}

/** What the agent thinks happened: the sentence, how sure it is, whether
 *  the verifier's checks bear it out, and the claims it rests on. */
export function HypothesisBlock({ item }: { item: FindingItem }) {
  const block = blockOf(item, "hypothesis");
  if (!block) return null;
  return (
    <>
      <Prose text={block.statement} />
      <p className="m-0 text-supporting text-dim">
        {CONFIDENCE_COPY[block.confidence]}
        {" · "}
        <StatusWord status={item.status ?? "unchecked"} />
      </p>
      {block.claims.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <p className={FINDINGS_LABEL}>Rests on</p>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-supporting text-dim [overflow-wrap:anywhere]">
            {block.claims.map((claim, i) => (
              // Claims are free text and may repeat; the list never reorders.
              <li key={i}>
                <InlineProse
                  text={claim}
                  className="text-supporting text-dim"
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/** What happened when: the agent's events among the incident's own
 *  moments (opened, investigator started, proof, merge), oldest first. */
export function TimelineBlock({
  item,
  incident,
  round,
}: {
  item: FindingItem;
  incident: Pick<Incident, "openedAt" | "response">;
  round: number;
}) {
  const block = blockOf(item, "timeline");
  if (!block) return null;
  const rows = timelineRows(block, incident, round);
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {rows.map((row, i) => (
        <li
          // Rows are sorted by time and two can share a time and a text.
          key={i}
          className={cn(
            AUDIT_ROW,
            "text-supporting",
            row.anchor ? "text-dim" : "text-fg",
          )}
        >
          <time
            dateTime={row.at}
            title={fullTime(row.at)}
            className="text-meta text-dim tabular-nums"
          >
            {clockTime(row.at)}
          </time>
          {row.anchor ? (
            <span className="min-w-0 [overflow-wrap:anywhere]">{row.text}</span>
          ) : (
            <MarkdownBody
              html={renderMarkdown(row.text)}
              enhance={false}
              className={FINDINGS_INLINE_PROSE}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/** What isn't known yet, and what would answer it. No buttons: the person
 *  answers through the Next card or the agent's session. */
export function QuestionBlock({ item }: { item: FindingItem }) {
  const block = blockOf(item, "question");
  if (!block) return null;
  return (
    <>
      <Prose text={block.text} />
      {block.wouldAnswer ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className={FINDINGS_LABEL}>What would answer it</p>
          <Prose text={block.wouldAnswer} quiet />
        </div>
      ) : null}
    </>
  );
}

/**
 * Quoted lines exactly as the server kept them, as text in the code well
 * (escapes become styles, never markup), highlighted lines marked. Under
 * them, where they came from and how many quoted lines the server could
 * not find in the source.
 */
export function LogLines({ excerpt }: { excerpt: LogExcerpt }) {
  const marked = new Set(excerpt.highlight);
  const source = provenanceLabel(excerpt.source.provenance);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {excerpt.lines.length > 0 ? (
        <pre className={FINDINGS_LOG}>
          <code>
            {excerpt.lines.map((line, i) => {
              // renderAnsiHtml escapes the text; colours are integers.
              const html = { __html: renderAnsiHtml(parseAnsi(line)) };
              return marked.has(i) ? (
                // Lines are positional: the highlight indexes point at them.
                <mark key={i} className={FINDINGS_LOG_MARK}>
                  <span dangerouslySetInnerHTML={html} />
                </mark>
              ) : (
                <span
                  key={i}
                  className="block"
                  dangerouslySetInnerHTML={html}
                />
              );
            })}
          </code>
        </pre>
      ) : null}
      <p className={source.quiet ? FINDINGS_SOURCE_QUIET : FINDINGS_SOURCE}>
        {source.text}
      </p>
      {excerpt.dropped > 0 ? (
        <p className={FINDINGS_SOURCE}>{droppedLinesCopy(excerpt.dropped)}</p>
      ) : null}
    </div>
  );
}

export function LogBlock({ item }: { item: FindingItem }) {
  const block = blockOf(item, "log");
  if (!block) return null;
  return <LogLines excerpt={block} />;
}

function ClaimRowView({ row }: { row: ClaimRow }) {
  const tone =
    row.status === "unverifiable"
      ? FINDINGS_STATUS_TONE["cant-tell"]
      : FINDINGS_STATUS_TONE[row.status];
  return (
    <li className={FINDINGS_CLAIM_ROW}>
      <InlineProse text={row.text} className="text-supporting text-fg" />
      <span className={cn("text-meta", tone)}>
        {CLAIM_STATUS_COPY[row.status]}
      </span>
      {row.evidence ? (
        <InlineProse text={row.evidence} className="text-meta text-faint" />
      ) : null}
    </li>
  );
}

/** The report's claims, each with what the verifier found. */
export function ClaimsBlock({ item }: { item: FindingItem }) {
  const rows = item.claims ?? [];
  if (rows.length === 0)
    return <p className="m-0 text-supporting text-faint">No claims yet</p>;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map((row, i) => (
        // Claims follow the report's order and may repeat.
        <ClaimRowView key={i} row={row} />
      ))}
    </ul>
  );
}
