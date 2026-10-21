import { useSecondsLeft } from "../../hooks/useSecondsLeft";
import { type CountdownFormat, formatCountdown } from "../../lib/countdown";
import { UNDO_SHORTCUT_KEYS } from "../../lib/undo";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { CountdownDigits } from "../../ui/countdown";
import { Tooltip } from "../../ui/tooltip";
import { IconUndo } from "../icons";

/**
 * The undo affordance that sits in front of the merge button during its
 * five-second window: the undo glyph plus a digit counting the seconds
 * left. The merge button itself stays put and reads "Merging…", so
 * cancelling never moves the thing the user just pressed. Other deferred
 * actions (a deploy) pass their own label and may count on the clock.
 */
export function MergeUndoControl({
  onUndo,
  deadline = null,
  compact = false,
  label = "Undo merge",
  format = "seconds",
  className,
}: {
  onUndo: () => void;
  /** When the action fires; drives the countdown. Omit for a bare glyph. */
  deadline?: number | null;
  compact?: boolean;
  /** Names the action in the tooltip and the accessible name. */
  label?: string;
  format?: CountdownFormat;
  className?: string;
}) {
  const seconds = useSecondsLeft(deadline);
  const left =
    seconds == null
      ? null
      : format === "clock"
        ? formatCountdown(seconds, "clock")
        : `${seconds}s`;
  return (
    <Tooltip label={label} shortcut={UNDO_SHORTCUT_KEYS}>
      <Button
        variant="ghost"
        size={compact ? "sm" : "md"}
        aria-label={left == null ? label : `${label}, ${left} left`}
        onClick={onUndo}
        icon={<IconUndo size={compact ? 18 : 20} />}
        iconTone="full"
        className={cn(
          "shrink-0 text-dim",
          deadline != null && "pr-2",
          className,
        )}
      >
        {deadline != null && (
          <CountdownDigits deadline={deadline} format={format} />
        )}
      </Button>
    </Tooltip>
  );
}
