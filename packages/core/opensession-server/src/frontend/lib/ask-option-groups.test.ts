import { expect, test } from "bun:test";
import { freeTextField, optionRuns } from "./ask-option-groups";

const q = {
  question: "Next?",
  options: ["A", "B", "C", "D"].map((label) => ({ label })),
};
const labels = (runs: ReturnType<typeof optionRuns>) =>
  runs.map((r) => r.options.map((o) => o.label));

test("no groups is one run, drawn as before", () => {
  expect(optionRuns(q, undefined)).toEqual([
    { options: q.options, grouped: false, quiet: false },
  ]);
  expect(optionRuns(q, [])).toHaveLength(1);
});

test("groups split the options in order, the last takes the rest", () => {
  const runs = optionRuns(q, [
    { label: "Suggested", count: 1 },
    { count: 1, quiet: true },
  ]);
  expect(labels(runs)).toEqual([["A"], ["B", "C", "D"]]);
  expect(runs[0]).toMatchObject({
    grouped: true,
    quiet: false,
    label: "Suggested",
  });
  expect(runs[1]).toMatchObject({ grouped: true, quiet: true });
  expect(runs[1]).not.toHaveProperty("label");
});

test("an empty run is left out", () => {
  expect(
    labels(optionRuns(q, [{ label: "Suggested", count: 0 }, { count: 4 }])),
  ).toEqual([["A", "B", "C", "D"]]);
});

test("the typed-answer field: off, the default with or without options, or named", () => {
  expect(freeTextField(false, true)).toBeNull();
  expect(freeTextField(true, true)?.placeholder).toBe(
    "Or type your own answer…",
  );
  expect(freeTextField(true, false)).toEqual({
    label: "Answer",
    placeholder: "Type your answer…",
  });
  const named = { label: "Tell the investigator", placeholder: "Tell…" };
  expect(freeTextField(named, true)).toBe(named);
});
