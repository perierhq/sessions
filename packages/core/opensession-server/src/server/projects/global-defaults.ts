// The global defaults every project falls back to, kept in the existing
// synchronous config stores: a model per role in the default-model store
// (`interactiveModel` for You, `<role>Model` for the others), the session
// sandbox, where previews run and the websites unattended runs may reach in
// the sandbox config. Read fresh per call, like the stores themselves.
import type { ProjectRole } from "../../shared/project-settings";
import {
  interactiveDefaultModel,
  type RoleDefaultModelKey,
  roleDefaultModel,
  setInteractiveDefaultModel,
  setRoleDefaultModel,
} from "../models";
import {
  type RunnableSandboxProviderId,
  RUNNABLE_SANDBOX_PROVIDERS,
  sandboxConfig,
} from "../sandbox/config";

const ROLE_KEYS: Record<Exclude<ProjectRole, "you">, RoleDefaultModelKey> = {
  automations: "automationsModel",
  investigator: "investigatorModel",
  verifier: "verifierModel",
  reviews: "reviewsModel",
  support: "supportModel",
};

/** A role's global default model, or undefined when the role has none of
 *  its own (You always has one: the interactive default). */
export function globalRoleDefault(role: ProjectRole): string | undefined {
  if (role === "you") return interactiveDefaultModel();
  return roleDefaultModel(ROLE_KEYS[role]) ?? undefined;
}

/** Set or clear (`null`) a role's global default model. Returns the stored
 *  id, or null once cleared; throws on an unknown model. */
export function setGlobalRoleDefault(
  role: ProjectRole,
  id: string | null,
): string | null {
  if (role === "you") {
    const before = id === null || id.trim() === "";
    const stored = setInteractiveDefaultModel(id);
    return before ? null : stored;
  }
  return setRoleDefaultModel(ROLE_KEYS[role], id);
}

function runnable(value: unknown): value is RunnableSandboxProviderId {
  return (
    typeof value === "string" &&
    (RUNNABLE_SANDBOX_PROVIDERS as readonly string[]).includes(value)
  );
}

/** The global default sandbox: a provider id, or "none" (this machine). */
export function globalSandboxDefault(): RunnableSandboxProviderId | "none" {
  const value = sandboxConfig().sessionDefault;
  return runnable(value) ? value : "none";
}

/** Where previews run by default: a provider id, or "same" (beside the
 *  session). */
export function globalPreviewsDefault(): RunnableSandboxProviderId | "same" {
  return sandboxConfig().portalDefault ?? "same";
}

/** The websites every unattended run may reach. */
export function globalWebsites(): string[] {
  return [...(sandboxConfig().automation?.egressAllowlist ?? [])];
}
