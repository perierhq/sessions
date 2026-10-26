import type * as React from "react";
import {
  PROJECT_ROLES,
  ROLE_LABELS,
  type AccessCellChange,
  type AccessRowView,
  type AccessTableView,
  type ProjectRole,
} from "../../../../shared/project-settings";
import {
  ACCESS_ALLOW,
  ACCESS_CELL_BUTTON,
  ACCESS_CELL_STATIC,
  ACCESS_GRID,
  ACCESS_GROUP_LABEL,
  ACCESS_HEAD_CELL,
  ACCESS_ROW_DETAIL,
  ACCESS_ROW_TITLE,
  ACCESS_ROW_WARNING,
  ACCESS_RULES,
  ACCESS_TITLE_CELL,
  HIT_44,
} from "../../../lib/project-settings-classes";
import {
  cellIsOn,
  cellSpokenLabel,
  cellTone,
  nextCellValue,
  rowIsBoolean,
  rowKeyId,
} from "../../../lib/project-settings/page-model";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { Popover } from "../../../ui/popover";
import { SettingCard } from "../../../ui/settings";
import { IconWarningTriangle } from "../../icons";
import { CellFace } from "./CellFace";
import { PlainButton } from "../../../ui/plain-button";

/**
 * What agents may use, on a desktop: a row per capability and a column per
 * role, six equal columns, every editable cell a button. A cell that can't
 * change says why on hover, focus or tap.
 */
export function AccessTable({
  access,
  onCellChange,
  onAllowAgents,
}: {
  access: AccessTableView;
  onCellChange: (change: AccessCellChange) => void;
  onAllowAgents: (server: string) => void;
}) {
  return (
    <SettingCard role="table" aria-label="What agents may use">
      <div role="row" className={ACCESS_GRID}>
        <span role="columnheader">
          <span className="sr-only">Capability</span>
        </span>
        {PROJECT_ROLES.map((role) => (
          <span key={role} role="columnheader" className={ACCESS_HEAD_CELL}>
            {ROLE_LABELS[role]}
          </span>
        ))}
      </div>
      {access.groups.map((group) => (
        <div key={group.id} role="rowgroup" className={ACCESS_RULES}>
          {group.label && (
            <div role="row" className={ACCESS_GRID}>
              <span role="rowheader" className={ACCESS_GROUP_LABEL}>
                {group.label}
              </span>
            </div>
          )}
          {group.rows.map((row) => accessRow(row, onCellChange, onAllowAgents))}
        </div>
      ))}
    </SettingCard>
  );
}

function accessRow(
  row: AccessRowView,
  onCellChange: (change: AccessCellChange) => void,
  onAllowAgents: (server: string) => void,
): React.ReactNode {
  return (
    <div key={rowKeyId(row.key)} role="row" className={ACCESS_GRID}>
      <div role="rowheader" className={ACCESS_TITLE_CELL}>
        <div className={ACCESS_ROW_TITLE}>
          <span className="min-w-0">{row.title}</span>
          {row.warning && (
            <IconWarningTriangle
              size={15}
              dense
              className="shrink-0 text-yellow"
              aria-hidden
            />
          )}
        </div>
        {row.warning ? (
          <div className={ACCESS_ROW_WARNING}>{row.warning.text}</div>
        ) : (
          row.detail && <div className={ACCESS_ROW_DETAIL}>{row.detail}</div>
        )}
        {row.warning?.fix && (
          <Button
            type="button"
            size="sm"
            variant="soft"
            className={cn(ACCESS_ALLOW, HIT_44)}
            onClick={() => onAllowAgents(row.warning!.fix!.server)}
          >
            Allow agents
          </Button>
        )}
      </div>
      {PROJECT_ROLES.map((role) => (
        <div key={role} role="cell" className="px-0.5">
          {accessCell(row, role, onCellChange)}
        </div>
      ))}
    </div>
  );
}

function accessCell(
  row: AccessRowView,
  role: ProjectRole,
  onCellChange: (change: AccessCellChange) => void,
): React.ReactNode {
  const cell = row.cells[role];
  const name = `${row.title} for ${ROLE_LABELS[role]}: ${cellSpokenLabel(cell.value, cell.label)}`;
  const change =
    role === "you" || !cell.editable
      ? null
      : nextCellValue(row.key, role, cell);
  if (change)
    return (
      <PlainButton
        className={cn(ACCESS_CELL_BUTTON, cellTone(cell.value))}
        aria-label={name}
        aria-pressed={rowIsBoolean(row.key) ? cellIsOn(cell.value) : undefined}
        onClick={() => onCellChange(change)}
      >
        <CellFace cell={cell} />
      </PlainButton>
    );
  const reason = cell.reason;
  if (!reason)
    return (
      <span
        role="img"
        aria-label={name}
        className={cn(ACCESS_CELL_STATIC, cellTone(cell.value))}
      >
        <CellFace cell={cell} />
      </span>
    );
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        nativeButton={false}
        render={<span tabIndex={0} />}
        aria-label={`${name}. ${reason}`}
        className={cn(ACCESS_CELL_STATIC, cellTone(cell.value))}
      >
        <CellFace cell={cell} />
      </Popover.Trigger>
      <Popover.Popup
        side="top"
        className="max-w-60 px-3 py-2 text-meta text-fg"
      >
        {reason}
      </Popover.Popup>
    </Popover.Root>
  );
}
