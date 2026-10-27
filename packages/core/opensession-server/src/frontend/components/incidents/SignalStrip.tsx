import { useRef, useState } from "react";
import type { StripLane, StripResponse } from "../../../shared/incidents";
import { useElementWidth } from "../../hooks/useElementWidth";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useSecondsLeft } from "../../hooks/useSecondsLeft";
import {
  STRIP_AXIS,
  STRIP_HEADER,
  STRIP_LANE,
  STRIP_LANE_LABEL,
  STRIP_LANES_SCROLL,
  STRIP_LIVE_EDGE,
  STRIP_MARKER_LABEL,
  STRIP_MARKER_LINE,
  STRIP_MARKER_ROW,
  STRIP_THRESHOLD_LABEL,
  STRIP_VERIFY_LANE,
} from "../../lib/incident-classes";
import {
  barIndexAt,
  type LaidLane,
  type LaidMarker,
  layoutStrip,
  liveLineText,
  loadingStrip,
  RESULT_WORD,
  STRIP_LANES_VISIBLE,
  type StripLaneMeta,
  type StripLayout,
  type StripLiveLine,
} from "../../lib/incidents/strip-layout";
import { DOT_BG } from "../../lib/incidents/tone";
import { clockTime } from "../../lib/time";
import { BarStrip } from "../../ui/bar-strip";
import { Button } from "../../ui/button";
import { ChartTooltip } from "../../ui/chart-tooltip";
import { cn } from "../../ui/cn";
import { ResponsiveDialog } from "../../ui/sheet";
import { IconChevronLeft, IconChevronRight, IconX } from "../icons";
import { ObservationDetail } from "./ObservationDetail";

/** Marker label rows: two above the lanes, one below for future markers
 *  when there are any. */
const MARKER_ROW_PX = 18;
const LANE_LABEL_PX = 16;
const AXIS_PX = 16;
/** Keeps a tooltip centred on its bar but inside the strip. */
const TOOLTIP_HALF_PX = 96;

const ANCHOR: Record<LaidMarker["anchor"], string> = {
  start: "",
  middle: "-translate-x-1/2",
  end: "-translate-x-full",
};

function MarkerLabels({ markers }: { markers: LaidMarker[] }) {
  return (
    <div className={STRIP_MARKER_ROW}>
      {markers.map((m) => (
        <span
          key={m.key}
          className={cn(STRIP_MARKER_LABEL, "px-1", ANCHOR[m.anchor])}
          style={{ left: m.x }}
        >
          {m.text}
        </span>
      ))}
    </div>
  );
}

/** Re-renders each second on its own, so the strip does not. */
function LiveCountdown({ nextRunAt }: { nextRunAt: string }) {
  useSecondsLeft(Date.parse(nextRunAt));
  return <>{liveLineText({ kind: "http", nextRunAt, now: Date.now() })}</>;
}

function LiveLine({ live }: { live: StripLiveLine }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", DOT_BG[live.tone])}
      />
      {live.nextRunAt ? (
        <LiveCountdown nextRunAt={live.nextRunAt} />
      ) : (
        live.text
      )}
    </span>
  );
}

function tooltipLines(lane: LaidLane, index: number): string[] {
  const bar = lane.source[index];
  if (!bar) return [];
  const when = `${clockTime(bar.start)}–${clockTime(bar.end)}`;
  if (bar.result === null) return [when, "No data"];
  return [when, RESULT_WORD[bar.result], bar.sample?.detail ?? ""].filter(
    Boolean,
  );
}

/**
 * A signal's strip, drawn at `layout.width`: a title and live line, marker
 * labels above (past) and below (future), lanes of bars with marker lines
 * through them, and the live edge. Presentational: the hovered or
 * keyboard-selected bar is `activeIndex`, a time slot shared by every lane.
 */
export function SignalStripView({
  layout,
  title,
  live,
  onOpen,
  activeIndex,
  onActiveIndexChange,
  phone = false,
}: {
  layout: StripLayout;
  title: string;
  live: StripLiveLine | null;
  onOpen: (laneIndex: number, barIndex: number) => void;
  activeIndex: number | null;
  onActiveIndexChange: (index: number | null) => void;
  /** Lanes grow to a 44px touch target. */
  phone?: boolean;
}) {
  const [focusLane, setFocusLane] = useState(0);
  const [tipLane, setTipLane] = useState(0);
  // The tooltip is drawn on the strip, not inside its lane: with many lanes
  // the lanes sit in a scroll box, and a tooltip above the top lane would be
  // clipped by it. `tipTop` is the hovered lane's top, measured on the strip.
  const [tipTop, setTipTop] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const placeTip = (lane: HTMLElement) => {
    const strip = stripRef.current;
    if (!strip) return;
    setTipTop(
      lane.getBoundingClientRect().top - strip.getBoundingClientRect().top,
    );
  };
  const lanes = layout.lanes;
  const scroll = lanes.length > STRIP_LANES_VISIBLE;
  const lastPast = layout.pastSlots - 1;
  const past = layout.markers.filter((m) => !m.future);
  const ahead = layout.markers.filter((m) => m.future);
  const axis = lanes.find((l) => l.axis)?.axis;
  // The row under the lanes is there only for future markers.
  const belowPx = (ahead.length ? MARKER_ROW_PX : 0) + (axis ? AXIS_PX : 0);
  const tip =
    activeIndex !== null && lanes[tipLane]
      ? tooltipLines(lanes[tipLane], activeIndex)
      : [];
  const tipText = tip.join(", ");
  const tipX =
    activeIndex === null
      ? 0
      : Math.max(
          Math.min(TOOLTIP_HALF_PX, layout.width / 2),
          Math.min(
            layout.width - TOOLTIP_HALF_PX,
            (activeIndex + 0.5) * layout.slotWidth,
          ),
        );

  const xIn = (e: React.MouseEvent<HTMLElement>) =>
    e.clientX - e.currentTarget.getBoundingClientRect().left;

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>, li: number) => {
    if (lastPast < 0) return;
    const set = (i: number) => {
      e.preventDefault();
      setTipLane(li);
      onActiveIndexChange(Math.max(0, Math.min(lastPast, i)));
    };
    const focusSibling = (next: number) => {
      e.preventDefault();
      if (next < 0 || next >= lanes.length) return;
      e.currentTarget
        .closest("[data-strip]")
        ?.querySelector<HTMLElement>(`[data-lane="${next}"]`)
        ?.focus();
    };
    switch (e.key) {
      case "ArrowLeft":
        return set((activeIndex ?? lastPast + 1) - 1);
      case "ArrowRight":
        return set((activeIndex ?? lastPast - 1) + 1);
      case "Home":
        return set(0);
      case "End":
        return set(lastPast);
      case "ArrowUp":
        return focusSibling(li - 1);
      case "ArrowDown":
        return focusSibling(li + 1);
      case "Enter":
      case " ":
        e.preventDefault();
        onOpen(li, activeIndex ?? lastPast);
        return;
      case "Escape":
        if (activeIndex !== null) {
          e.preventDefault();
          onActiveIndexChange(null);
        }
        return;
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-1" aria-label={title}>
      <div className={STRIP_HEADER}>
        <span className="min-w-0 truncate">{title}</span>
        {live && <LiveLine live={live} />}
      </div>
      <div ref={stripRef} className="relative w-full" data-strip>
        {/* Row 1 sits furthest from the lanes; row 0 right above them. */}
        <MarkerLabels markers={past.filter((m) => m.row === 1)} />
        <MarkerLabels markers={past.filter((m) => m.row === 0)} />
        <div className={scroll ? STRIP_LANES_SCROLL : undefined}>
          {lanes.map((lane, li) => {
            const height = lane.verification
              ? phone
                ? 44
                : 20
              : phone
                ? 44
                : 36;
            return (
              <div key={lane.id}>
                {lane.showLabel && (
                  <span className={STRIP_LANE_LABEL}>{lane.label}</span>
                )}
                <div
                  role="group"
                  data-lane={li}
                  tabIndex={li === focusLane ? 0 : -1}
                  aria-label={`${lane.label}, ${layout.pastSlots} bars. Use arrow keys`}
                  className={lane.verification ? STRIP_VERIFY_LANE : STRIP_LANE}
                  onFocus={(e) => {
                    setFocusLane(li);
                    setTipLane(li);
                    placeTip(e.currentTarget);
                  }}
                  onPointerMove={(e) => {
                    if (e.pointerType !== "mouse") return;
                    setTipLane(li);
                    placeTip(e.currentTarget);
                    onActiveIndexChange(barIndexAt(layout, xIn(e)));
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === "mouse") onActiveIndexChange(null);
                  }}
                  onClick={(e) => {
                    const i = barIndexAt(layout, xIn(e));
                    if (i !== null) onOpen(li, i);
                  }}
                  onKeyDown={(e) => onKeyDown(e, li)}
                >
                  <BarStrip
                    bars={lane.bars}
                    width={layout.width}
                    height={height}
                    gap={layout.slotWidth > 4 ? 2 : 1}
                    radius={2}
                    threshold={lane.threshold}
                    activeIndex={activeIndex}
                    ariaLabel={lane.label}
                    className="pointer-events-none"
                  />
                  {lane.thresholdLabel && lane.threshold !== undefined && (
                    <span
                      className={STRIP_THRESHOLD_LABEL}
                      style={{ top: `${(1 - lane.threshold) * 100}%` }}
                    >
                      {lane.thresholdLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {tip.length > 0 && (
          <ChartTooltip
            className="z-30 max-w-48 -translate-x-1/2 -translate-y-[calc(100%+6px)]"
            style={{ left: tipX, top: tipTop }}
          >
            {tip.map((line, i) => (
              <div
                key={line}
                className={cn(
                  "truncate text-meta leading-4.5",
                  i === 0 ? "font-medium text-fg" : "text-dim",
                )}
              >
                {line}
              </div>
            ))}
          </ChartTooltip>
        )}
        {ahead.length > 0 && <MarkerLabels markers={ahead} />}
        {axis && (
          <div className={STRIP_AXIS}>
            <span>{axis.min}</span>
            <span>{axis.max}</span>
          </div>
        )}
        {past.map((m) => (
          <span
            key={m.key}
            aria-hidden
            className={STRIP_MARKER_LINE}
            style={{
              left: m.x,
              top: m.row === 1 ? MARKER_ROW_PX : MARKER_ROW_PX * 2,
              bottom: belowPx,
            }}
          />
        ))}
        {ahead.map((m) => (
          <span
            key={m.key}
            aria-hidden
            className={STRIP_MARKER_LINE}
            style={{ left: m.x, top: MARKER_ROW_PX * 2, bottom: belowPx }}
          />
        ))}
        {layout.liveEdgeX !== null && (
          <span
            aria-hidden
            className={STRIP_LIVE_EDGE}
            style={{
              left: layout.liveEdgeX,
              top: MARKER_ROW_PX * 2,
              bottom: belowPx,
            }}
          />
        )}
        <span className="sr-only" aria-live="polite">
          {tipText}
        </span>
      </div>
    </section>
  );
}

/**
 * A signal strip that measures its own width, owns hover, keyboard and the
 * observation dialog, and keeps its final height while `strip` loads.
 */
export function SignalStrip({
  strip,
  meta,
  verification,
  future,
  annotations,
  live,
  title,
  liveLine,
}: {
  strip: StripResponse | undefined;
  meta: (lane: StripLane) => StripLaneMeta;
  verification?: StripLane[];
  future?: Array<{ at: string; label: string }>;
  /** Labelled times inside the strip's range, drawn with its markers. */
  annotations?: Array<{ at: string; label: string }>;
  live: boolean;
  title: string;
  liveLine: StripLiveLine | null;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const phone = useIsPhone();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ lane: number; index: number } | null>(
    null,
  );
  const [detailOpen, setDetailOpen] = useState(false);
  const layout = layoutStrip({
    strip: strip ?? loadingStrip(title),
    meta: strip
      ? meta
      : () => ({ kind: "passfail", label: title, format: String }),
    verification: strip ? verification : undefined,
    future,
    annotations: strip ? annotations : undefined,
    width,
    live,
  });

  const openable = (lane: number, index: number) => {
    const laid = layout.lanes[lane];
    const bar = laid?.source[index];
    if (!strip || !bar) return false;
    return !(laid.verification && bar.result === null);
  };
  const open = (lane: number, index: number) => {
    if (!openable(lane, index)) return;
    setDetail({ lane, index });
    setDetailOpen(true);
  };
  const shownLane = detail ? layout.lanes[detail.lane] : undefined;
  const shownBar = detail ? shownLane?.source[detail.index] : undefined;
  const stripLane = detail && strip ? strip.lanes[detail.lane] : undefined;
  const format = stripLane ? meta(stripLane).format : String;
  const step = (by: number) => {
    if (!detail) return;
    const index = detail.index + by;
    if (index < 0 || index >= layout.pastSlots) return;
    setDetail({ lane: detail.lane, index });
  };

  return (
    <div ref={ref} className="min-w-0">
      <SignalStripView
        layout={layout}
        title={title}
        live={liveLine}
        onOpen={open}
        activeIndex={strip ? activeIndex : null}
        onActiveIndexChange={setActiveIndex}
        phone={phone}
      />
      <ResponsiveDialog
        open={detailOpen && !!shownBar}
        onClose={() => setDetailOpen(false)}
        phone={phone}
        label={shownLane?.label ?? title}
      >
        {(dismiss) =>
          shownLane &&
          shownBar &&
          detail && (
            <div className="flex flex-col gap-4 px-5 pt-4 pb-5 phone:px-4">
              <header className="flex items-center gap-3">
                <h2 className="m-0 min-w-0 flex-1 truncate text-dialog-title font-semibold text-fg">
                  {shownLane.label}
                </h2>
                <Button
                  variant="ghost"
                  size="lg"
                  className="phone:min-h-11 phone:min-w-11"
                  aria-label="Close"
                  icon={<IconX />}
                  onClick={dismiss}
                />
              </header>
              <ObservationDetail
                bar={shownBar}
                laneLabel={shownLane.label}
                format={format}
              />
              <div className="flex gap-2">
                <Button
                  variant="soft"
                  size="lg"
                  className="min-h-11"
                  icon={<IconChevronLeft />}
                  disabled={detail.index <= 0}
                  onClick={() => step(-1)}
                >
                  Earlier
                </Button>
                <Button
                  variant="soft"
                  size="lg"
                  className="min-h-11"
                  trailing={<IconChevronRight />}
                  disabled={detail.index >= layout.pastSlots - 1}
                  onClick={() => step(1)}
                >
                  Later
                </Button>
              </div>
            </div>
          )
        }
      </ResponsiveDialog>
    </div>
  );
}
