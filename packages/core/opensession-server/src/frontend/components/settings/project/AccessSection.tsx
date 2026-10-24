import type {
  AccessCellChange,
  ProjectSettingsView,
} from "../../../../shared/project-settings";
import { useIsPhone } from "../../../hooks/useIsPhone";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import { ACCESS_KEY } from "../../../lib/project-settings-classes";
import { AccessRoleList } from "./AccessRoleList";
import { AccessTable } from "./AccessTable";
import { AddAccessRowDialog } from "./AddAccessRowDialog";

/** The key under the desktop table, word for word. */
const KEY =
  "A dash means no. Ask once: lent for one request, then asked again. Click a cell to change it";
const PHONE_KEY =
  "Switch roles to compare. Each row says how many roles have it";

/**
 * What agents may use: the role-by-capability table on a desktop, one role
 * at a time on a phone, and the sheet that adds a row.
 */
export function AccessSection({
  view,
  adding,
  onAddingChange,
  onCellChange,
  onAllowAgents,
  onSave,
}: {
  view: ProjectSettingsView;
  /** The add sheet's key while it is open. */
  adding: number | null;
  onAddingChange: (adding: number | null) => void;
  onCellChange: (change: AccessCellChange) => void;
  onAllowAgents: (server: string) => void;
  onSave: (body: ProjectPatchBody) => Promise<void>;
}) {
  const phone = useIsPhone();
  return (
    <>
      {phone ? (
        <AccessRoleList
          access={view.access}
          onCellChange={onCellChange}
          onAllowAgents={onAllowAgents}
        />
      ) : (
        <AccessTable
          access={view.access}
          onCellChange={onCellChange}
          onAllowAgents={onAllowAgents}
        />
      )}
      <p className={ACCESS_KEY}>{phone ? PHONE_KEY : KEY}</p>
      {adding !== null && (
        <AddAccessRowDialog
          key={adding}
          open
          onClose={() => onAddingChange(null)}
          view={view}
          onSave={onSave}
        />
      )}
    </>
  );
}
