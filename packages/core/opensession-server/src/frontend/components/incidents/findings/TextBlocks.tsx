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
  CONFIDENCE_WORD,
  type FindingItem,
  FINDINGS_MARKDOWN,
  LOG_UTC_COPY,
  localizeTimes,
  logTimesInUtc,
  timelineRows,
  unCheckedClaimsCopy,
} from "../../../lib/incidents/findings";
import {
  AUDIT_ROW,
  FINDINGS_CLAIM_ROW,
  FINDINGS_CLAIMS_CHEVRON,
  FINDINGS_CLAIMS_FOLD,
  FINDINGS_CLAIMS_SUMMARY,
  FINDINGS_INLINE_PROSE,
  FINDINGS_LABEL,
  FINDINGS_LOG,
  FINDINGS_LOG_MARK,
  FINDINGS_PROSE,
  FINDINGS_PROSE_QUIET,
  FINDINGS_SOURCE,
  FINDINGS_SOURCE_QUIET,
  FINDINGS_STATUS_LINE,
} from "../../../lib/incident-classes";
import { parseAnsi, renderAnsiHtml } from "../../../lib/ansi-block";
import { renderMarkdown } from "../../../lib/markdown";
import { clockTime, fullTime } from "../../../lib/time";
import { cn } from "../../../ui/cn";
import { MarkdownBody } from "../../MarkdownBody";
import { IconChevronDown } from "../../icons";
import { StatusMark } from "./StatusMark";

type BlockOf<K extends FindingBlock["kind"]> = Extract<
  FindingBlock,
  { kind: K }
>;

/** Agent prose: Markdown through the shared renderer (raw HTML stays text,
 *  images follow #106's rules), never upgraded into live blocks. */
export function Prose({
  text,
  quiet = false,
}: {
  text: string;
  quiet?: boolean;
}) {
  return (
    <MarkdownBody
      html={renderMarkdown(localizeTimes(text), FINDINGS_MARKDOWN)}
      enhance={false}
      className={quiet ? FINDINGS_PROSE_QUIET : FINDINGS_PROSE}
    />
  );
}

/** One line of agent prose inside a row (a claim, its evidence): the same
 *  Markdown path, without paragraph margins. */
export function InlineProse({
  text,
  className,
}: {
  text: string;
  className: string;
}) {
  return (
    <MarkdownBody
      html={renderMarkdown(localizeTimes(text), FINDINGS_MARKDOWN)}
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

/** What the agent thinks happened: the sentence, then whether the
 *  verifier's checks bear it out (a mark first) and how sure the agent is,
 *  and the claims it rests on that no claims block lists. */
export function HypothesisBlock({ item }: { item: FindingItem }) {
  const block = blockOf(item, "hypothesis");
  if (!block) return null;
  const restsOn = item.restsOn ?? block.claims;
  return (
    <>
      <Prose text={block.statement} />
      <p className={FINDINGS_STATUS_LINE}>
        <StatusMark status={item.status ?? "unchecked"} />
        <span aria-hidden>·</span>
        <span>{CONFIDENCE_WORD[block.confidence]}</span>
      </p>
      {restsOn.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <p className={FINDINGS_LABEL}>Rests on</p>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-supporting text-dim [overflow-wrap:anywhere]">
            {restsOn.map((claim, i) => (
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
            <InlineProse text={row.text} className="" />
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
        {logTimesInUtc(excerpt.lines)
          ? `${source.text} · ${LOG_UTC_COPY}`
          : source.text}
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

/** A claim row's status as the hypothesis's mark: "unverifiable" reads
 *  as can't tell. */
const rowStatus = (status: ClaimRow["status"]): HypothesisStatus =>
  status === "unverifiable" ? "cant-tell" : status;

function ClaimRowView({ row }: { row: ClaimRow }) {
  return (
    <li className={FINDINGS_CLAIM_ROW}>
      <InlineProse text={row.text} className="text-supporting text-fg" />
      <span className="text-meta">
        <StatusMark status={rowStatus(row.status)} />
      </span>
      {row.evidence ? (
        <InlineProse text={row.evidence} className="text-meta text-faint" />
      ) : null}
    </li>
  );
}

/** The report's claims, each with what the verifier found. Before any
 *  check, one line that opens to the claims, instead of a row per claim
 *  all saying "Not checked yet". */
export function ClaimsBlock({ item }: { item: FindingItem }) {
  const rows = item.claims ?? [];
  if (rows.length === 0)
    return <p className="m-0 text-supporting text-faint">No claims yet</p>;
  if (rows.some((row) => row.status !== "unchecked"))
    return (
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row, i) => (
          // Claims follow the report's order and may repeat.
          <ClaimRowView key={i} row={row} />
        ))}
      </ul>
    );
  return (
    <details className={FINDINGS_CLAIMS_FOLD}>
      <summary className={FINDINGS_CLAIMS_SUMMARY}>
        {unCheckedClaimsCopy(rows.length)}
        <IconChevronDown size={16} dense className={FINDINGS_CLAIMS_CHEVRON} />
      </summary>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row, i) => (
          <li key={i} className={FINDINGS_CLAIM_ROW}>
            <InlineProse text={row.text} className="text-supporting text-fg" />
          </li>
        ))}
      </ul>
    </details>
  );
}
