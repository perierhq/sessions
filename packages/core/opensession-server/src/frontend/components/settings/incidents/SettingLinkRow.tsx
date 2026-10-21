import type * as React from "react";
import {
  SETTING_LINK_CHEVRON,
  SETTING_LINK_DESC,
  SETTING_LINK_ROW,
  SETTING_LINK_TEXT,
  SETTING_LINK_TITLE,
  SETTING_LINK_VALUE,
  SETTING_LINK_VALUE_STACKED,
} from "../../../lib/incident-settings-classes";
import { cn } from "../../../ui/cn";
import { IconChevronRight } from "../../icons";

/**
 * A settings row that opens a dialog or a page: title and description on
 * the left, the current value and a chevron on the right, the whole row one
 * button. `stacked` drops a value of several chips under the text on a
 * phone.
 */
export function SettingLinkRow({
  title,
  description,
  value,
  leading,
  stacked = false,
  onClick,
  disabled,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  value?: React.ReactNode;
  leading?: React.ReactNode;
  stacked?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={SETTING_LINK_ROW}
      onClick={onClick}
      disabled={disabled}
    >
      {leading}
      <span className={SETTING_LINK_TEXT}>
        <span className={SETTING_LINK_TITLE}>{title}</span>
        {description != null && (
          <span className={SETTING_LINK_DESC}>{description}</span>
        )}
      </span>
      {value != null && (
        <span
          className={cn(
            SETTING_LINK_VALUE,
            stacked && SETTING_LINK_VALUE_STACKED,
          )}
        >
          {value}
        </span>
      )}
      <IconChevronRight size={20} className={SETTING_LINK_CHEVRON} />
    </button>
  );
}
