/**
 * The owner's report style: the shape the supervisor's replies and the
 * leads' proposals take. Stored with the other supervisor prefs
 * (supervisor-quiet-hours.ts `cleanPrefs`, GET/PUT /api/supervisor/prefs).
 * The instruction rides in each supervisor turn's context next to the inbox
 * briefing (run-session.ts) and in each lead's charter (leads/charter.ts),
 * never in the supervisor's system prompt, so a change keeps the prompt
 * cache. Pure.
 */

export const REPORT_STYLES = ["bluf", "sbar", "plain"] as const;
export type ReportStyle = (typeof REPORT_STYLES)[number];

export const DEFAULT_REPORT_STYLE: ReportStyle = "bluf";

export function isReportStyle(value: unknown): value is ReportStyle {
  return (
    typeof value === "string" &&
    (REPORT_STYLES as readonly string[]).includes(value)
  );
}

const INSTRUCTIONS: Record<ReportStyle, string> = {
  bluf: "BLUF: what is shown leads with the bottom line or the ask, then what supports it.",
  sbar: "SBAR: what is shown is four short labelled parts: Situation, Background, Assessment, Recommendation.",
  plain: "plain: no fixed shape; show what fits.",
};

/** Whatever the style, what Blob says aloud is talk, not a report. */
const SPOKEN =
  "What Blob says aloud stays conversational in every style: one to three sentences about what is shown, never the report read out.";

/** One line: how to shape a report in this style, and how Blob says it.
 *  Anything unknown is the default. */
export function reportStyleInstruction(style: unknown): string {
  return `The owner's report style is ${INSTRUCTIONS[isReportStyle(style) ? style : DEFAULT_REPORT_STYLE]} ${SPOKEN}`;
}
