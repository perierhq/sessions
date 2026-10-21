import { useIncidents, useSignals } from "../../hooks/useIncidents";
import {
  incidentsToolStatus,
  RECENTLY_FIXED_MS,
} from "../../lib/incidents/sidebar";
import { DOT_BG } from "../../lib/incidents/tone";
import { cn } from "../../ui/cn";

/**
 * The dot at the end of the Incidents tool row: is anything down, waiting
 * on you, or worth a look. It reads the same two lists the band under the
 * tools reads, under the same keys, so it costs no request of its own and
 * refreshes when they do. It waits for both before drawing, so it never
 * shows one colour and then another on load, and draws nothing on an error:
 * the sidebar is not where a failed list is reported.
 */
export function IncidentsToolStatus() {
  const incidents = useIncidents({
    status: "all",
    closedWithinMs: RECENTLY_FIXED_MS,
  });
  const signals = useSignals();
  if (!incidents.data || !signals.data) return null;
  const status = incidentsToolStatus(incidents.data, signals.data);
  if (!status) return null;
  return (
    // The dot sits in a box the size of the icon rail, so it lines up with
    // the 22px glyph at the start of the row rather than the label's x-height.
    <span className="ml-auto inline-flex size-[22px] shrink-0 items-center justify-center">
      <span
        aria-hidden="true"
        className={cn("size-[7px] rounded-full", DOT_BG[status.tone])}
      />
      {/* Never colour alone: the row's name carries the state in words. */}
      <span className="sr-only">, {status.label}</span>
    </span>
  );
}
