// Whether email support is on: the email integration is active. Inboxes
// (routes/support-inboxes.ts) and project knowledge (routes/knowledge.ts)
// answer only while it is.
import { activeIntegrations } from "../integrations/load";

let enabledOverride: boolean | undefined;

/** Pretend the email integration is (or isn't) on; undefined restores. */
export function __setEmailSupportEnabledForTest(
  enabled: boolean | undefined,
): void {
  enabledOverride = enabled;
}

export function emailSupportEnabled(): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  try {
    return activeIntegrations().some((spec) => spec.id === "email");
  } catch {
    return false;
  }
}
