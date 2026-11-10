// The project page's Lead section: copy and the optimistic patch for the
// `lead` block (shared/project-lead.ts). Pure, so the page and its tests
// share one reading of the stored charter.

import {
  LEAD_CATEGORIES,
  LEAD_CATEGORY_LABELS,
  type LeadCategory,
  type LeadLevel,
  type LeadStage,
  type ProjectLeadPatch,
  type ProjectLeadSettings,
  isPinnedOnlyYou,
  leadLevel,
} from "../../../shared/project-lead";
import type { ProjectSettingsView } from "../../../shared/project-settings";
import { ApiError } from "../api/request";
import { errorMessage } from "../error-message";
import { isStaleRevision, STALE_SETTINGS_MESSAGE } from "./save";

export const LEAD_STAGE_OPTIONS: readonly {
  value: LeadStage;
  label: string;
  help: string;
}[] = [
  {
    value: "watch",
    label: "Watch",
    help: "Reads and proposes, changes nothing",
  },
  {
    value: "coordinate",
    label: "Coordinate",
    help: "Also starts fixes as pull requests",
  },
  { value: "act", label: "Act", help: "Does what you allow without asking" },
];

export const LEAD_LEVEL_OPTIONS: { value: LeadLevel; label: string }[] = [
  { value: "alone", label: "Alone" },
  { value: "asks-first", label: "Asks first" },
  { value: "only-you", label: "Only you" },
];

export function leadStageHelp(stage: LeadStage): string {
  return LEAD_STAGE_OPTIONS.find((o) => o.value === stage)?.help ?? "";
}

export interface LeadRuleRow {
  category: LeadCategory;
  label: string;
  level: LeadLevel;
  /** Always only you, whatever the settings say. */
  pinned: boolean;
}

/** One row per category, in the shared order, pinned ones read as only you. */
export function leadRuleRows(lead: ProjectLeadSettings): LeadRuleRow[] {
  return LEAD_CATEGORIES.map((category) => ({
    category,
    label: LEAD_CATEGORY_LABELS[category],
    level: leadLevel(lead.rules, category),
    pinned: isPinnedOnlyYou(category),
  }));
}

/** Whether the lead is running: on and holding its goal. */
export function leadStatus(lead: ProjectLeadSettings): "running" | "off" {
  return lead.enabled && lead.goalId ? "running" : "off";
}

/** `view` with a lead patch applied, for painting before the server answers. */
export function applyLeadPatch(
  view: ProjectSettingsView,
  patch: ProjectLeadPatch,
): ProjectSettingsView {
  const { owner, rules, ...rest } = patch;
  const lead: ProjectLeadSettings = {
    ...view.document.lead,
    ...rest,
    rules: { ...view.document.lead.rules, ...rules },
  };
  if (owner === null) delete lead.owner;
  else if (owner !== undefined) lead.owner = owner;
  return { ...view, document: { ...view.document, lead } };
}

/** The server's refusal, as the section shows it. A 403 carries the
 *  server's own reason (only the instance owner or the lead's owner may
 *  give the lead more room). */
export function leadSaveErrorText<Rejected>(error: Rejected): string {
  if (isStaleRevision(error)) return STALE_SETTINGS_MESSAGE;
  if (error instanceof ApiError && error.status === 403)
    return errorMessage(
      error,
      "Only the instance owner or the lead's owner can give the lead more room",
    );
  return errorMessage(error, "Couldn't save the setting");
}
