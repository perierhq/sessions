import { cn } from "./cn";

/** What a bar says. Status tones use the reserved status tokens; `empty` is a
 *  slot with nothing in it, `missed` an expected run that never came,
 *  `future` a slot not reached yet, `none` a reserved slot drawn blank. */
export type BarTone =
  | "ok"
  | "fail"
  | "warn"
  | "neutral"
  | "empty"
  | "missed"
  | "future"
  | "none";

export interface BarSpec {
  key: string;
  tone: BarTone;
  /** 0–1 of the plot height. Hollow tones draw full height regardless. */
  height: number;
  /** The bar's tooltip text. */
  label: string;
}

const FILL: Record<"ok" | "fail" | "warn" | "neutral", string> = {
  ok: "var(--green)",
  fail: "var(--red)",
  warn: "var(--yellow)",
  neutral: "var(--text-faint)",
};

/** A stub that keeps an empty slot visible without reading as a value. */
const STUB_PX = 2;

const px = (n: number) => Math.round(n * 100) / 100;

/**
 * One SVG row of bars across `width`: slot `i` starts at `i × width / n`, each
 * bar is its slot less `gap`. Used by the automation trigger history and the
 * incident signal strips, so a run of bars reads the same everywhere.
 */
export function BarStrip({
  bars,
  height,
  width,
  gap = 2,
  radius = 3,
  threshold,
  baseline = false,
  activeIndex = null,
  ariaLabel,
  className,
}: {
  bars: BarSpec[];
  /** Plot height in px; a baseline adds one more. */
  height: number;
  width: number;
  gap?: number;
  radius?: number;
  /** A dotted line at this fraction of the plot height. */
  threshold?: number;
  baseline?: boolean;
  activeIndex?: number | null;
  ariaLabel: string;
  className?: string;
}) {
  const slot = bars.length ? width / bars.length : 0;
  const barWidth = Math.max(0, px(slot - gap));
  const rx = Math.min(radius, barWidth / 2);
  const stubRx = Math.min(1, barWidth / 2);
  const span = Math.max(0, px(width - gap));
  return (
    <svg
      width={width}
      height={baseline ? height + 1 : height}
      role="img"
      aria-label={ariaLabel}
      className={cn("block", className)}
    >
      {baseline && (
        <rect x={0} y={height} width={span} height={1} fill="var(--border)" />
      )}
      {bars.map((bar, i) => {
        const x = px(i * slot);
        switch (bar.tone) {
          case "none":
            return null;
          case "empty":
            return (
              <rect
                key={bar.key}
                x={x}
                y={height - STUB_PX}
                width={barWidth}
                height={STUB_PX}
                rx={stubRx}
                fill="var(--border)"
              >
                <title>{bar.label}</title>
              </rect>
            );
          case "missed":
          case "future":
            // Inset half the stroke so the outline stays inside its slot.
            return (
              <rect
                key={bar.key}
                x={px(x + 0.5)}
                y={0.5}
                width={Math.max(0, barWidth - 1)}
                height={Math.max(0, height - 1)}
                rx={Math.max(0, rx - 0.5)}
                fill="none"
                stroke={
                  bar.tone === "missed" ? "var(--red)" : "var(--border-strong)"
                }
                strokeWidth={1}
                strokeDasharray={bar.tone === "future" ? "2 2" : undefined}
              >
                <title>{bar.label}</title>
              </rect>
            );
          default: {
            const h = px(Math.max(0, Math.min(1, bar.height)) * height);
            return (
              <rect
                key={bar.key}
                x={x}
                y={px(height - h)}
                width={barWidth}
                height={h}
                rx={rx}
                fill={FILL[bar.tone]}
              >
                <title>{bar.label}</title>
              </rect>
            );
          }
        }
      })}
      {threshold !== undefined && (
        <line
          x1={0}
          x2={span}
          y1={px(height * (1 - threshold))}
          y2={px(height * (1 - threshold))}
          stroke="var(--text-faint)"
          strokeWidth={1}
          strokeDasharray="1 3"
          strokeLinecap="round"
        />
      )}
      {activeIndex !== null &&
        activeIndex >= 0 &&
        activeIndex < bars.length && (
          <rect
            x={px(activeIndex * slot + 0.5)}
            y={0.5}
            width={Math.max(0, barWidth - 1)}
            height={Math.max(0, height - 1)}
            rx={Math.max(0, rx - 0.5)}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={1}
          />
        )}
    </svg>
  );
}
