import { useEffect, useState } from "react";

/**
 * Whole seconds left until `deadline`, re-rendered on each second boundary
 * rather than on a free-running interval, so the digit flips exactly when
 * the value changes and never twice for one value. Never below 1: the
 * caller decides what the deadline itself looks like.
 */
export function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline == null) return;
    setNow(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      timer = setTimeout(
        () => {
          setNow(Date.now());
          arm();
        },
        remaining % 1000 || 1000,
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, [deadline]);
  if (deadline == null) return null;
  return Math.max(1, Math.ceil((deadline - now) / 1000));
}
