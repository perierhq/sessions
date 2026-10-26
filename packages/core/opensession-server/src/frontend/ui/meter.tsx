import {
  USAGE_TONE_CLASSES,
  type UsageTone,
  usageTone,
} from "../lib/usage-tone";
import { cn } from "./cn";

/** A fill that crosses the track on transform alone; under reduced motion
 *  it spans the track and breathes (styles/base-keyframes.css). */
const INDETERMINATE_FILL =
  "h-full w-1/3 rounded-full animate-[meter-indeterminate_1.4s_ease-in-out_infinite] " +
  "motion-reduce:w-full motion-reduce:animate-[pulse_1.4s_ease-in-out_infinite] " +
  "motion-reduce:[animation-duration:1.4s]! motion-reduce:[animation-iteration-count:infinite]!";

/** The 4px track and its fill alone: a usage meter without the words, for a
 *  budget beside an amount. Colour follows usageTone; unknown is empty.
 *  `tone` fixes the fill for a meter that isn't usage (an import's
 *  progress, where a full bar is good news, not a warning). `indeterminate`
 *  is work under way whose size isn't known yet: a moving fill, no value. */
export function MeterTrack({
  pct,
  tone,
  indeterminate = false,
  className,
  ...aria
}: {
  /** 0-100, or null when the value is unknown. */
  pct: number | null;
  tone?: UsageTone;
  indeterminate?: boolean;
  className?: string;
  /** Names the track as a progress bar for assistive tech. */
  "aria-label"?: string;
  /** What the bar stands for in words ("Reading INBOX 120 of 900"). */
  "aria-valuetext"?: string;
}) {
  const label = aria["aria-label"];
  const moving = indeterminate || undefined;
  return (
    <div
      className={cn("h-1 overflow-hidden rounded-full bg-active", className)}
      role={label ? "progressbar" : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={
        label && pct !== null && !moving ? Math.round(pct) : undefined
      }
      aria-valuetext={label ? aria["aria-valuetext"] : undefined}
    >
      {moving ? (
        <div
          className={cn(
            INDETERMINATE_FILL,
            USAGE_TONE_CLASSES[tone ?? "normal"],
          )}
        />
      ) : (
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            USAGE_TONE_CLASSES[tone ?? usageTone(pct)],
          )}
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
      )}
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
