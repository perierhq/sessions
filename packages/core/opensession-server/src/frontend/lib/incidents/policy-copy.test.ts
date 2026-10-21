import { expect, test } from "bun:test";
import type { RedactedProjectSettings } from "../../../shared/incident-response";
import { formatTimeOfDay } from "../time-of-day";
import {
  AUTONOMY_COPY,
  minutesOptions,
  NEVER_COPY,
  nightDescription,
  parseUsd,
  patchSettings,
  projectSummary,
  withCurrent,
} from "./policy-copy";

test("night description", () => {
  expect(
    nightDescription({
      start: "23:00",
      end: "07:00",
      timeZone: "Europe/Warsaw",
    }),
  ).toBe(
    `From ${formatTimeOfDay("23:00")} to ${formatTimeOfDay("07:00")}, fixes wait for you unless the signal is fully down`,
  );
  expect(nightDescription(undefined)).toBe("Fixes can wait for you overnight");
});

test("minute options", () => {
  expect(minutesOptions([600_000])).toEqual([
    { value: "600000", label: "10 min" },
  ]);
  expect(minutesOptions([60_000, 3_600_000]).map((o) => o.label)).toEqual([
    "1 min",
    "60 min",
  ]);
});

/** Settings with only the fields a helper reads. */
function partial(fields: Partial<RedactedProjectSettings>) {
  // SAFETY: the helpers under test read only the fields each test passes.
  return fields as RedactedProjectSettings;
}

test("project summary", () => {
  expect(
    projectSummary(partial({ autonomy: "propose", agentsPaused: true }), 1),
  ).toBe("1 signal · Propose · paused");
  expect(
    projectSummary(
      partial({ autonomy: "deploy-after-veto", agentsPaused: false }),
      3,
    ),
  ).toBe("3 signals · Deploy after veto");
  expect(projectSummary(null, 3)).toBe("3 signals");
  expect(projectSummary(null, 0)).toBe("No signals");
});

test("copy covers every level and item, sentence case, no periods", () => {
  for (const { label, description } of Object.values(AUTONOMY_COPY)) {
    expect(label[0]).toBe(label[0]!.toUpperCase());
    expect(description.endsWith(".")).toBe(false);
  }
  expect(NEVER_COPY["costs-money"]).toBe("Spending money");
  expect(Object.keys(NEVER_COPY)).toHaveLength(5);
});

test("patching settings applies and clears the night rule", () => {
  const night = { start: "23:00", end: "07:00", timeZone: "UTC" };
  const before = partial({ autonomy: "propose", night });
  expect(patchSettings(before, { autonomy: "watch" })).toMatchObject({
    autonomy: "watch",
    night,
  });
  expect(patchSettings(before, { night: null }).night).toBeUndefined();
  expect(before.night).toBe(night);
});

test("patching role models merges like the server", () => {
  const before = partial({
    agents: { investigatorModel: "pi/a/x", verifierModel: "pi/b/y" },
  });
  expect(
    patchSettings(before, { agents: { verifierModel: null } }).agents,
  ).toEqual({ investigatorModel: "pi/a/x" });
  expect(
    patchSettings(before, { agents: { investigatorModel: "pi/c/z" } }).agents,
  ).toEqual({ investigatorModel: "pi/c/z", verifierModel: "pi/b/y" });
});

test("budget amounts", () => {
  expect(parseUsd("20", 0.5, 1000)).toBe(20);
  expect(parseUsd("$6.50", 0.5, 1000)).toBe(6.5);
  expect(parseUsd("0.1", 0.5, 1000)).toBeNull();
  expect(parseUsd("1e3", 0.5, 1000)).toBeNull();
  expect(parseUsd("", 0.5, 1000)).toBeNull();
});

test("a stored value outside the choices stays selectable", () => {
  expect(withCurrent([1, 5], 3)).toEqual([1, 3, 5]);
  expect(withCurrent([1, 5], 5)).toEqual([1, 5]);
});
