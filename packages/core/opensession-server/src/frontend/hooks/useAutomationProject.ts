// The project an automation form is on. Where a run goes, which model it
// gets by default, and what it may reach are all the project's settings, so
// the form reads them from whichever project is picked, live.
import { useState } from "react";
import {
  automationRepoPayload,
  automationStartProject,
  type AutomationPlaceInput,
} from "../lib/automation-environment";
import { useSidebarFilter } from "../lib/sidebar-filter";
import { useProjectSettings } from "./useProjects";
import { useRepoList } from "./useSettingsResources";

/**
 * `initial` is the automation being edited (null when creating); a new one
 * starts on `prefillRepo` (a draft's own project), else the project in the
 * sidebar's filter, else the default project. Picking one replaces all three.
 */
export function useAutomationProject(
  initial: AutomationPlaceInput | null,
  prefillRepo?: string,
) {
  const repos = useRepoList().data;
  const lens = useSidebarFilter().repo;
  const [picked, setProject] = useState<string | null>(null);
  const project =
    picked ??
    automationStartProject(
      { initial, prefillRepo, lens: lens === "all" ? undefined : lens },
      repos,
    );
  const projectModel =
    useProjectSettings(project).data?.effective.models.automations.label;
  return {
    project,
    setProject,
    repos,
    /** The automations model this project sets, if it sets one. */
    projectModel,
    /** `repo` for the create or update call. */
    repoPayload: () => automationRepoPayload(initial, project, repos),
  };
}
