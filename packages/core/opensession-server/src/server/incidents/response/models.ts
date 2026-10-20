// Which models the investigator and verifier run on. The verifier should
// differ from the investigator, by default on another provider; without a
// second provider it uses another model from the same provider, and without
// that the same model. Choosing never stalls the incident.

import type {
  Independence,
  IncidentProjectSettings,
} from "../../../shared/incident-response";
import { automationModel } from "../../automations";
import {
  chooseConfiguredDefaultModel,
  configuredModelProviders,
  modelUpstreamProvider,
} from "../../model-catalog";
import { resolveModel, selectableModels } from "../../models";

export interface RoleModel {
  model: string;
  provider: string;
  label: string;
}

export interface RoleModels {
  investigator: RoleModel;
  verifier: RoleModel & { independence: Independence };
}

export interface RoleModelInput {
  investigatorModel?: string;
  verifierModel?: string;
  candidates: Array<{ id: string; label: string }>;
  configuredProviders: ReadonlySet<string>;
  defaultModel: string;
  providerOf: (id: string) => string | undefined;
}

export function independenceBetween(
  a: Pick<RoleModel, "model" | "provider">,
  b: Pick<RoleModel, "model" | "provider">,
): Independence {
  if (a.provider !== b.provider) return "other-provider";
  return a.model === b.model ? "same-model" : "same-provider";
}

export function chooseRoleModels(
  input: RoleModelInput,
): RoleModels | { error: string } {
  const labelOf = (id: string) =>
    input.candidates.find((c) => c.id === id)?.label ?? id;
  const configured = (id: string): string | undefined => {
    const provider = input.providerOf(id);
    return provider && input.configuredProviders.has(provider)
      ? provider
      : undefined;
  };

  const investigatorId = input.investigatorModel ?? input.defaultModel;
  const investigatorProvider = configured(investigatorId);
  if (!investigatorProvider)
    return { error: "No model provider is configured for incident agents" };
  const investigator: RoleModel = {
    model: investigatorId,
    provider: investigatorProvider,
    label: labelOf(investigatorId),
  };

  let verifier: RoleModel;
  if (input.verifierModel !== undefined) {
    const provider = configured(input.verifierModel);
    if (!provider)
      return { error: "The verifier model's provider is not configured" };
    verifier = {
      model: input.verifierModel,
      provider,
      label: labelOf(input.verifierModel),
    };
  } else {
    const usable = input.candidates.flatMap((c) => {
      const provider = configured(c.id);
      return provider ? [{ model: c.id, provider, label: c.label }] : [];
    });
    verifier = usable.find((c) => c.provider !== investigator.provider) ??
      usable.find(
        (c) =>
          c.provider === investigator.provider &&
          c.model !== investigator.model,
      ) ?? {
        ...investigator,
      };
  }
  return {
    investigator,
    verifier: {
      ...verifier,
      independence: independenceBetween(investigator, verifier),
    },
  };
}

/** Role models from the project settings and the configured providers.
 *  `override` is where plan 3's `AgentAccess.model` lands. */
export function resolveRoleModels(
  agents: IncidentProjectSettings["agents"],
  override?: { investigator?: string; verifier?: string },
): RoleModels | { error: string } {
  const normalize = (id: string | undefined) =>
    id === undefined ? undefined : (resolveModel(id)?.id ?? id);
  const candidates = selectableModels();
  const configuredProviders = configuredModelProviders();
  const preferred = automationModel();
  return chooseRoleModels({
    investigatorModel: normalize(
      override?.investigator ?? agents.investigatorModel,
    ),
    verifierModel: normalize(override?.verifier ?? agents.verifierModel),
    candidates,
    configuredProviders,
    defaultModel: chooseConfiguredDefaultModel(
      preferred!,
      configuredProviders,
      candidates.map((c) => c.id),
    ),
    providerOf: modelUpstreamProvider,
  });
}
