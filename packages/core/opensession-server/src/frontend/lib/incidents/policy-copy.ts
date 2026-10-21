// What the incident settings say about a project's policy: autonomy levels,
// the "never without you" items, window lengths, the night rule and the
// one-line project summary. Sentence case, no trailing periods. Pure.
import type {
  AutonomyLevel,
  NeverWithoutYou,
  NightRule,
  RedactedProjectSettings,
} from "../../../shared/incident-response";
import type { ProjectSettingsInput } from "../api/incidents";
import { formatTimeOfDay } from "../time-of-day";

export const AUTONOMY_COPY: Record<
  AutonomyLevel,
  { label: string; description: string }
> = {
  watch: { label: "Watch", description: "Agents only look and report" },
  propose: {
    label: "Propose",
    description: "Agents prepare a fix and wait for you",
  },
  "deploy-after-veto": {
    label: "Deploy after veto",
    description: "You get a window to stop each change",
  },
  "deploy-right-away": {
    label: "Deploy right away",
    description: "A verified fix goes out as soon as the verifier is certain",
  },
};

export const NEVER_COPY: Record<NeverWithoutYou, string> = {
  "costs-money": "Spending money",
  "needs-secret": "Secrets",
  migration: "Database migrations",
  "outside-scope": "Changes outside an action's scope",
  "not-reversible": "Changes that can't be undone",
};

const MINUTE_MS = 60_000;

/** Window lengths the selects offer, in ms (server bounds: 1 to 60 min). */
export const VETO_CHOICES = [1, 5, 10, 15, 30, 60].map((m) => m * MINUTE_MS);
export const WATCH_CHOICES = [5, 10, 15, 30, 60].map((m) => m * MINUTE_MS);
export const ROUND_CHOICES = [1, 2, 3, 4, 5];

/** `600000` → `{ value: "600000", label: "10 min" }`. */
export function minutesOptions(
  values: number[],
): Array<{ value: string; label: string }> {
  return values.map((ms) => ({
    value: String(ms),
    label: `${Math.round(ms / MINUTE_MS)} min`,
  }));
}

/** The choices plus the stored value when it is not one of them, so a
 *  value set elsewhere still shows as itself. */
export function withCurrent(values: number[], current: number): number[] {
  return values.includes(current)
    ? values
    : [...values, current].sort((a, b) => a - b);
}

export function nightDescription(night: NightRule | undefined): string {
  if (!night) return "Off";
  return `From ${formatTimeOfDay(night.start)} to ${formatTimeOfDay(night.end)}, fixes wait for you unless the signal is fully down`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A project's row on the Incidents settings index: `3 signals · Deploy
 *  after veto`, `· paused` when its agents are paused. */
export function projectSummary(
  settings: RedactedProjectSettings | null,
  signalCount: number,
): string {
  const parts = [signalCount ? plural(signalCount, "signal") : "No signals"];
  if (settings) {
    parts.push(AUTONOMY_COPY[settings.autonomy].label);
    if (settings.agentsPaused) parts.push("paused");
  }
  return parts.join(" · ");
}

/** The settings as they will be once `input` is saved: what a row shows
 *  while the save is on its way. */
export function patchSettings(
  settings: RedactedProjectSettings,
  input: ProjectSettingsInput,
): RedactedProjectSettings {
  const { night, ...rest } = input;
  const next: RedactedProjectSettings = { ...settings, ...rest };
  if (night === null) delete next.night;
  else if (night) next.night = night;
  return next;
}

/** A budget amount in dollars, as typed: a number within the bounds, at
 *  most two decimals; anything else is null. */
export function parseUsd(
  text: string,
  min: number,
  max: number,
): number | null {
  const trimmed = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= min && n <= max ? n : null;
}
