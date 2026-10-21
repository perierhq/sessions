// Incident actions as the settings edit them: labels, ids, templates, the
// badges a row shows, and the draft the action dialog holds. Mirrors the
// server's action validation (incidents/response/project-settings.ts) so a
// save is rarely refused.

import {
  ACTION_PLACEHOLDERS,
  ACTION_TEMPLATES,
  type ActionKind,
  type ActionTemplateName,
  type IncidentAction,
} from "../../../shared/incident-response";
import { formatUsd } from "./copy";

export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  rollback: "Roll back",
  deploy: "Deploy",
  pause: "Pause",
  "run-once": "Run once",
};

export const TEMPLATE_LABELS: Record<ActionTemplateName, string> = {
  "docker-compose": "Docker Compose",
  systemd: "systemd",
  script: "A script",
};

export const TEMPLATE_NAMES: ActionTemplateName[] = [
  "docker-compose",
  "systemd",
  "script",
];

export function templateNamed(name: string): ActionTemplateName | null {
  return TEMPLATE_NAMES.find((t) => t === name) ?? null;
}

/** The placeholders a command may use, as a sentence fragment. */
export const PLACEHOLDER_LIST = ACTION_PLACEHOLDERS.map((p) => `{{${p}}}`).join(
  ", ",
);

export const ACTION_TIMEOUT_CHOICES = [1, 5, 10, 30, 60].map(
  (minutes) => minutes * 60_000,
);

const ID_MAX = 40;
const LABEL_MAX = 60;
const COMMAND_MAX = 4000;
const USD_MAX = 100_000;
const QUOTED = "Keep placeholders outside quotes. Sessions quotes their values";

/** A lower-case slug of the label, unique among `taken`. */
export function actionIdFrom(label: string, taken: string[]): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, ID_MAX)
      .replace(/-+$/, "") || "action";
  if (!taken.includes(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${slug.slice(0, ID_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.includes(id)) return id;
  }
}

export function newAction(
  kind: ActionKind,
  runner: string,
  taken: string[],
): IncidentAction {
  const label = ACTION_KIND_LABELS[kind];
  return {
    id: actionIdFrom(label, taken),
    kind,
    label,
    runner,
    command: "",
    timeoutMs: 600_000,
    reversible: kind !== "run-once",
    cost: { kind: "none" },
    needsSecret: false,
    scope: { services: [], paths: [], migrationPaths: [] },
  };
}

/** The template's command for the action's kind; unchanged without one. */
export function applyTemplate<
  A extends Pick<IncidentAction, "kind" | "command" | "reversible">,
>(action: A, template: ActionTemplateName): A {
  const preset = ACTION_TEMPLATES[template][action.kind];
  return preset
    ? { ...action, command: preset.command, reversible: preset.reversible }
    : action;
}

export function actionBadges(
  action: Pick<IncidentAction, "reversible" | "cost" | "needsSecret">,
): Array<{ text: string; tone: "neutral" | "warning" }> {
  const badges: Array<{ text: string; tone: "neutral" | "warning" }> = [
    action.reversible
      ? { text: "Can be undone", tone: "neutral" }
      : { text: "Can't be undone", tone: "warning" },
  ];
  if (action.cost.kind === "amount")
    badges.push({
      text: `Costs ${formatUsd(action.cost.usd)}`,
      tone: "warning",
    });
  if (action.needsSecret)
    badges.push({ text: "Needs a secret", tone: "warning" });
  return badges;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PLACEHOLDER_AT = /\{\{[^{}]*\}\}/y;

/** The `{{name}}`s in a command, each once, split by whether Sessions
 *  fills them. */
export interface PlaceholderUse {
  known: string[];
  unknown: string[];
}

export function placeholdersIn(command: string): PlaceholderUse {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const match of command.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    const list = ACTION_PLACEHOLDERS.some((p) => p === name) ? known : unknown;
    if (!list.includes(name)) list.push(name);
  }
  return { known, unknown };
}

/** Whether a `{{name}}` sits inside single or double quotes (the server's
 *  rule: Sessions quotes every value itself). */
function placeholderInQuotes(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      PLACEHOLDER_AT.lastIndex = i;
      if (PLACEHOLDER_AT.test(command)) return true;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return false;
}

/** What is wrong with a command's placeholders, or null. */
export function commandProblem(command: string): string | null {
  const { unknown } = placeholdersIn(command);
  if (unknown.length) return `Unknown placeholder {{${unknown[0]}}}`;
  if (placeholderInQuotes(command)) return QUOTED;
  return null;
}

export function firstLine(command: string): string {
  return (
    command
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/** The action dialog's state: the action with its numbers and lists as
 *  typed. `isNew` actions take their id from the label on save. */
export interface ActionDraft {
  id: string;
  isNew: boolean;
  kind: ActionKind;
  label: string;
  runner: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  reversible: boolean;
  costs: boolean;
  usd: string;
  needsSecret: boolean;
  services: string;
  paths: string;
  migrationPaths: string;
}

export type ActionField = "label" | "runner" | "command" | "cwd" | "usd";

export function draftFromAction(
  action: IncidentAction,
  isNew: boolean,
): ActionDraft {
  return {
    id: action.id,
    isNew,
    kind: action.kind,
    label: action.label,
    runner: action.runner,
    command: action.command,
    cwd: action.cwd ?? "",
    timeoutMs: action.timeoutMs,
    reversible: action.reversible,
    costs: action.cost.kind === "amount",
    usd: action.cost.kind === "amount" ? String(action.cost.usd) : "",
    needsSecret: action.needsSecret,
    services: action.scope.services.join(", "),
    paths: action.scope.paths.join(", "),
    migrationPaths: action.scope.migrationPaths.join(", "),
  };
}

function globs(text: string): string[] {
  return text
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);
}

/** The action to save, or the first field that is wrong. `actions` is the
 *  project's list as stored (the draft's own entry included when it is
 *  being edited). */
export function draftToAction(
  draft: ActionDraft,
  actions: IncidentAction[],
): { action: IncidentAction } | { field: ActionField; error: string } {
  const label = draft.label.trim();
  if (!label) return { field: "label", error: "Give the action a name" };
  if (label.length > LABEL_MAX)
    return { field: "label", error: "Keep the name under 60 characters" };
  if (!draft.runner)
    return { field: "runner", error: "Pick the host it runs on" };
  if (!draft.command.trim())
    return { field: "command", error: "Enter the command to run" };
  if (draft.command.length > COMMAND_MAX)
    return {
      field: "command",
      error: "Keep the command under 4000 characters",
    };
  const problem = commandProblem(draft.command);
  if (problem) return { field: "command", error: problem };
  const cwd = draft.cwd.trim();
  if (cwd && !cwd.startsWith("/"))
    return { field: "cwd", error: "Use an absolute path, like /srv/app" };
  let usd = 0;
  if (draft.costs) {
    const text = draft.usd.trim().replace(/^\$/, "");
    usd = /^\d+(\.\d{1,2})?$/.test(text) ? Number(text) : 0;
    if (!(usd > 0)) return { field: "usd", error: "Enter an amount over $0" };
    if (usd > USD_MAX) return { field: "usd", error: "Enter at most $100000" };
  }
  const id = draft.isNew
    ? actionIdFrom(
        label,
        actions.map((a) => a.id),
      )
    : draft.id;
  const action: IncidentAction = {
    id,
    kind: draft.kind,
    label,
    runner: draft.runner,
    command: draft.command,
    timeoutMs: draft.timeoutMs,
    reversible: draft.reversible,
    cost: draft.costs ? { kind: "amount", usd } : { kind: "none" },
    needsSecret: draft.needsSecret,
    scope: {
      services: globs(draft.services),
      paths: globs(draft.paths),
      migrationPaths: globs(draft.migrationPaths),
    },
  };
  if (cwd) action.cwd = cwd;
  return { action };
}

/** The list with `action` in its place, or appended. */
export function withAction(
  actions: IncidentAction[],
  action: IncidentAction,
): IncidentAction[] {
  return actions.some((a) => a.id === action.id)
    ? actions.map((a) => (a.id === action.id ? action : a))
    : [...actions, action];
}

export function withoutAction(
  actions: IncidentAction[],
  id: string,
): IncidentAction[] {
  return actions.filter((a) => a.id !== id);
}

/** Why a host cannot leave the project: an action still runs on it. */
export function runnerInUse(
  actions: IncidentAction[],
  runner: string,
): string | null {
  const using = actions.find((a) => a.runner === runner);
  return using
    ? `${using.label} runs on this host. Move it to another host first`
    : null;
}

/** Kinds a project may hold once, taken by another of its actions. */
export function takenKinds(
  actions: IncidentAction[],
  ownId: string,
): ActionKind[] {
  return actions
    .filter(
      (a) => a.id !== ownId && (a.kind === "deploy" || a.kind === "rollback"),
    )
    .map((a) => a.kind);
}

/** Another kind for the draft. A label or command still as the old kind's
 *  default (its label, or `template`'s command) follows the new kind;
 *  anything typed stays. */
export function switchActionKind(
  draft: ActionDraft,
  kind: ActionKind,
  template: ActionTemplateName | null,
): ActionDraft {
  const label =
    draft.label.trim() === ACTION_KIND_LABELS[draft.kind]
      ? ACTION_KIND_LABELS[kind]
      : draft.label;
  const preset = template ? ACTION_TEMPLATES[template] : null;
  const commandIsPreset =
    !draft.command.trim() ||
    (preset !== null && preset[draft.kind]?.command === draft.command);
  const next = { ...draft, kind, label };
  if (commandIsPreset && preset?.[kind])
    return {
      ...next,
      command: preset[kind].command,
      reversible: preset[kind].reversible,
    };
  return commandIsPreset && !draft.command.trim()
    ? { ...next, reversible: kind !== "run-once" }
    : next;
}
