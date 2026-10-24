// Pure logic behind the project settings page: the readiness checklist's
// layout, the access table's cell labels and click cycle, and the copy of
// the "Default" / "Set here" chips. Kept apart from the components so it is
// testable without rendering.

import {
  READINESS_STEP_IDS,
  READINESS_TOTAL,
  type AccessCellChange,
  type AccessCellValue,
  type AccessCellView,
  type AccessRowKey,
  type EffectiveSandbox,
  type ProjectReadiness,
  type ReadinessStep,
  type RunPlace,
  type UnattendedRole,
} from "../../../shared/project-settings";

export const PROJECT_SECTIONS = [
  ["where", "Where agents run"],
  ["models", "Models"],
  ["production", "Production"],
  ["access", "What agents may use"],
  ["incidents", "Incidents"],
] as const;
export type ProjectSectionId = (typeof PROJECT_SECTIONS)[number][0];

export function isProjectSectionId(v: unknown): v is ProjectSectionId {
  return PROJECT_SECTIONS.some(([id]) => id === v);
}

export type SegmentState = "ready" | "todo" | "blocked";

export interface ChecklistModel {
  title: string;
  /** The count under a blocked title; `null` when the title already says it. */
  subtitle: string | null;
  /** One per step, in step order, so a red segment sits where its step is. */
  segments: SegmentState[];
  /** The step whose fix is the screen's one ink button. */
  primary: ReadinessStep | null;
  /** The steps shown in full. */
  rows: ReadinessStep[];
  /** While blocked, the other to-dos fold into "N more to do". */
  collapsedTodo: ReadinessStep[];
  collapsedReady: ReadinessStep[];
}

function blockedTitle(step: ReadinessStep): string {
  if (step.id === "paused") return "Agents are paused";
  if (step.id === "where") return "Agents can't start: no sandbox";
  return `Agents can't start: ${lowerFirst(step.title)}`;
}

export function checklistModel(
  r: ProjectReadiness,
  project: string,
): ChecklistModel {
  const segments = READINESS_STEP_IDS.map((id): SegmentState => {
    const step = r.steps.find((s) => s.id === id);
    return step?.state ?? "todo";
  });
  const ready = r.steps.filter((s) => s.state === "ready" && s.id !== "paused");
  const open = r.steps.filter((s) => s.state !== "ready");
  const count = `${r.readyCount} of ${READINESS_TOTAL} ready`;
  if (r.blocking) {
    const blocking = r.blocking;
    return {
      title: blockedTitle(blocking),
      subtitle: `Incidents for ${project}: ${count}`,
      segments,
      primary: blocking,
      rows: [blocking],
      collapsedTodo: open.filter((s) => s.id !== blocking.id),
      collapsedReady: ready,
    };
  }
  const allReady = open.length === 0;
  return {
    title: allReady
      ? `Incidents for ${project}: ready`
      : `Incidents for ${project}: ${count}`,
    subtitle: null,
    segments,
    primary: open[0] ?? null,
    rows: open,
    collapsedTodo: [],
    collapsedReady: ready,
  };
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "Models, where agents run, production, signals". */
export function stepSummary(steps: ReadinessStep[]): string {
  const out = steps.map((s, i) => (i === 0 ? s.title : lowerFirst(s.title)));
  return out.join(", ");
}

const CELL_LABELS: Record<AccessCellValue, string> = {
  yes: "✓",
  no: "–",
  blocked: "–",
  branch: "Branch",
  read: "Read only",
  "ask-once": "Ask once",
  "ask-each": "Ask each time",
  standing: "Always",
  locked: "Not allowed",
};

/** What a cell shows. `locked` renders as a lock icon carrying this as its
 *  accessible name. */
export function cellLabel(v: AccessCellValue): string {
  return CELL_LABELS[v];
}

/** What a cell is called to a screen reader: words, never a symbol. */
export function cellSpokenLabel(v: AccessCellValue): string {
  if (v === "yes") return "Yes";
  if (v === "no") return "No";
  if (v === "blocked") return "Blocked";
  return CELL_LABELS[v];
}

/** Whether a cell is on, for `aria-pressed` and the phone checkmark. */
export function cellIsOn(v: AccessCellValue): boolean {
  return v !== "no" && v !== "locked" && v !== "blocked";
}

/** Whether clicking the cell flips a boolean (so it gets `aria-pressed`). */
export function rowIsBoolean(row: AccessRowKey): boolean {
  return row.kind !== "mode" && row.kind !== "credential";
}

function isIncidentRole(role: UnattendedRole): boolean {
  return role === "investigator" || role === "verifier";
}

/** The change a click on a cell makes, or `null` when it can't change. */
export function nextCellValue(
  row: AccessRowKey,
  role: UnattendedRole,
  current: AccessCellView,
): AccessCellChange | null {
  if (!current.editable) return null;
  const change = (value: AccessCellChange["value"]): AccessCellChange => ({
    row,
    role,
    value,
  });
  switch (row.kind) {
    case "mode":
      return change(current.value === "read" ? "code" : "ask");
    case "credential":
      if (!isIncidentRole(role)) return null;
      if (current.value === "no") return change("once");
      if (current.value === "ask-once") return change("standing");
      return change(null);
    case "host":
      if (!isIncidentRole(role)) return null;
      return change(current.value === "no");
    case "webSearch":
      if (role === "verifier") return null;
      return change(current.value === "no");
    case "website":
    case "connection":
      return change(current.value === "no");
  }
}

export type SettingChip = "Default" | "Set here";

export function modelChip(source: "project" | "default"): SettingChip {
  return source === "project" ? "Set here" : "Default";
}

function defaultLabel(e: EffectiveSandbox): string | null {
  const places: RunPlace[] = [
    e.you,
    e.automations,
    e.incidentAgents,
    e.reviews,
  ];
  for (const p of places) {
    if (p.state === "ok" && p.source === "default") return p.label;
  }
  return null;
}

/** Nothing unattended could fall back to a default: automations land on
 *  this machine without one, or incident agents can't start. */
function nothingToFallBackTo(e: EffectiveSandbox): boolean {
  return (
    e.incidentAgents.state === "cant-start" ||
    (e.automations.state === "ok" && e.automations.source === "fallback")
  );
}

export function sandboxRowCopy(e: EffectiveSandbox): {
  description: string;
  chip: SettingChip;
} {
  const chip: SettingChip =
    e.you.state === "ok" && e.you.source === "default" ? "Default" : "Set here";
  const fallback = defaultLabel(e);
  if (chip === "Default") {
    const label = e.you.state === "ok" ? e.you.label : fallback;
    return {
      chip,
      description: label
        ? `Uses the global default, ${label}`
        : "Uses the global default",
    };
  }
  const head = "Every run uses this when it can.";
  if (fallback)
    return { chip, description: `${head} Global default is ${fallback}` };
  if (nothingToFallBackTo(e)) {
    return { chip, description: `${head} No global default is set` };
  }
  return { chip, description: head.slice(0, -1) };
}
