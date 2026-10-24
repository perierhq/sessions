// PLACEHOLDER (lane D): stands in for the project settings page until the
// project page change lands with the real component at this path. It only
// keeps the Settings mount point compiling; replace it wholesale.
import type { ProjectSectionId } from "../../../lib/project-settings/page-model";
import { SettingsHeader, SettingsPanel } from "../../../ui/settings";

export function ProjectSettingsPage({
  project,
}: {
  project: string;
  section?: ProjectSectionId;
  onOpenSection(id: ProjectSectionId): void;
}) {
  return (
    <SettingsPanel>
      <SettingsHeader title={project} />
    </SettingsPanel>
  );
}
