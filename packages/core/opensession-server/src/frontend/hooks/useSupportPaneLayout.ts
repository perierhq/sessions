import { useEffect, useState } from "react";
import { useIsPhone } from "./useIsPhone";

/**
 * Where a support conversation's identity and actions go. `inBar`: the
 * subject and customer sit in a top bar of the pane's own (asked for with
 * `headerInBar`, never on a phone, where that bar is the app's back
 * control). `actionsInBar`: the pane is at least `actionsInBarMin` wide, so
 * the actions fit in that bar beside the subject; narrower, they take a row
 * at the top of the thread.
 *
 * The pane is much narrower than the window (the app sidebar and the queue
 * column take most of it), so a viewport query cannot answer this; the pane
 * is measured instead. Pass `paneRef` to the pane's root. The node is held
 * in state rather than a ref so the measuring effect runs once it attaches.
 */
export function useSupportPaneLayout(
  headerInBar: boolean | undefined,
  actionsInBarMin: number,
) {
  const isPhone = useIsPhone();
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    if (!paneEl) return;
    setPaneWidth(paneEl.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => {
      setPaneWidth(entry.contentRect.width);
    });
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, [paneEl]);
  const inBar = !!headerInBar && !isPhone;
  return {
    paneRef: setPaneEl,
    inBar,
    actionsInBar: inBar && paneWidth >= actionsInBarMin,
  };
}
