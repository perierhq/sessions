// Every project's lead in one short list: label, on or off, stage and owner.
// Settings, Members shows it under Blob (GET /api/supervisor/leads). Read
// from the stored project documents, a catalog namespace; no session is
// opened or scanned.
import type { LeadRosterEntry } from "../../shared/project-lead";
import type { ProjectSettingsDocument } from "../../shared/project-settings";

export interface LeadRosterDeps {
  listProjectDocuments(): Promise<ProjectSettingsDocument[]>;
  /** Each configured project's id and the label people know it by. */
  projectLabels(): ReadonlyMap<string, string>;
  /** Who the lead answers to; "" when nobody does. */
  leadOwner(doc: ProjectSettingsDocument): string;
}

// Loaded on first use, so importing the supervisor routes pulls in neither
// the config nor the lead report modules.
async function liveDeps(): Promise<LeadRosterDeps> {
  const [{ listProjectDocuments }, { configuredRepos }, { leadOwner }] =
    await Promise.all([
      import("../projects/store"),
      import("../config"),
      import("./report"),
    ]);
  return {
    listProjectDocuments,
    projectLabels: () =>
      new Map(
        Object.entries(configuredRepos()).map(([id, repo]) => [
          id,
          repo.label || id,
        ]),
      ),
    leadOwner,
  };
}

let overrides: Partial<LeadRosterDeps> | undefined;

/** Swap dependencies in tests; undefined restores them. */
export function __setLeadRosterDepsForTest(
  next: Partial<LeadRosterDeps> | undefined,
): void {
  overrides = next;
}

/**
 * Configured projects only, running leads first, then by label. A document
 * left behind by a removed project stays out.
 */
export async function listLeadRoster(): Promise<LeadRosterEntry[]> {
  const deps = { ...(await liveDeps()), ...overrides };
  const labels = deps.projectLabels();
  const docs = await deps.listProjectDocuments();
  return docs
    .flatMap((doc): LeadRosterEntry[] => {
      const label = labels.get(doc.project);
      if (label === undefined) return [];
      const owner = deps.leadOwner(doc);
      return [
        {
          project: doc.project,
          label,
          enabled: doc.lead.enabled,
          stage: doc.lead.stage,
          ...(owner ? { owner } : {}),
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label),
    );
}
