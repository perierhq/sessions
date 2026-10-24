// Pure logic behind the project settings page: the readiness checklist's
// layout, the access table's cell labels and click cycle, and the copy of
// the "Default" / "Set here" chips. Kept apart from the components so it is
// testable without rendering.

import {
  INCIDENT_AGENTS_LABEL,
  PROJECT_ROLES,
  READINESS_STEP_IDS,
  READINESS_TOTAL,
  type AccessCellChange,
  type AccessCellValue,
  type AccessCellView,
  type AccessRowKey,
  type AccessRowView,
  type AccessTableView,
  type EffectiveSandbox,
  type ProjectReadiness,
  type ProjectRole,
  type ProjectSettingsPatch,
  type ProjectSettingsView,
  type ReadinessFix,
  type ReadinessStep,
  type RunPlace,
  type UnattendedRole,
} from "../../../shared/project-settings";
import { formatUsd } from "../incidents/copy";

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
  /** One per step, in the rows' order, so a red segment sits where its
   *  step is. */
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
  const ready = r.steps.filter((s) => s.state === "ready" && s.id !== "paused");
  const open = r.steps.filter((s) => s.state !== "ready");
  // In the order the rows read: the blocking step, the other to-dos, then
  // the ready ones. A step the server didn't send counts as a to-do.
  const isStep = (s: ReadinessStep) =>
    READINESS_STEP_IDS.some((id) => id === s.id);
  const missing = READINESS_STEP_IDS.filter(
    (id) => !r.steps.some((s) => s.id === id),
  );
  const todo = [
    ...(r.blocking ? [r.blocking] : []),
    ...open.filter((s) => s.id !== r.blocking?.id),
  ].filter(isStep);
  const segments: SegmentState[] = [
    ...todo.map((s) => s.state),
    ...missing.map((): SegmentState => "todo"),
    ...ready.filter(isStep).map((s) => s.state),
  ];
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
  elsewhere: "Set elsewhere",
};

/** What a cell shows. `locked` renders as a lock icon carrying this as its
 *  accessible name; an `elsewhere` cell reads its own `label`. */
export function cellLabel(v: AccessCellValue, label?: string): string {
  if (v === "elsewhere" && label) return label;
  return CELL_LABELS[v];
}

/** What a cell is called to a screen reader: words, never a symbol. */
export function cellSpokenLabel(v: AccessCellValue, label?: string): string {
  if (v === "yes") return "Yes";
  if (v === "no") return "No";
  if (v === "blocked") return "Blocked";
  return cellLabel(v, label);
}

/** Whether a cell is on, for `aria-pressed`, the phone checkmark and a
 *  row's count. Read only is the "Changes code" row's off value. */
export function cellIsOn(v: AccessCellValue): boolean {
  return (
    v !== "no" &&
    v !== "locked" &&
    v !== "blocked" &&
    v !== "read" &&
    v !== "elsewhere"
  );
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

/** The sandbox row's description and chip. */
export interface SandboxRowCopy {
  description: string;
  chip: SettingChip;
}

export function sandboxRowCopy(e: EffectiveSandbox): SandboxRowCopy {
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

/** Two access table rows are the same row. */
export function sameRowKey(a: AccessRowKey, b: AccessRowKey): boolean {
  switch (a.kind) {
    case "mode":
    case "webSearch":
      return b.kind === a.kind;
    case "connection":
      return b.kind === "connection" && b.server === a.server;
    case "credential":
      return b.kind === "credential" && b.credential === a.credential;
    case "website":
      return b.kind === "website" && b.host === a.host;
    case "host":
      return (
        b.kind === "host" &&
        b.runner === a.runner &&
        (b.ssh ?? "") === (a.ssh ?? "")
      );
  }
}

/** A stable string for a row, for React keys. */
export function rowKeyId(key: AccessRowKey): string {
  switch (key.kind) {
    case "mode":
    case "webSearch":
      return key.kind;
    case "connection":
      return `connection:${key.server}`;
    case "credential":
      return `credential:${key.credential}`;
    case "website":
      return `website:${key.host}`;
    case "host":
      return `host:${key.runner}:${key.ssh ?? ""}`;
  }
}

/** What a cell will read once the change lands, for the optimistic view. */
export function cellAfter(
  row: AccessRowView,
  change: AccessCellChange,
): AccessCellValue {
  const { value, role } = change;
  if (value === true) return row.warning ? "blocked" : "yes";
  if (value === false || value === null) return "no";
  if (value === "code") return isIncidentRole(role) ? "branch" : "yes";
  if (value === "ask") return "read";
  if (value === "once") return "ask-once";
  return "standing";
}

/** The view with a cell change applied, before the server answers. */
export function applyCellChange<
  V extends { access: { groups: AccessTableView["groups"] } },
>(view: V, change: AccessCellChange): V {
  const groups = view.access.groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) =>
      sameRowKey(row.key, change.row)
        ? {
            ...row,
            cells: {
              ...row.cells,
              [change.role]: {
                ...row.cells[change.role],
                value: cellAfter(row, change),
              },
            },
          }
        : row,
    ),
  }));
  return { ...view, access: { ...view.access, groups } };
}

/** The view with an incident policy patch laid over it, for the paint
 *  before the server answers. `night: null` clears the night rule. */
export function applyIncidentsPatch(
  view: ProjectSettingsView,
  patch: NonNullable<ProjectSettingsPatch["incidents"]>,
): ProjectSettingsView {
  const { night, ...rest } = patch;
  const incidents = { ...view.document.incidents, ...rest };
  if (night === null) delete incidents.night;
  else if (night) incidents.night = night;
  return { ...view, document: { ...view.document, incidents } };
}

/** The role an arrow, Home or End key moves a role radio group to, wrapping
 *  at the ends; `null` for any other key. */
export function roleForKey(
  current: ProjectRole,
  key: string,
): ProjectRole | null {
  const i = PROJECT_ROLES.indexOf(current);
  const n = PROJECT_ROLES.length;
  if (key === "ArrowRight" || key === "ArrowDown")
    return PROJECT_ROLES[(i + 1) % n]!;
  if (key === "ArrowLeft" || key === "ArrowUp")
    return PROJECT_ROLES[(i - 1 + n) % n]!;
  if (key === "Home") return PROJECT_ROLES[0]!;
  if (key === "End") return PROJECT_ROLES[n - 1]!;
  return null;
}

/** "4 of 5 roles": how many roles a row is on for, You included. */
export function rowSummary(row: AccessRowView): string {
  const on = PROJECT_ROLES.filter((role) => cellIsOn(row.cells[role].value));
  if (on.length === PROJECT_ROLES.length) return "Every role";
  if (on.length === 0) return "No role";
  return `${on.length} of ${PROJECT_ROLES.length} roles`;
}

/** A label with its middle dots held to both neighbours, so a narrow
 *  column wraps between words and never leaves "·" at a line's edge. */
export function joinDots(label: string): string {
  return label.replaceAll(" · ", "\u00a0·\u00a0");
}

/** The 4 places in the "Where agents run" grid, in the design's order. */
export const RUN_PLACES = [
  ["you", "You"],
  ["reviews", "Reviews"],
  ["automations", "Automations"],
  ["incidentAgents", INCIDENT_AGENTS_LABEL],
] as const;

/** The words on a step's fix button. */
export function fixLabel(fix: ReadinessFix): string {
  switch (fix.kind) {
    case "providers":
      return "Add a model provider";
    case "connect-sandbox":
      return "Connect a sandbox";
    case "pair-runner":
      return "Pair a Runner";
    case "add-signal":
      return "Add a signal";
    case "add-action":
      return fix.action === "rollback" ? "Add rollback" : "Add deploy";
    case "allow-agents":
      return "Allow agents";
    case "unpause":
      return "Resume agents";
  }
}

const PROVIDER_NAMES = new Map([
  ["daytona", "Daytona"],
  ["box", "Boat"],
  ["tart", "Mac VM"],
  ["usecomputer", "use.computer"],
  ["podman", "This machine · container"],
]);

/** A sandbox provider by name, with its region when it has one
 *  ("Daytona eu"). `none` and `local` are this machine. */
export function sandboxName(id: string, region?: string): string {
  if (id === "none" || id === "local" || id === "") return "This machine";
  const name = PROVIDER_NAMES.get(id) ?? id;
  return region && id !== "podman" ? `${name} ${region}` : name;
}

/** The project's sandbox choices: the default, this machine, the
 *  container when it is ready, and each other ready provider. The current
 *  choice stays listed even when it is no longer ready. */
export function sandboxOptions(opts: {
  ready: string[];
  current: string;
  defaultLabel: string | null;
  regions?: Record<string, string | undefined>;
}): Array<{ value: string; label: string }> {
  const out = [
    {
      value: "default",
      label: opts.defaultLabel
        ? `Use default (${opts.defaultLabel})`
        : "Use default",
    },
    { value: "local", label: "This machine" },
  ];
  const providers = [...opts.ready];
  if (
    opts.current !== "default" &&
    opts.current !== "local" &&
    !providers.includes(opts.current)
  )
    providers.push(opts.current);
  // The container sits beside this machine, then the remote providers.
  providers.sort((a, b) => Number(b === "podman") - Number(a === "podman"));
  for (const id of providers)
    out.push({ value: id, label: sandboxName(id, opts.regions?.[id]) });
  return out;
}

/** The previews choices: beside the session, or a provider of their own. */
export function previewsOptions(opts: {
  ready: string[];
  current: string;
  regions?: Record<string, string | undefined>;
}): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  if (opts.current === "default")
    out.push({ value: "default", label: "Use default" });
  out.push({ value: "same", label: "Same as agents" });
  const providers = opts.ready.filter((id) => id !== "podman");
  if (
    !["default", "same"].includes(opts.current) &&
    !providers.includes(opts.current)
  )
    providers.push(opts.current);
  for (const id of providers)
    out.push({ value: id, label: sandboxName(id, opts.regions?.[id]) });
  return out;
}

/** The region a new Daytona connection starts with: the one nearest the
 *  browser's time zone. */
export function nearestRegion(timeZone: string): "eu" | "us" {
  return timeZone.startsWith("America/") ? "us" : "eu";
}

/** "$6.50 spent in October". */
export function monthSpendCopy(usd: number, now: Date): string {
  const month = now.toLocaleString("en", { month: "long" });
  return `${formatUsd(usd)} spent in ${month}`;
}

/** The deploy row's caption: the timeout in minutes. */
export function timeoutCopy(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} min limit`;
}

/** A long command with its middle dropped, both ends kept. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** A cell's colour: ink when on, faint when off, amber when blocked. */
export function cellTone(v: AccessCellValue): string {
  if (v === "blocked") return "text-yellow";
  if (v === "yes") return "text-fg";
  if (v === "no" || v === "locked") return "text-faint";
  return "text-dim";
}

/** The DOM id a section is anchored at. */
export function sectionAnchorId(id: ProjectSectionId): string {
  return `project-${id}`;
}
