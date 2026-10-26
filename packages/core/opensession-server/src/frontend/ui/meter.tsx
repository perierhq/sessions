import {
  USAGE_TONE_CLASSES,
  type UsageTone,
  usageTone,
} from "../lib/usage-tone";
import { cn } from "./cn";

/** The 4px track and its fill alone: a usage meter without the words, for a
 *  budget beside an amount. Colour follows usageTone; unknown is empty.
 *  `tone` fixes the fill for a meter that isn't usage (an import's
 *  progress, where a full bar is good news, not a warning). */
export function MeterTrack({
  pct,
  tone,
  className,
  ...aria
}: {
  /** 0-100, or null when the value is unknown. */
  pct: number | null;
  tone?: UsageTone;
  className?: string;
  /** Names the track as a progress bar for assistive tech. */
  "aria-label"?: string;
}) {
  const label = aria["aria-label"];
  return (
    <div
      className={cn("h-1 overflow-hidden rounded-full bg-active", className)}
      role={label ? "progressbar" : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label && pct !== null ? Math.round(pct) : undefined}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          USAGE_TONE_CLASSES[tone ?? usageTone(pct)],
        )}
        style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
      />
    </div>
  );
}

/**
 * Usage windows sit beside each other so three limits add one compact strip
 * instead of three lines to every account. Each window owns its alignment,
 * which also lets Codex wrap a fourth window without changing its neighbours.
 * Phones keep one window per line because the same strip would be unreadable
 * at that width.
 */
export function MeterGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 grid max-w-[420px] grid-cols-3 gap-3 text-meta phone:grid-cols-1 phone:gap-1.5">
      {children}
    </div>
  );
}

/** One compact limit: label and value, track, then its reset time. */
export function Meter({
  label,
  labelTitle,
  pct,
  value,
  note,
  noteTitle,
}: {
  label: string;
  labelTitle?: string;
  /** 0-100, or null when the value is unknown. The track renders empty. */
  pct: number | null;
  value: React.ReactNode;
  note?: React.ReactNode;
  noteTitle?: string;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 phone:grid-cols-[minmax(0,1fr)_72px_minmax(38px,auto)] phone:gap-x-2 phone:gap-y-0">
      {/* `contents` gives the desktop label and reset time separate rows.
			    On phones they become one cell beside the track and value. */}
      <span className="min-w-0 phone:overflow-visible phone:whitespace-normal desktop:contents">
        <span
          className="overflow-hidden text-ellipsis whitespace-nowrap text-dim desktop:col-start-1 desktop:row-start-1"
          title={labelTitle}
        >
          {label}
        </span>
        {note ? (
          <span
            className="overflow-hidden text-ellipsis whitespace-nowrap text-faint desktop:col-span-2 desktop:row-start-3"
            title={noteTitle}
          >
            <span className="phone:inline desktop:hidden"> · </span>
            {note}
          </span>
        ) : null}
      </span>
      <MeterTrack
        pct={pct}
        className="desktop:col-span-2 desktop:row-start-2 phone:col-start-2 phone:row-start-1"
      />
      <span className="text-right tabular-nums text-dim desktop:col-start-2 desktop:row-start-1 phone:col-start-3 phone:row-start-1">
        {value}
      </span>
    </div>
  );
}
