import { formatVetoRemaining } from "../../shared/incident-response";

export type CountdownFormat = "seconds" | "clock";

/** Seconds left as shown in a countdown: "5", or "5:48" on the clock. */
export function formatCountdown(
  seconds: number,
  format: CountdownFormat,
): string {
  return format === "clock"
    ? formatVetoRemaining(seconds * 1000)
    : String(Math.max(0, Math.ceil(seconds)));
}
