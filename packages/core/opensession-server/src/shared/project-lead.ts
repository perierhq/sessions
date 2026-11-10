// The project lead's charter, as the `lead` block of a project's settings
// document (adrs/supervisor-and-leads.md): whether a lead runs, how far it
// has been rolled out, one autonomy level per action category, and its
// loop guards (wakes a day, tokens a wake) with an optional dollar cap. Types, constant lists and the pure decision helper
// only; the server validates writes (server/projects/store.ts).

/** How far the lead has been rolled out, in order:
 *  - `watch`: reads, writes the digest and proposes; changes nothing
 *  - `coordinate`: may also spawn workers and leave pull requests
 *  - `act`: alone categories run without the owner */
export const LEAD_STAGES = ["watch", "coordinate", "act"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Who decides an action, from least to most strict:
 *  - `alone`: the lead acts
 *  - `asks-first`: the action waits for the owner
 *  - `only-you`: the lead may prepare it, never do it */
export const LEAD_LEVELS = ["alone", "asks-first", "only-you"] as const;
export type LeadLevel = (typeof LEAD_LEVELS)[number];

export const LEAD_CATEGORIES = [
  "fix-verified",
  "ci-repair",
  "support-routine-reply",
  "signal-rule-change",
  "dependency-major",
  "ban-user",
  "rotate-key",
  "public-release",
  "refund",
  "pricing",
  "dispute",
  "tax-legal",
  "contract",
  "production-data-write",
] as const;
export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

export const LEAD_CATEGORY_LABELS: Record<LeadCategory, string> = {
  "fix-verified": "Fixes verified by a second agent",
  "ci-repair": "CI repair",
  "support-routine-reply": "Routine support replies",
  "signal-rule-change": "Signal rule changes",
  "dependency-major": "Major dependency upgrades",
  "ban-user": "Banning users",
  "rotate-key": "Rotating keys",
  "public-release": "Public releases",
  refund: "Refunds",
  pricing: "Pricing",
  dispute: "Disputes",
  "tax-legal": "Tax and legal",
  contract: "Contracts",
  "production-data-write": "Writes to production data",
};

/** Categories that stay with the owner whatever the settings say: a patch
 *  can't lower them, and a stored value below `only-you` reads as it. */
export const PINNED_ONLY_YOU = [
  "refund",
  "pricing",
  "dispute",
  "tax-legal",
  "contract",
  "production-data-write",
] as const satisfies readonly LeadCategory[];

/** The defaults, from how the owner works today. */
export const DEFAULT_LEAD_RULES: Readonly<Record<LeadCategory, LeadLevel>> = {
  "fix-verified": "alone",
  "ci-repair": "alone",
  "support-routine-reply": "alone",
  "signal-rule-change": "asks-first",
  "dependency-major": "asks-first",
  "ban-user": "asks-first",
  "rotate-key": "asks-first",
  "public-release": "asks-first",
  refund: "only-you",
  pricing: "only-you",
  dispute: "only-you",
  "tax-legal": "only-you",
  contract: "only-you",
  "production-data-write": "only-you",
};

/** Alone categories whose action at the coordinate stage is spawning a
 *  worker or leaving a pull request. Merging and deploying stay with the
 *  existing loops' rules; sends (support replies) still wait. */
export const COORDINATE_CATEGORIES = [
  "fix-verified",
  "ci-repair",
] as const satisfies readonly LeadCategory[];

/** The monthly dollar cap every lead had before the loop guards. A stored
 *  cap equal to it was never the owner's choice, so it reads as off. */
export const LEGACY_DEFAULT_LEAD_BUDGET_USD = 50;
export const MAX_LEAD_BUDGET_USD = 100_000;

/** Wakes a lead may start in one UTC day before it pauses and asks. */
export const DEFAULT_LEAD_DAILY_WAKES = 24;
export const MAX_LEAD_DAILY_WAKES = 1_000;
/** Tokens one wake may use before it is asked to wrap up (see
 *  wakeTokens in goal-runner.ts for how they are counted). */
export const DEFAULT_LEAD_WAKE_TOKENS = 1_000_000;
export const MIN_LEAD_WAKE_TOKENS = 10_000;
export const MAX_LEAD_WAKE_TOKENS = 50_000_000;

export interface ProjectLeadSettings {
  enabled: boolean;
  stage: LeadStage;
  rules: Record<LeadCategory, LeadLevel>;
  /** Optional monthly dollar cap; null is no cap (the default). */
  budgetUsdPerMonth: number | null;
  /** Wakes a day before the lead pauses and asks the owner. */
  dailyWakeLimit: number;
  /** Tokens a wake may use before it wraps up and the lead pauses. */
  wakeTokenLimit: number;
  /** The lead's goal (goals.ts); set by the server, never by a patch. */
  goalId?: string;
  /** The person the lead answers to. */
  owner?: string;
}

/** What the project page may send; `owner: null` clears the owner. */
export interface ProjectLeadPatch {
  enabled?: boolean;
  stage?: LeadStage;
  rules?: Partial<Record<LeadCategory, LeadLevel>>;
  /** null turns the cap off. */
  budgetUsdPerMonth?: number | null;
  dailyWakeLimit?: number;
  wakeTokenLimit?: number;
  owner?: string | null;
}

export function defaultLeadSettings(): ProjectLeadSettings {
  return {
    enabled: false,
    stage: "watch",
    rules: { ...DEFAULT_LEAD_RULES },
    budgetUsdPerMonth: null,
    dailyWakeLimit: DEFAULT_LEAD_DAILY_WAKES,
    wakeTokenLimit: DEFAULT_LEAD_WAKE_TOKENS,
  };
}

export function isLeadCategory(v: unknown): v is LeadCategory {
  return (
    typeof v === "string" && (LEAD_CATEGORIES as readonly string[]).includes(v)
  );
}

export function isLeadLevel(v: unknown): v is LeadLevel {
  return (
    typeof v === "string" && (LEAD_LEVELS as readonly string[]).includes(v)
  );
}

export function isLeadStage(v: unknown): v is LeadStage {
  return (
    typeof v === "string" && (LEAD_STAGES as readonly string[]).includes(v)
  );
}

export function isPinnedOnlyYou(category: LeadCategory): boolean {
  return (PINNED_ONLY_YOU as readonly string[]).includes(category);
}

/** Whether `level` leaves the lead no more room than `than`. */
export function leadLevelWithin(level: LeadLevel, than: LeadLevel): boolean {
  return LEAD_LEVELS.indexOf(level) >= LEAD_LEVELS.indexOf(than);
}

/** Whether `stage` lets the lead do no more than `than`. */
export function leadStageWithin(stage: LeadStage, than: LeadStage): boolean {
  return LEAD_STAGES.indexOf(stage) <= LEAD_STAGES.indexOf(than);
}

/** The level a category is at: the stored one, except pinned categories,
 *  which are always only you. */
export function leadLevel(
  rules: Partial<Record<LeadCategory, LeadLevel>>,
  category: LeadCategory,
): LeadLevel {
  if (isPinnedOnlyYou(category)) return "only-you";
  const stored = rules[category];
  return isLeadLevel(stored) ? stored : DEFAULT_LEAD_RULES[category];
}

/** What the lead does with an action:
 *  - `act`: does it
 *  - `ask`: proposes it and waits for the owner
 *  - `prepare`: may prepare it for the owner, never do it */
export type LeadEffect = "act" | "ask" | "prepare";

export interface LeadDecision {
  level: LeadLevel;
  effective: LeadEffect;
  /** The rule that made the decision. */
  rule: string;
}

export interface LeadDecisionSettings {
  enabled: boolean;
  stage: LeadStage;
  rules: Partial<Record<LeadCategory, LeadLevel>>;
  /** The project's kill switch (`incidents.agentsPaused`). */
  agentsPaused?: boolean;
}

const FROM_SETTINGS = "from the project settings";

/**
 * What the lead may do with an action of `category` at its stage. Only
 * you prepares and asks first asks, whatever the stage. Alone acts only
 * at the act stage; at coordinate only spawning workers and leaving pull
 * requests acts; at watch everything is a proposal. The kill switch and a lead that is off make every alone action
 * a proposal. Every decision names its rule.
 */
export function leadDecision(
  settings: LeadDecisionSettings,
  category: LeadCategory,
): LeadDecision {
  const stage = settings.stage;
  const label = LEAD_CATEGORY_LABELS[category];
  const level = leadLevel(settings.rules, category);
  if (level === "only-you")
    return {
      level,
      effective: "prepare",
      rule: isPinnedOnlyYou(category)
        ? `Only you: ${label}, always`
        : `Only you: ${label}, ${FROM_SETTINGS}`,
    };
  if (level === "asks-first")
    return {
      level,
      effective: "ask",
      rule: `Asks first: ${label}, ${FROM_SETTINGS}`,
    };
  if (settings.agentsPaused)
    return {
      level,
      effective: "ask",
      rule: `Kill switch, ${FROM_SETTINGS}`,
    };
  if (!settings.enabled)
    return { level, effective: "ask", rule: `Lead off, ${FROM_SETTINGS}` };
  if (stage === "watch")
    return {
      level,
      effective: "ask",
      rule: `Watch: every action is a proposal, ${FROM_SETTINGS}`,
    };
  if (stage === "coordinate") {
    if ((COORDINATE_CATEGORIES as readonly string[]).includes(category))
      return {
        level,
        effective: "act",
        rule: `Coordinate: ${label} as a worker and a pull request; merging stays with the existing loops, ${FROM_SETTINGS}`,
      };
    return {
      level,
      effective: "ask",
      rule: `Coordinate: only workers and pull requests run alone, ${FROM_SETTINGS}`,
    };
  }
  return {
    level,
    effective: "act",
    rule: `Alone: ${label}, ${FROM_SETTINGS}`,
  };
}
