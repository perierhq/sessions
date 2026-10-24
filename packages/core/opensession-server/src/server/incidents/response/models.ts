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
  pickerModelId,
} from "../../model-catalog";
import { resolveModel, selectableModels } from "../../models";
import { globalRoleDefault } from "../../projects/global-defaults";

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

/** The stored, picker form of a model id or alias (`opus` and
 *  `claude-opus-5-5` both become `pi/anthropic/claude-opus-5-5`). */
export function canonicalModelId(id: string): string {
  const trimmed = id.trim();
  return pickerModelId(resolveModel(trimmed)?.id ?? trimmed);
}

/** The model family a slug names, without the parts that only pick a
 *  snapshot or a route: a Bedrock region and vendor prefix
 *  (`us.anthropic.`), a Bedrock version (`-v1:0`), a `:variant`, a date
 *  (`-20250929`, `@20250929`, `-2026-08-01`) and `-latest`. Stripping the
 *  `:variant` also folds size variants (`qwen3:8b`, `qwen3:32b`) into one
 *  family, so two sizes of one model never count as independent of each
 *  other: the check errs toward asking for an independent verifier, never
 *  toward granting independence. */
function modelFamily(slug: string): string {
  return slug
    .replace(/^(?:(?:us|eu|apac|global|us-gov)\.)?[a-z]+\.(?=[a-z])/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/:[^:]*$/, "")
    .replace(/[-@](?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "");
}

function modelSlug(id: string): string {
  return modelFamily(
    (canonicalModelId(id).split("/").at(-1) ?? "").toLowerCase(),
  );
}

/** Two ids name the same model when their family matches, whatever route
 *  or snapshot reaches it (`pi/openrouter/anthropic/x`, `pi/anthropic/x`,
 *  `x-20250929`, Bedrock's `us.anthropic.x-v1:0`). */
export function sameModel(a: string, b: string): boolean {
  const slug = modelSlug(a);
  return slug !== "" && slug === modelSlug(b);
}

export function independenceBetween(
  a: Pick<RoleModel, "model" | "provider">,
  b: Pick<RoleModel, "model" | "provider">,
): Independence {
  if (sameModel(a.model, b.model)) return "same-model";
  return a.provider !== b.provider ? "other-provider" : "same-provider";
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
    const other = usable.filter((c) => !sameModel(c.model, investigator.model));
    verifier = other.find((c) => c.provider !== investigator.provider) ??
      other.find((c) => c.provider === investigator.provider) ?? {
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

type LiveInputs = Pick<
  RoleModelInput,
  "candidates" | "configuredProviders" | "defaultModel" | "providerOf"
>;
let inputsOverride: LiveInputs | undefined;

/** Replace the configured models and providers (undefined restores them). */
export function __setRoleModelInputsForTest(inputs?: LiveInputs): void {
  inputsOverride = inputs;
}

/** Role models: the project's own (`agents`), else the role's global
 *  default (Defaults page), else chosen from the configured providers. */
export function resolveRoleModels(
  agents: IncidentProjectSettings["agents"],
  override?: { investigator?: string; verifier?: string },
): RoleModels | { error: string } {
  const normalize = (id: string | undefined) =>
    id === undefined ? undefined : canonicalModelId(id);
  const live = inputsOverride;
  const candidates = live?.candidates ?? selectableModels();
  const configuredProviders =
    live?.configuredProviders ?? configuredModelProviders();
  const preferred = automationModel();
  const investigatorModel = normalize(
    override?.investigator ??
      agents.investigatorModel ??
      globalRoleDefault("investigator"),
  );
  let verifierModel = normalize(
    override?.verifier ?? agents.verifierModel ?? globalRoleDefault("verifier"),
  );
  // A global verifier default equal to the investigator's model would not
  // verify anything: choose an independent one instead.
  if (
    verifierModel &&
    investigatorModel &&
    !override?.verifier &&
    !agents.verifierModel &&
    sameModel(verifierModel, investigatorModel)
  )
    verifierModel = undefined;
  return chooseRoleModels({
    investigatorModel,
    verifierModel,
    candidates,
    configuredProviders,
    defaultModel:
      live?.defaultModel ??
      chooseConfiguredDefaultModel(
        preferred!,
        configuredProviders,
        candidates.map((c) => c.id),
      ),
    providerOf: live?.providerOf ?? modelUpstreamProvider,
  });
}

/** The project's role models, read from its settings document. */
export async function resolveProjectRoleModels(
  project: string,
): Promise<RoleModels | { error: string }> {
  const { getProjectDocument } = await import("../../projects/store");
  const doc = await getProjectDocument(project);
  const agents: IncidentProjectSettings["agents"] = {};
  if (doc.models.investigator)
    agents.investigatorModel = doc.models.investigator;
  if (doc.models.verifier) agents.verifierModel = doc.models.verifier;
  return resolveRoleModels(agents);
}
