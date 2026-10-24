import type { AccessCellView } from "../../../../shared/project-settings";
import { cellLabel } from "../../../lib/project-settings/page-model";
import { IconCheck, IconLock } from "../../icons";

/** The glyph or words an access cell shows; its name comes from the
 *  control around it. */
export function CellFace({ cell }: { cell: AccessCellView }) {
  if (cell.value === "yes") return <IconCheck size={16} dense aria-hidden />;
  if (cell.value === "locked") return <IconLock size={15} dense aria-hidden />;
  return <span aria-hidden>{cellLabel(cell.value)}</span>;
}
