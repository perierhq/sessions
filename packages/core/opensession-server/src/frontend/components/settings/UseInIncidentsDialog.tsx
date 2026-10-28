import useSWR from "swr";
import type { KeychainCredentialDto } from "../../lib/api";
import { fetchProjects } from "../../lib/api/projects";
import { routePath } from "../../lib/app-route";
import { errorMessage } from "../../lib/error-message";
import { FIELD_ERROR, FIELD_HINT } from "../../lib/incident-settings-classes";
import { lendingRoles } from "../../lib/keychain-credential";
import {
  SHEET_CHOICE,
  SHEET_CHOICE_DESC,
  SHEET_CHOICE_TITLE,
} from "../../lib/project-settings-classes";
import { ListSkeleton } from "../../ui/state";
import { IconChevronRight } from "../icons";
import { SettingsDialog } from "./incidents/SettingsDialog";

/**
 * Where a credential is lent to incident agents: each project's access
 * settings ("What agents may use"), which is where lending is decided. The
 * Keychain only links there, so there is one place that lends.
 */
export function UseInIncidentsDialog({
  credential,
  onClose,
}: {
  credential: KeychainCredentialDto;
  onClose: () => void;
}) {
  const projects = useSWR(["api", "projects-for-keychain"], fetchProjects);
  const lent = new Map(
    (credential.lentIn ?? []).map((l) => [l.project, l.roles]),
  );

  return (
    <SettingsDialog
      open
      onClose={onClose}
      title={`Use ${credential.service} in incidents`}
    >
      <p className={FIELD_HINT}>
        A project lends it to its incident agents under What agents may use.
        Open a project, add {credential.service} there and tick the roles
      </p>
      {projects.error ? (
        <p className={FIELD_ERROR}>
          {errorMessage(projects.error, "Couldn't load the projects")}
        </p>
      ) : !projects.data ? (
        <ListSkeleton rows={3} variant="bare" label="Loading projects" />
      ) : projects.data.length === 0 ? (
        <p className={FIELD_HINT}>No projects yet</p>
      ) : (
        <div className="-mx-3 flex flex-col">
          {projects.data.map((p) => {
            const roles = lent.get(p.id);
            return (
              <a
                key={p.id}
                className={SHEET_CHOICE}
                href={routePath({
                  view: "projectSettings",
                  project: p.id,
                  section: "access",
                })}
              >
                <span className="min-w-0 flex-1">
                  <span className={SHEET_CHOICE_TITLE}>{p.label}</span>
                  <span className={SHEET_CHOICE_DESC}>
                    {roles ? `Lent: ${lendingRoles(roles)}` : "Not lent"}
                  </span>
                </span>
                <IconChevronRight size={18} dense className="text-faint" />
              </a>
            );
          })}
        </div>
      )}
    </SettingsDialog>
  );
}
