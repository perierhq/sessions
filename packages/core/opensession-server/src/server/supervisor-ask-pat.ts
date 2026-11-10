/**
 * ask_pat: the supervisor hands GitHub work to the instance persona (Pat,
 * config persona.name) through the GitHub agent's existing entry point,
 * `triggerPrAction` (agents/github/trigger.ts), the one the web UI's PR
 * actions, Slack and the opensession-github tools already use. No new agent:
 *
 * - review_pr: the PR review flow (runReview, then its handoff).
 * - fix_ci: the os-auto-fix loop (runAutoFix), told to put the failing
 *   checks first.
 * - auto_fix: the os-auto-fix loop as the label starts it.
 *
 * Everything public goes out as the persona from those flows. The supervisor
 * passes only an action, a registered repository and a PR number: no free
 * text of its own reaches GitHub, so nothing public is ever signed Blob.
 * Every call is audited, refused ones included.
 */
import type { PrActionKind, TriggerResult } from "../agents/github/trigger";
import { audit } from "./audit";
import { configuredRepos, personaName, type Repo } from "./config";

export const ASK_PAT_ACTIONS = ["review_pr", "fix_ci", "auto_fix"] as const;
export type AskPatAction = (typeof ASK_PAT_ACTIONS)[number];

const KIND: Record<AskPatAction, PrActionKind> = {
  review_pr: "review",
  fix_ci: "autofix",
  auto_fix: "autofix",
};

/** Server-written, fixed: the only steer ask_pat ever sends. */
export const FIX_CI_STEER =
  "Start with the failing CI checks and make them pass.";

const STEER: Record<AskPatAction, string | undefined> = {
  review_pr: undefined,
  fix_ci: FIX_CI_STEER,
  auto_fix: undefined,
};

const VERB: Record<AskPatAction, string> = {
  review_pr: "is reviewing",
  fix_ci: "is fixing the failing checks on",
  auto_fix: "is auto-fixing",
};

export interface AskPatDeps {
  trigger(
    kind: PrActionKind,
    pr: number,
    requestedBy: string,
    steer: string | undefined,
    ghRepo: string,
  ): Promise<Pick<TriggerResult, "ok" | "message" | "url" | "bksId">>;
  repos(): Record<string, Repo>;
  persona(): string;
  audit(event: Record<string, unknown>): void;
}

const liveDeps: AskPatDeps = {
  trigger: async (...args) =>
    (await import("../agents/github/trigger")).triggerPrAction(...args),
  repos: () => configuredRepos(),
  persona: () => personaName(),
  audit,
};

let deps: AskPatDeps = liveDeps;

/** Test seam: replace any dependency; omitted ones keep their defaults. */
export function __setAskPatDepsForTest(overrides?: Partial<AskPatDeps>): void {
  deps = { ...liveDeps, ...overrides };
}

/** A registered repository with a GitHub `owner/name`, by its registry id
 *  or that name; null for anything else. */
export function registeredGhRepo(
  repo: string,
  repos: Record<string, Repo> = deps.repos(),
): string | null {
  const wanted = repo.trim().toLowerCase();
  if (!wanted) return null;
  for (const [id, entry] of Object.entries(repos)) {
    const gh = entry.ghRepo?.trim();
    if (!gh || (entry.host && entry.host !== "github")) continue;
    if (id.toLowerCase() === wanted || gh.toLowerCase() === wanted) return gh;
  }
  return null;
}

export interface AskPatResult {
  ok: boolean;
  message: string;
}

/** Hand one PR action to the persona on behalf of `owner`. */
export async function askPat(input: {
  owner: string;
  action: AskPatAction;
  repo: string;
  pr: number;
}): Promise<AskPatResult> {
  const persona = deps.persona();
  const base = {
    kind: "supervisor_ask_pat",
    user: input.owner,
    action: input.action,
    repo: input.repo,
    pr: input.pr,
  };
  if (!(ASK_PAT_ACTIONS as readonly string[]).includes(input.action)) {
    deps.audit({ ...base, ok: false, reason: "unknown action" });
    return { ok: false, message: `Unknown action ${input.action}.` };
  }
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0) {
    deps.audit({ ...base, ok: false, reason: "bad pr" });
    return { ok: false, message: "The PR must be a positive number." };
  }
  const ghRepo = registeredGhRepo(input.repo);
  if (!ghRepo) {
    deps.audit({ ...base, ok: false, reason: "unregistered repo" });
    return {
      ok: false,
      message: `${input.repo} isn't a registered repository with a GitHub repo. Nothing was started.`,
    };
  }
  let result: Awaited<ReturnType<AskPatDeps["trigger"]>>;
  try {
    result = await deps.trigger(
      KIND[input.action],
      input.pr,
      input.owner,
      STEER[input.action],
      ghRepo,
    );
  } catch (error) {
    deps.audit({ ...base, ghRepo, ok: false, reason: "trigger failed" });
    return {
      ok: false,
      message: `${persona} couldn't start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  deps.audit({
    ...base,
    ghRepo,
    ok: result.ok,
    ...(result.bksId ? { sessionId: result.bksId } : {}),
  });
  if (!result.ok)
    return {
      ok: false,
      message: `${persona} couldn't start: ${result.message}`,
    };
  const where = [
    result.url,
    result.bksId ? `session ${result.bksId}` : "",
  ].filter(Boolean);
  return {
    ok: true,
    message: `Started: ${persona} ${VERB[input.action]} ${ghRepo}#${input.pr}. Results go on the PR as ${persona}${where.length ? ` (${where.join(", ")})` : ""}.`,
  };
}
