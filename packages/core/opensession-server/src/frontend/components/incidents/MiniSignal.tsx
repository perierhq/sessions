import type { SignalView, StripResponse } from "../../../shared/incidents";
import { MINI_HEIGHT, miniBars } from "../../lib/incidents/home";
import { BarStrip } from "../../ui/bar-strip";

/**
 * The kind-specific mini signal on a home row: the signal's recent strip as
 * the incident page draws it, at `MINI_HEIGHT`. While the strip loads, the
 * same number of empty bars; an expiry signal keeps the box and draws none.
 */
export function MiniSignal({
  signal,
  strip,
  width,
}: {
  signal: SignalView;
  strip: StripResponse | undefined;
  width: number;
}) {
  const bars = miniBars(signal, strip);
  if (!bars.length || !(width > 0)) return null;
  const slot = width / bars.length;
  return (
    <BarStrip
      bars={bars}
      width={width}
      height={MINI_HEIGHT}
      gap={slot >= 4 ? 1.5 : 1}
      radius={1}
      ariaLabel={`${signal.name}, recent observations`}
    />
  );
}
