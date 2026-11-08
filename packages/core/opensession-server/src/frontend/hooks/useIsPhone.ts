import { PHONE_QUERY } from "../lib/breakpoints";
import { useMediaQuery } from "./useMediaQuery";

/** Reactive "is this a phone-width viewport?" — components use it to swap in
 * phone-specific surfaces (bottom sheets) instead of desktop popups/pages. */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
