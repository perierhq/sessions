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
  "Switch roles to compare. Under each row: how many roles have it, or why it can't change";

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
  onKnowledgeChange,
  onSave,
}: {
  view: ProjectSettingsView;
  /** The add sheet's key while it is open. */
  adding: number | null;
  onAddingChange: (adding: number | null) => void;
  onCellChange: (change: AccessCellChange) => void;
  onAllowAgents: (server: string) => void;
  /** A Support website's "Use as knowledge" switch changed. */
  onKnowledgeChange: (host: string, on: boolean) => void;
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
          onKnowledgeChange={onKnowledgeChange}
        />
      ) : (
        <AccessTable
          access={view.access}
          onCellChange={onCellChange}
          onAllowAgents={onAllowAgents}
          onKnowledgeChange={onKnowledgeChange}
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
