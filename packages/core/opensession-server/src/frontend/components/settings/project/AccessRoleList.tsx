import type * as React from "react";
import { useState } from "react";
import {
  ACCESS_ROLE_DESCRIPTIONS,
  PROJECT_ROLES,
  ROLE_LABELS,
  type AccessCellChange,
  type AccessRowView,
  type AccessTableView,
  type ProjectRole,
} from "../../../../shared/project-settings";
import {
  ACCESS_GROUP_LABEL,
  ACCESS_ROW_DETAIL,
  ACCESS_ROW_WARNING,
  ACCESS_RULES,
  ROLE_CHIPS,
  ROLE_CHIP_OFF,
  ROLE_CHIP_ON,
  ROLE_LIST_CHECK_OFF,
  ROLE_LIST_CHECK_ON,
  ROLE_LIST_HINT,
  ROLE_LIST_ROW,
  ROLE_LIST_TOGGLE,
  ROLE_LIST_VALUE_BUTTON,
} from "../../../lib/project-settings-classes";
import {
  cellIsOn,
  cellSpokenLabel,
  cellTone,
  nextCellValue,
  rowIsBoolean,
  rowKeyId,
  roleForKey,
  rowSummary,
} from "../../../lib/project-settings/page-model";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { SettingCard } from "../../../ui/settings";
import { IconCheck, IconWarningTriangle } from "../../icons";
import { CellFace } from "./CellFace";
import { PlainButton } from "../../../ui/plain-button";

/**
 * What agents may use, on a phone: one role at a time, picked from a sticky
 * row of all six roles. Each row carries how many roles have it, or why
 * it can't change, so the differences stay visible while one role is shown.
 */
export function AccessRoleList({
  access,
  initialRole = "investigator",
  onCellChange,
  onAllowAgents,
}: {
  access: AccessTableView;
  initialRole?: ProjectRole;
  onCellChange: (change: AccessCellChange) => void;
  onAllowAgents: (server: string) => void;
}) {
  const [role, setRole] = useState<ProjectRole>(initialRole);
  return (
    <div>
      {/* One choice of six: a radio group, so it is one tab stop and the
          arrow keys move the choice (and the focus) between roles. */}
      <div className={ROLE_CHIPS} role="radiogroup" aria-label="Role">
        {PROJECT_ROLES.map((r) => (
          <PlainButton
            key={r}
            type="button"
            role="radio"
            aria-checked={r === role}
            tabIndex={r === role ? 0 : -1}
            data-role={r}
            className={r === role ? ROLE_CHIP_ON : ROLE_CHIP_OFF}
            onClick={() => setRole(r)}
            onKeyDown={(event) => {
              const next = roleForKey(role, event.key);
              if (!next) return;
              event.preventDefault();
              setRole(next);
              event.currentTarget.parentElement
                ?.querySelector<HTMLElement>(`[data-role="${next}"]`)
                ?.focus();
            }}
          >
            {ROLE_LABELS[r]}
          </PlainButton>
        ))}
      </div>
      <SettingCard className="mt-1.5">
        <p className={ROLE_LIST_HINT}>{ACCESS_ROLE_DESCRIPTIONS[role]}</p>
        {access.groups.map((group) => (
          <div key={group.id} className={ACCESS_RULES}>
            {group.label && (
              <div className={ACCESS_GROUP_LABEL}>{group.label}</div>
            )}
            {group.rows.map((row) =>
              roleRow(row, role, onCellChange, onAllowAgents),
            )}
          </div>
        ))}
      </SettingCard>
    </div>
  );
}

function roleRow(
  row: AccessRowView,
  role: ProjectRole,
  onCellChange: (change: AccessCellChange) => void,
  onAllowAgents: (server: string) => void,
): React.ReactNode {
  const cell = row.cells[role];
  const name = `${row.title} for ${ROLE_LABELS[role]}: ${cellSpokenLabel(cell.value, cell.label)}`;
  const change =
    role === "you" || !cell.editable
      ? null
      : nextCellValue(row.key, role, cell);
  let control: React.ReactNode;
  if (change && rowIsBoolean(row.key) && cell.value !== "blocked") {
    const on = cellIsOn(cell.value);
    control = (
      <PlainButton
        className={ROLE_LIST_TOGGLE}
        aria-label={name}
        aria-pressed={on}
        onClick={() => onCellChange(change)}
      >
        {on ? (
          <span className={ROLE_LIST_CHECK_ON}>
            <IconCheck size={16} dense aria-hidden />
          </span>
        ) : (
          <span className={ROLE_LIST_CHECK_OFF} />
        )}
      </PlainButton>
    );
  } else if (change) {
    control = (
      <PlainButton
        className={cn(ROLE_LIST_VALUE_BUTTON, cellTone(cell.value))}
        aria-label={name}
        onClick={() => onCellChange(change)}
      >
        <CellFace cell={cell} />
      </PlainButton>
    );
  } else {
    control = (
      <span
        role="img"
        aria-label={name}
        className={cn(
          "flex min-h-11 shrink-0 items-center px-2 text-supporting",
          cellTone(cell.value),
        )}
      >
        <CellFace cell={cell} />
      </span>
    );
  }
  const note = !change && cell.reason ? cell.reason : rowSummary(row);
  return (
    <div key={rowKeyId(row.key)}>
      <div className={ROLE_LIST_ROW}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-body font-medium text-fg">
            {row.warning && (
              <IconWarningTriangle
                size={15}
                dense
                className="shrink-0 text-yellow"
                aria-hidden
              />
            )}
            <span className="min-w-0">{row.title}</span>
          </div>
          {row.warning ? (
            <div className={ACCESS_ROW_WARNING}>{row.warning.text}</div>
          ) : (
            <div className={ACCESS_ROW_DETAIL}>{note}</div>
          )}
        </div>
        {control}
      </div>
      {row.warning?.fix && (
        <div className="px-5 pb-3">
          <Button
            type="button"
            variant="soft"
            className="min-h-11"
            onClick={() => onAllowAgents(row.warning!.fix!.server)}
          >
            Allow agents
          </Button>
        </div>
      )}
    </div>
  );
}
