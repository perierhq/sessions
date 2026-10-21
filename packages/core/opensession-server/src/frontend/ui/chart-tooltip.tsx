import { cn } from "./cn";

/** The numbers a chart raises under the pointer. Opaque, unlike the app's
 *  other popups: it floats directly over the densest, most colourful thing on
 *  the page, and a translucent surface there tints every row with the bars
 *  behind it. Placement belongs to the chart, which knows its own box. */
export function ChartTooltip({
  className,
  style,
  ref,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none absolute z-10 rounded-popup [corner-shape:squircle] bg-popup",
        "px-3 py-2.5 [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
