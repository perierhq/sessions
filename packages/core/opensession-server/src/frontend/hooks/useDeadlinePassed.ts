import { useEffect, useState } from "react";

/**
 * Whether `deadline` (in `Date.now()` terms) has passed: true on the first
 * render when it already has, and flipped by one timer when it does while
 * mounted. A new deadline starts over.
 */
export function useDeadlinePassed(deadline: number): boolean {
  const [passedFor, setPassedFor] = useState<number | null>(() =>
    Date.now() >= deadline ? deadline : null,
  );
  useEffect(() => {
    const ms = deadline - Date.now();
    const timer = setTimeout(() => setPassedFor(deadline), Math.max(0, ms));
    return () => clearTimeout(timer);
  }, [deadline]);
  return passedFor === deadline;
}
