// The facts the policy needs about a candidate: what its steps cost, whether
// they need a secret or can be undone, and whether the PR runs a migration
// or reaches outside the deploy action's scope. Incident notes and runbooks
// under docs/incidents never count.
import type {
  CandidatePlan,
  IncidentAction,
  IncidentProjectSettings,
  NeverWithoutYou,
} from "../../../shared/incident-response";
import { projectAction } from "./project-settings";

export const KNOWLEDGE_GLOB = "docs/incidents/**";
const MAX_SCOPE_DETAILS = 5;
const GLOB_CACHE_MAX = 500;

const globs = new Map<string, Bun.Glob>();

export function globMatch(pattern: string, path: string): boolean {
  let glob = globs.get(pattern);
  if (!glob) {
    if (globs.size >= GLOB_CACHE_MAX) globs.clear();
    glob = new Bun.Glob(pattern);
    globs.set(pattern, glob);
  }
  return glob.match(path);
}

export interface ChangeFacts {
  facts: Set<NeverWithoutYou>;
  details: string[];
  steps: IncidentAction[];
}

export function changeFacts(input: {
  plan: CandidatePlan;
  settings: IncidentProjectSettings;
  prFiles: string[] | null;
}): ChangeFacts | { error: string } {
  const { plan, settings } = input;
  if (!plan.pr && plan.actions.length === 0)
    return { error: "The candidate has nothing to run" };
  const steps: IncidentAction[] = [];
  const deploy = plan.pr ? projectAction(settings, "deploy") : undefined;
  if (plan.pr) {
    if (!deploy)
      return { error: `No deploy action is declared for ${settings.project}` };
    steps.push(deploy);
  }
  for (const id of plan.actions) {
    const action = settings.actions.find((a) => a.id === id);
    if (!action) return { error: `Unknown action "${id}"` };
    steps.push(action);
  }

  const facts = new Set<NeverWithoutYou>();
  const details: string[] = [];
  if (steps.some((s) => s.cost.kind === "amount")) facts.add("costs-money");
  if (steps.some((s) => s.needsSecret)) facts.add("needs-secret");
  if (steps.some((s) => !s.reversible)) facts.add("not-reversible");

  if (deploy) {
    if (input.prFiles === null) {
      facts.add("outside-scope");
      details.push("Could not read the PR's files");
    } else {
      let outside = 0;
      for (const file of input.prFiles) {
        if (globMatch(KNOWLEDGE_GLOB, file)) continue;
        if (deploy.scope.migrationPaths.some((g) => globMatch(g, file))) {
          facts.add("migration");
          details.push(`${file} matches a migration path`);
        }
        if (
          deploy.scope.paths.length &&
          !deploy.scope.paths.some((g) => globMatch(g, file))
        ) {
          facts.add("outside-scope");
          if (outside++ < MAX_SCOPE_DETAILS)
            details.push(`${file} is outside ${deploy.label}'s scope`);
        }
      }
    }
  }
  return { facts, details, steps };
}
