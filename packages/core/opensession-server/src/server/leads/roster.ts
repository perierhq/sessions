// Every project's lead in one short list: label, on or off, stage and owner.
// Settings, Members shows it under Blob (GET /api/supervisor/leads). Read
// from the stored project documents, a catalog namespace; no session is
// opened or scanned.
import type { LeadRosterEntry } from "../../shared/project-lead";
import type { ProjectSettingsDocument } from "../../shared/project-settings";

export interface LeadRosterDeps {
  listProjectDocuments(): Promise<ProjectSettingsDocument[]>;
  /** The project as people know it. */
  projectLabel(project: string): string;
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
    projectLabel: (project) => configuredRepos()[project]?.label || project,
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

/** Running leads first, then by label. */
export async function listLeadRoster(): Promise<LeadRosterEntry[]> {
  const deps = { ...(await liveDeps()), ...overrides };
  const docs = await deps.listProjectDocuments();
  return docs
    .map((doc): LeadRosterEntry => {
      const owner = deps.leadOwner(doc);
      return {
        project: doc.project,
        label: deps.projectLabel(doc.project),
        enabled: doc.lead.enabled,
        stage: doc.lead.stage,
        ...(owner ? { owner } : {}),
      };
    })
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label),
    );
}
