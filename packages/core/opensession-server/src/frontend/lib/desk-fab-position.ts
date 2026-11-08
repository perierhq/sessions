const DESK_FAB_SIZE = 44;
const DESK_FAB_EDGE_INSET = 18;
const DESK_FAB_COMPOSER_GAP = 12;
const DESK_FAB_ABOVE_GAP = 10;

export interface DeskFabAnchorRect {
  right: number;
  top: number;
}

export interface DeskFabViewport {
  width: number;
  height: number;
}

/** The safe-area insets on the two edges the trigger rests against, in px. */
export interface DeskFabInsets {
  right: number;
  bottom: number;
}

export interface DeskFabPosition {
  left: number;
  bottom: number;
}

/**
 * Keep the Desk trigger in the window corner while there is room beside the
 * composer. When that position would cross the viewport edge, put it directly
 * above the composer instead. The corner is the safe area's corner: on a
 * phone on its side or a foldable's inner screen the window's own corner is
 * under the notch or the home indicator.
 */
export function calculateDeskFabPosition(
  anchor: DeskFabAnchorRect,
  viewport: DeskFabViewport,
  insets: DeskFabInsets = { right: 0, bottom: 0 },
): DeskFabPosition {
  const safeRight = viewport.width - insets.right;
  const cornerLeft = safeRight - DESK_FAB_SIZE - DESK_FAB_EDGE_INSET;
  const besideComposerLeft = anchor.right + DESK_FAB_COMPOSER_GAP;
  const preferredLeft = Math.max(cornerLeft, besideComposerLeft);

  if (preferredLeft + DESK_FAB_SIZE <= safeRight) {
    return { left: preferredLeft, bottom: DESK_FAB_EDGE_INSET + insets.bottom };
  }

  return {
    left: anchor.right - DESK_FAB_SIZE,
    bottom: viewport.height - anchor.top + DESK_FAB_ABOVE_GAP,
  };
}
