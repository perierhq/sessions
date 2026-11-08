/**
 * The status column rail.
 *
 * On a foldable that keeps its clock, connectivity and camera in a column down
 * one side (the iPhone Duo puts it on the right), an app installed to the Home
 * Screen gets that column as a deep right safe-area inset. The status icons
 * only take its top; the rest of it is empty, and the shell (APP_ROOT,
 * WORKSPACE_SHELL) keeps content out of all of it. With `side-rail` on the
 * root element, the controls that otherwise float over the content move into
 * the column instead, below the status icons (`--status-column-h`): the phone
 * top bar's actions, the new-session button and the Desk trigger.
 *
 * Only in the installed app. In Safari the same column holds Safari's own
 * controls, so nothing of ours may sit there. And only for a column that is
 * really there: a right inset deep enough to hold a 44px control and clearly
 * deeper than the left one, which rules out a phone on its side (its notch
 * insets both sides alike).
 */
export const SIDE_RAIL_CLASS = "side-rail";

const MIN_RAIL = 60;
const MIN_ASYMMETRY = 40;

/** Whether the insets describe a side status column worth a rail. */
export function wantsSideRail(insets: {
  right: number;
  left: number;
}): boolean {
  return (
    insets.right >= MIN_RAIL && insets.right - insets.left >= MIN_ASYMMETRY
  );
}

let started = false;

/** Idempotent; called once at boot. Folding, unfolding and rotating change the
 *  insets, so it re-measures on every resize. */
export function startSideRail(read: () => { right: number; left: number }) {
  if (started || typeof window === "undefined") return;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true);
  if (!standalone) return;
  started = true;
  const apply = () =>
    document.documentElement.classList.toggle(
      SIDE_RAIL_CLASS,
      wantsSideRail(read()),
    );
  apply();
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
}
