// Test helper: write a project's access table straight into its settings
// document, without the write API's validation, and announce the change the
// way a committed write does (listeners fire). Not on any live import chain.
import {
  defaultProjectDocument,
  type ProjectAccess,
  type ProjectSettingsDocument,
} from "../../../shared/project-settings";
import {
  noteMigratedDocument,
  projectDocuments,
  withDocumentDefaults,
} from "../../projects/store";

export async function setProjectDocumentForTest(
  project: string,
  edit: (doc: ProjectSettingsDocument) => void,
): Promise<ProjectSettingsDocument> {
  const now = new Date().toISOString();
  const committed = await projectDocuments().update(project, (stored) => {
    const doc =
      stored === null
        ? defaultProjectDocument(project, now)
        : withDocumentDefaults(project, stored);
    edit(doc);
    return { ...doc, revision: doc.revision + 1, updatedAt: now };
  });
  return noteMigratedDocument(project, committed);
}

export function setProjectAccessForTest(
  project: string,
  edit: (access: ProjectAccess) => void,
): Promise<ProjectSettingsDocument> {
  return setProjectDocumentForTest(project, (doc) => edit(doc.access));
}
