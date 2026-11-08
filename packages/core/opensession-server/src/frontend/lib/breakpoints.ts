/**
 * The app's one breakpoint, in the one place both halves of the app read it.
 *
 * The query is authored twice by necessity: `styles/tailwind.css` declares it
 * as the `phone:` / `desktop:` variants for markup, and TypeScript needs it as
 * a string for `matchMedia`. What is not necessary is authoring it twice on the
 * TypeScript side, which is what `useIsPhone` and `useBackSwipe` each did.
 * Moving the boundary in one of them would have left the other answering for
 * the old one, and the failure is quiet: the layout flips at the new width
 * while the behaviour that layout assumes flips at the old one.
 *
 * `breakpoints.test.ts` pins this constant to the stylesheet, so moving the
 * boundary stays one edit plus a failing test that names every other place.
 */

/**
 * A phone-width viewport. The same query as the `phone:` variant in
 * `styles/tailwind.css` and the `@media (max-width: 720px)` blocks in
 * `styles/base.css`, 720 included.
 *
 * Note it is not what `max-[720px]:` compiles to. That is `< 720`, so an
 * element spelled that way drops its phone value one pixel early and disagrees
 * with everything here at exactly 720px wide.
 */
export const PHONE_QUERY = "(max-width: 720px)";

/**
 * A short viewport: a phone on its side, a foldable's outer screen turned
 * sideways, a laptop window dragged low. Height is not a second layout, so
 * nothing switches surfaces on it; it only tells fixed chrome to give up rows
 * (the sidebar's tool strip folds into a More row, see `foldSidebarTools`).
 */
export const SHORT_QUERY = "(max-height: 640px)";

/** Shorter still: the sidebar keeps two tools out instead of three. */
export const VERY_SHORT_QUERY = "(max-height: 480px)";
