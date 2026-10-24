import type { SettingChip as Chip } from "../../../lib/project-settings/page-model";
import {
  SETTING_CHIP_BUTTON,
  SETTING_CHIP_DEFAULT,
  SETTING_CHIP_SET,
} from "../../../lib/project-settings-classes";
import { cn } from "../../../ui/cn";
import { Tooltip } from "../../../ui/tooltip";
import { PlainButton } from "../../../ui/plain-button";

/**
 * "Default" or "Set here", in one slot of one shape: only the paint
 * changes. "Set here" is also the way back to the default, on click or
 * tap, with a 44px target around the chip.
 */
export function SettingChip({
  chip,
  subject,
  onReset,
}: {
  chip: Chip;
  /** What the chip is about, for its accessible name ("Reviews"). */
  subject: string;
  onReset: () => void;
}) {
  if (chip === "Default")
    return <span className={SETTING_CHIP_DEFAULT}>Default</span>;
  return (
    <Tooltip label="Use the default">
      <PlainButton
        className={cn(SETTING_CHIP_SET, SETTING_CHIP_BUTTON)}
        aria-label={`Set here. Use the default for ${subject}`}
        onClick={onReset}
      >
        Set here
      </PlainButton>
    </Tooltip>
  );
}
