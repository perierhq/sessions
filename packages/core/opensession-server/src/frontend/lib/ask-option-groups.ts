// How AskCard lays a question's options out in runs (its `groups` prop),
// and the typed-answer field it offers (its `freeText` prop).
import type { AskFreeText, AskOptionGroup, AskQuestion } from "./types";

type AskOption = NonNullable<AskQuestion["options"]>[number];

export interface AskOptionRun {
  options: AskOption[];
  /** Drawn as a labelled group; false for a card without groups. */
  grouped: boolean;
  label?: string;
  quiet: boolean;
}

/**
 * The question's options in the runs `groups` asks for, in order. Options
 * past the groups' counts join the last run; empty runs are left out. No
 * groups is one run, drawn as before.
 */
export function optionRuns(
  q: AskQuestion,
  groups: readonly AskOptionGroup[] | undefined,
): AskOptionRun[] {
  const options = q.options ?? [];
  if (!groups?.length) return [{ options, grouped: false, quiet: false }];
  const runs: AskOptionRun[] = [];
  let at = 0;
  groups.forEach((group, i) => {
    const last = i === groups.length - 1;
    const count = Math.max(0, Math.floor(group.count));
    const taken = options.slice(at, last ? undefined : at + count);
    at += taken.length;
    if (!taken.length) return;
    const run: AskOptionRun = {
      options: taken,
      grouped: true,
      quiet: !!group.quiet,
    };
    if (group.label) run.label = group.label;
    runs.push(run);
  });
  return runs;
}

const OWN_ANSWER: AskFreeText = {
  label: "Custom answer",
  placeholder: "Or type your own answer…",
};
const ANSWER: AskFreeText = {
  label: "Answer",
  placeholder: "Type your answer…",
};

/** The typed-answer field AskCard's `freeText` asks for, or null for none:
 *  on, it is "Or type your own answer…" beside options and "Type your
 *  answer…" without them. */
export function freeTextField(
  freeText: boolean | AskFreeText,
  hasOptions: boolean,
): AskFreeText | null {
  if (freeText === false) return null;
  if (freeText === true) return hasOptions ? OWN_ANSWER : ANSWER;
  return freeText;
}
