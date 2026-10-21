import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useSecondsLeft } from "../hooks/useSecondsLeft";
import { type CountdownFormat, formatCountdown } from "../lib/countdown";
import { cn } from "./cn";
import { duration, ease } from "./motion";

/**
 * The time left until `deadline`, rolling in place: each value rolls down
 * through the slot as the next one takes its place, the way a mechanical
 * counter turns. The slot is as wide as the longest value this deadline
 * shows, so the control around it never changes width as it counts down.
 * Reduced motion swaps the values without rolling (MotionConfig in App).
 */
export function CountdownDigits({
  deadline,
  format,
  className,
}: {
  deadline: number;
  format: CountdownFormat;
  className?: string;
}) {
  const seconds = useSecondsLeft(deadline) ?? 1;
  const [startedAt] = useState(() => Date.now());
  const widest = Math.max(
    formatCountdown(Math.ceil((deadline - startedAt) / 1000), format).length,
    formatCountdown(seconds, format).length,
  );
  const text = formatCountdown(seconds, format);
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block overflow-hidden text-center font-medium tabular-nums",
        className,
      )}
      style={{ width: `${widest}ch` }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={text}
          className="inline-block"
          initial={{ y: "-100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={{ type: "tween", duration: duration.base, ease }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
