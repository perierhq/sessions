// The facts the policy needs about a candidate: what its steps cost, whether
// they need a secret or can be undone, and whether the PR runs a migration
// or reaches outside the deploy action's scope. Incident notes and runbooks
// (markdown under docs/incidents) never count; a rename counts both paths.
import type {
  CandidatePlan,
  IncidentAction,
  IncidentProjectSettings,
  NeverWithoutYou,
} from "../../../shared/incident-response";
import { projectAction } from "./project-settings";

export const KNOWLEDGE_GLOB = "docs/incidents/**/*.md";
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

/** A PR file as GitHub lists it; a plain string is a path with no rename. */
export type PrFileEntry =
  | string
  | { filename: string; previous_filename?: string };

/** A relative path with no `.` or `..` segment, empty segment, backslash or
 *  NUL: globs would otherwise match a path that leaves its directory. */
function plainRepoPath(path: string): boolean {
  if (!path || path.startsWith("/") || /[\\\u0000]/.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function entryPaths(entry: PrFileEntry): string[] {
  if (typeof entry === "string") return [entry];
  return entry.previous_filename !== undefined &&
    entry.previous_filename !== entry.filename
    ? [entry.previous_filename, entry.filename]
    : [entry.filename];
}

export interface ChangeFacts {
  facts: Set<NeverWithoutYou>;
  details: string[];
  steps: IncidentAction[];
}

export function changeFacts(input: {
  plan: CandidatePlan;
  settings: IncidentProjectSettings;
  prFiles: PrFileEntry[] | null;
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
  const seen = new Set<string>();
  for (const id of plan.actions) {
    const action = settings.actions.find((a) => a.id === id);
    if (!action) return { error: `Unknown action "${id}"` };
    // The deploy step comes from `pr` alone, so it can never run twice or
    // without the merged fix.
    if (action.kind === "deploy")
      return { error: "Deploy runs only with the PR" };
    if (seen.has(id)) return { error: `List each action once: "${id}"` };
    seen.add(id);
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
      const paths = input.prFiles.flatMap(entryPaths);
      for (const path of paths)
        if (typeof path !== "string" || !plainRepoPath(path))
          return {
            error: `PR path ${JSON.stringify(path)} is not a plain repository path`,
          };
      let outside = 0;
      for (const file of paths) {
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
