// The one-time move from the legacy stores to one document per project. It
// backs up every legacy document first, then stores each project's composed
// document only where none exists (so a second run writes nothing), forgets
// the retired personal sandbox default, and records itself under a marker
// key. A project whose legacy access was unreadable starts from the default
// access; its raw value stays in the backup. `legacyDrift` names projects
// whose legacy settings changed after they were migrated (an old gateway
// still draining during an upgrade).
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  MigrationResult,
  ProjectMigrationReport,
  ProjectRemigrateResult,
  ProjectSettingsDocument,
} from "../../shared/project-settings";
import { incidentAudit } from "../incidents/audit-sink";
import { forgetUiPrefKey, readUiPrefKey } from "../ui-prefs";
import {
  composeFromLegacy,
  legacyAccessDocuments,
  legacyEnvironment,
  legacyProjectDocuments,
  loadLegacySources,
} from "./legacy";
import {
  MIGRATION_MARKER_KEY,
  noteMigratedDocument,
  projectDocuments,
  widenedFieldPaths,
  withDocumentDefaults,
} from "./store";

export const PERSONAL_SANDBOX_PREF_KEY = "sandbox-default";
const MIGRATION_VERSION = 1;

/** Where backups go: the state root's backup directory, resolved without
 *  touching the disk. */
function backupDirectory(): string {
  const root = process.env.OPENSESSION_STATE_DIR;
  if (root) return join(root, ".opensession-backups");
  return join(process.env.HOME || homedir(), ".opensession", "backups");
}

async function writeBackup(at: string): Promise<string> {
  const env = legacyEnvironment();
  const [projects, access, prefs] = await Promise.all([
    legacyProjectDocuments().list(),
    legacyAccessDocuments().list(),
    readUiPrefKey(PERSONAL_SANDBOX_PREF_KEY),
  ]);
  const sandbox = env.sandbox();
  const dir = backupDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(
    dir,
    `project-settings-v1-${at.replace(/[:.]/g, "-")}.json`,
  );
  // Holds release hook secrets: owner-only, and never overwritten.
  await writeFile(
    path,
    JSON.stringify(
      {
        version: MIGRATION_VERSION,
        at,
        "incident-projects": projects,
        "incident-access": access,
        sandbox: {
          sessionDefault: sandbox.sessionDefault ?? null,
          perRepo: sandbox.perRepo,
        },
        [`ui-prefs:${PERSONAL_SANDBOX_PREF_KEY}`]: prefs,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

function failedReport(project: string, error: unknown): ProjectMigrationReport {
  return {
    project,
    dropped: [
      {
        field: "*",
        item: error instanceof Error ? error.message : String(error),
        why: "The legacy settings could not be read; nothing was migrated",
      },
    ],
    access: "default",
  };
}

/**
 * Move every configured project onto its own document. Idempotent: an
 * existing document is never overwritten. `dryRun` writes nothing (no
 * backup, no documents, no prefs, no marker) and returns the reports.
 */
export async function migrateProjectSettings(opts: {
  dryRun: boolean;
  by: string;
}): Promise<MigrationResult> {
  const at = new Date().toISOString();
  const projects = legacyEnvironment().projects();
  const stored = new Set(
    (await projectDocuments().getMany(projects)).map((row) => row.key),
  );
  const alreadyMigrated = projects.filter((p) => stored.has(p));
  const composed: Array<{
    project: string;
    document: ProjectSettingsDocument | null;
    report: ProjectMigrationReport;
  }> = [];
  for (const project of projects) {
    if (stored.has(project)) continue;
    try {
      const { document, report } = composeFromLegacy(
        project,
        await loadLegacySources(project),
        at,
      );
      composed.push({ project, document, report });
    } catch (error) {
      composed.push({
        project,
        document: null,
        report: failedReport(project, error),
      });
    }
  }
  const reports = composed.map((c) => c.report);
  if (opts.dryRun) {
    const prefs = await readUiPrefKey(PERSONAL_SANDBOX_PREF_KEY);
    return {
      backupPath: null,
      projects: reports,
      personalDefaultsCleared: Object.keys(prefs).length,
      alreadyMigrated,
    };
  }

  const backupPath = await writeBackup(at);
  for (const { project, document } of composed) {
    if (!document) continue;
    let existed = false;
    const committed = await projectDocuments().update(project, (current) => {
      if (current !== null) {
        existed = true;
        return current;
      }
      return {
        ...document,
        revision: 1,
        migratedAt: at,
        updatedAt: at,
        updatedBy: opts.by,
      } satisfies ProjectSettingsDocument;
    });
    if (existed) alreadyMigrated.push(project);
    else noteMigratedDocument(project, committed);
  }
  const personalDefaultsCleared = await forgetUiPrefKey(
    PERSONAL_SANDBOX_PREF_KEY,
  );
  const migrated = composed
    .filter((c) => c.document && !alreadyMigrated.includes(c.project))
    .map((c) => c.project);
  await projectDocuments().set(MIGRATION_MARKER_KEY, {
    version: MIGRATION_VERSION,
    at,
    by: opts.by,
    backupPath,
    reports,
  });
  incidentAudit({
    kind: "project_settings_migrated",
    by: opts.by,
    projects: migrated,
    alreadyMigrated,
    backupPath,
  });
  return {
    backupPath,
    projects: reports,
    personalDefaultsCleared,
    alreadyMigrated,
  };
}

/** Back up one project's legacy settings and its stored document before a
 *  re-migration overwrites the document. Owner-only, never overwritten. */
async function writeProjectBackup(
  project: string,
  at: string,
  document: unknown,
): Promise<string> {
  const [incidentProject, access] = await Promise.all([
    legacyProjectDocuments().get(project),
    legacyAccessDocuments().get(project),
  ]);
  const dir = backupDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(
    dir,
    `project-settings-v1-${project}-${at.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(
    path,
    JSON.stringify(
      {
        version: MIGRATION_VERSION,
        at,
        project,
        document,
        "incident-projects": incidentProject,
        "incident-access": access,
        sandbox: legacyEnvironment().sandbox().perRepo[project] ?? null,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

/**
 * Compose one project from its legacy settings again, after they changed
 * during an upgrade. Without `force` it only reports what the legacy
 * settings compose to, and which fields that gives agents more of than the
 * current document (`widened`: narrowings a re-run undoes). With it, it backs up the stored document and the
 * legacy settings first, then replaces the document (a new revision,
 * `migratedAt` now), keeping its release hook secret when the legacy
 * settings have none. Callers make sure a signed-in person confirmed it.
 */
export async function remigrateProject(
  project: string,
  opts: { force: boolean; by: string },
): Promise<ProjectRemigrateResult> {
  const at = new Date().toISOString();
  const { document, report } = composeFromLegacy(
    project,
    await loadLegacySources(project),
    at,
  );
  const stored = await projectDocuments().get(project);
  const widened =
    stored === null
      ? []
      : widenedFieldPaths(withDocumentDefaults(project, stored), document);
  if (!opts.force)
    return { project, report, backupPath: null, overwritten: false, widened };
  const backupPath = await writeProjectBackup(project, at, stored);
  const committed = await projectDocuments().update(project, (current) => {
    const previous =
      current === null ? null : withDocumentDefaults(project, current);
    return {
      ...document,
      revision: (previous?.revision ?? 0) + 1,
      releaseHookSecret:
        document.releaseHookSecret ?? previous?.releaseHookSecret,
      migratedAt: at,
      updatedAt: at,
      updatedBy: opts.by,
    } satisfies ProjectSettingsDocument;
  });
  noteMigratedDocument(project, committed);
  driftSeen.delete(project);
  incidentAudit({
    kind: "project_settings_remigrated",
    project,
    by: opts.by,
    backupPath,
    dropped: report.dropped.length,
    widened,
  });
  return { project, report, backupPath, overwritten: true, widened };
}

/** When a legacy record was last written: its `updatedAt`, or a release
 *  recorded later (an old gateway appends releases without touching
 *  `updatedAt`). */
function legacyWrittenAt(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { updatedAt?: unknown; releases?: unknown };
  let at = typeof record.updatedAt === "string" ? record.updatedAt : null;
  if (Array.isArray(record.releases))
    for (const release of record.releases) {
      const r = (release as { at?: unknown } | null)?.at;
      if (typeof r === "string" && (at === null || r > at)) at = r;
    }
  return at;
}

/** Drift already audited, per project, by the legacy write time seen. */
const driftSeen = new Map<string, string>();

/** Projects whose legacy settings were written after the project was
 *  migrated. Audits `project_settings_legacy_drift` the first time this
 *  process sees each such write. */
export async function legacyDrift(): Promise<string[]> {
  const docs = (await projectDocuments().list()).filter(
    (row) => row.key !== MIGRATION_MARKER_KEY,
  );
  const migrated = new Map<string, string>();
  for (const row of docs) {
    const at = (row.value as { migratedAt?: unknown } | null)?.migratedAt;
    if (typeof at === "string") migrated.set(row.key, at);
  }
  if (!migrated.size) return [];
  const keys = [...migrated.keys()];
  const [projects, access] = await Promise.all([
    legacyProjectDocuments().getMany(keys),
    legacyAccessDocuments().getMany(keys),
  ]);
  const drift = new Map<string, string>();
  for (const row of [...projects, ...access]) {
    const migratedAt = migrated.get(row.key);
    const legacyAt = legacyWrittenAt(row.value);
    if (!migratedAt || !legacyAt || legacyAt <= migratedAt) continue;
    const seen = drift.get(row.key);
    if (!seen || legacyAt > seen) drift.set(row.key, legacyAt);
  }
  for (const [project, legacyAt] of drift) {
    if (driftSeen.get(project) === legacyAt) continue;
    driftSeen.set(project, legacyAt);
    incidentAudit({
      kind: "project_settings_legacy_drift",
      project,
      legacyAt,
      migratedAt: migrated.get(project),
    });
  }
  return [...drift.keys()].sort();
}
