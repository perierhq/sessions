import { useLayoutEffect, useState } from "react";

import {
  calculateDeskFabPosition,
  type DeskFabPosition,
} from "../lib/desk-fab-position";
import { onSafeAreaChange, readSafeAreaInsets } from "../lib/safe-area";
import { SIDE_RAIL_CLASS } from "../lib/side-rail";

const COMPOSER_ANCHOR_SELECTOR = ".detail-pane div:has(> .composer)";
const DETAIL_PANE_SELECTOR = ".detail-pane";

function samePosition(
  current: DeskFabPosition | undefined,
  next: DeskFabPosition | undefined,
): boolean {
  return current?.left === next?.left && current?.bottom === next?.bottom;
}

/**
 * Track the rightmost composer column, which is the one the global Desk
 * trigger can overlap. Measuring the placement avoids Chrome's sticky
 * `position-try` fallback, which does not return to its preferred position
 * after a narrow viewport widens again.
 */
export function useDeskFabPosition(
  enabled: boolean,
  layoutKey: string,
): DeskFabPosition | undefined {
  const [position, setPosition] = useState<DeskFabPosition>();

  useLayoutEffect(() => {
    if (!enabled) {
      setPosition(undefined);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const anchors = document.querySelectorAll<HTMLElement>(
        COMPOSER_ANCHOR_SELECTOR,
      );
      // In a side status column the trigger has a fixed place of its own
      // (DESK_FAB), clear of every composer.
      const anchor = document.documentElement.classList.contains(
        SIDE_RAIL_CLASS,
      )
        ? null
        : anchors.item(anchors.length - 1);
      const insets = anchor ? readSafeAreaInsets() : undefined;
      const next =
        anchor && insets
          ? calculateDeskFabPosition(
              anchor.getBoundingClientRect(),
              { width: window.innerWidth, height: window.innerHeight },
              { right: insets.right, bottom: insets.bottom },
            )
          : undefined;
      setPosition((current) => (samePosition(current, next) ? current : next));
    };
    const scheduleMeasure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("resize", scheduleMeasure);
    // The insets can arrive after boot with no resize; the side status column
    // (lib/side-rail.ts) turns on with them and this placement stands down.
    const stopWatchingInsets = onSafeAreaChange(scheduleMeasure);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(scheduleMeasure);
    if (resizeObserver) {
      for (const pane of document.querySelectorAll(DETAIL_PANE_SELECTOR))
        resizeObserver.observe(pane);
      for (const anchor of document.querySelectorAll(COMPOSER_ANCHOR_SELECTOR))
        resizeObserver.observe(anchor);
    }

    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      stopWatchingInsets();
      resizeObserver?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, layoutKey]);

  return position;
}
