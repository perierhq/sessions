import { useState } from "react";
import {
  PROJECT_ROLES,
  ROLE_LABELS,
  type ProjectDefaultsPatch,
  type ProjectDefaultsView,
  type ProjectRole,
} from "../../../shared/project-settings";
import {
  projectSWRKey,
  revalidateProjects,
  useProjectDefaults,
} from "../../hooks/useProjects";
import {
  useModelCatalog,
  useSandboxStatus,
} from "../../hooks/useSettingsResources";
import { ApiError, patchProjectDefaults } from "../../lib/api/projects";
import { errorMessage } from "../../lib/error-message";
import {
  modelOverrides,
  parseWebsite,
  projectStatusPhrase,
  roleScopeCopy,
  sandboxUsedByCopy,
} from "../../lib/project-settings/defaults-model";
import {
  readySandboxProviders,
  sandboxProviderLabel,
} from "../../lib/ready-sandbox-providers";
import { Button } from "../../ui/button";
import { PlainButton } from "../../ui/plain-button";
import { cn } from "../../ui/cn";
import { Input } from "../../ui/input";
import { OptionSelect, Select } from "../../ui/select";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { IconX } from "../icons";
import { shortModelLabel, splitModelOptions } from "../ModelEffortSelect";
import { RepoTile } from "../RepoTile";
import { SettingLinkRow } from "./incidents/SettingLinkRow";

// Settings → Projects → Defaults: what every project uses until it sets its
// own. The server composes the view from the model default store and the
// sandbox config (routes/project-defaults.ts); each control saves on its
// own, optimistically, and puts the stored view back when a save fails.

/** A finger-sized control on a phone, the desktop size elsewhere. */
const PHONE_TARGET = "phone:min-h-11";

const PODMAN_NOTE =
  "Automations can't run on this machine. They run on the next sandbox that can run them unattended, or on this machine without a sandbox";

function sandboxChoiceLabel(id: string): string {
  if (id === "none") return "This machine";
  if (id === "podman") return "This machine · container";
  return sandboxProviderLabel(id);
}

/** The stored view with a patch laid over it, for the optimistic paint. */
function applyPatch(
  view: ProjectDefaultsView,
  patch: ProjectDefaultsPatch,
): ProjectDefaultsView {
  const models = { ...view.models };
  for (const role of PROJECT_ROLES) {
    const next = patch.models?.[role];
    if (next) models[role] = next;
  }
  return {
    ...view,
    models,
    sandbox: patch.sandbox ?? view.sandbox,
    previews: patch.previews ?? view.previews,
    websites: patch.websites ?? view.websites,
  };
}

export function DefaultsPanel({
  onOpenProject,
  onOpenSandboxes,
}: {
  onOpenProject(id: string): void;
  /** Organization → Sandboxes, where providers are connected. */
  onOpenSandboxes?(): void;
}) {
  const defaults = useProjectDefaults();
  const catalog = useModelCatalog();
  const sandbox = useSandboxStatus();
  const [website, setWebsite] = useState("");
  const [websiteError, setWebsiteError] = useState<string | null>(null);

  const view = defaults.data;

  async function save(patch: ProjectDefaultsPatch) {
    if (!view) return;
    void defaults.mutate(applyPatch(view, patch), { revalidate: false });
    await patchProjectDefaults(patch)
      .then((next) => {
        void defaults.mutate(next, { revalidate: false });
        // Project pages show the effective sandbox and models, and the
        // nav shows each project's status.
        revalidateProjects(projectSWRKey.projectDefaults());
      })
      .catch((error) => {
        toast(
          error instanceof ApiError && error.status === 403
            ? "Only a signed-in person can change this"
            : errorMessage(error, "Failed to save defaults"),
          { variant: "error" },
        );
        void defaults.mutate();
      });
  }

  function addWebsite() {
    if (!view) return;
    const parsed = parseWebsite(website);
    if ("error" in parsed) {
      setWebsiteError(parsed.error);
      return;
    }
    setWebsiteError(null);
    setWebsite("");
    if (view.websites.includes(parsed.host)) return;
    void save({ websites: [...view.websites, parsed.host] });
  }

  const header = (
    <SettingsHeader
      title="Defaults"
      description="Every project uses these until it sets its own"
    />
  );

  if (!view) {
    return (
      <SettingsPanel>
        {header}
        {defaults.error ? (
          <SettingsHint>
            {errorMessage(defaults.error, "Failed to load defaults")}
          </SettingsHint>
        ) : (
          <SettingCardSkeleton rows={3} label="Loading defaults" />
        )}
      </SettingsPanel>
    );
  }

  // Sandbox choices: this machine, the container when it is ready and
  // certified, then every other ready provider. A stored choice that is no
  // longer ready stays visible, marked, so the select never lies.
  const ready = readySandboxProviders(sandbox.data);
  const region = (provider: string) => {
    const connection = sandbox.data?.connections?.find(
      (c) => c.provider === provider,
    );
    return connection?.settings?.region || null;
  };
  const sandboxIds = [
    "none",
    ...(ready.includes("podman") ? ["podman"] : []),
    ...ready.filter((id) => id !== "podman"),
  ];
  if (!sandboxIds.includes(view.sandbox)) sandboxIds.push(view.sandbox);
  const sandboxItems = sandboxIds.map((id) => ({
    value: id,
    label: sandboxChoiceLabel(id),
    region: region(id),
    unavailable: id !== "none" && !ready.includes(id),
  }));
  const currentSandbox = sandboxItems.find((i) => i.value === view.sandbox);

  const previewOptions = [
    { value: "same", label: "Same as agents" },
    ...ready
      .filter((id) => id !== "podman")
      .map((id) => ({ value: id, label: sandboxChoiceLabel(id) })),
  ];
  if (!previewOptions.some((o) => o.value === view.previews)) {
    previewOptions.push({
      value: view.previews,
      label: `${sandboxChoiceLabel(view.previews)} · unavailable`,
    });
  }

  const catalogModels = catalog.data?.models ?? [];
  const { primary, legacy } = splitModelOptions(catalogModels);
  const modelOptions = [...primary, ...legacy].map((m) => ({
    value: m.id,
    label: m.provider === "pi" ? m.label : shortModelLabel(m.id, catalogModels),
  }));
  const optionsFor = (current: string) =>
    modelOptions.some((o) => o.value === current)
      ? modelOptions
      : [
          ...modelOptions,
          { value: current, label: shortModelLabel(current, catalogModels) },
        ];
  const overrides = modelOverrides(view);

  return (
    <SettingsPanel>
      {header}

      <SettingsGroupLabel className="mt-0">Projects</SettingsGroupLabel>
      <SettingCard>
        {view.projects.map((project) => (
          <SettingLinkRow
            key={project.id}
            leading={<RepoTile name={project.id} size={24} />}
            title={project.label}
            value={projectStatusPhrase(project)}
            onClick={() => onOpenProject(project.id)}
          />
        ))}
        {view.projects.length === 0 && (
          <SettingRow>
            <SettingRowText>
              <SettingRowDescription className="mt-0">
                No projects yet. A repository becomes a project once a session
                runs in it.
              </SettingRowDescription>
            </SettingRowText>
          </SettingRow>
        )}
      </SettingCard>

      <SettingsGroupLabel>Where agents run</SettingsGroupLabel>
      <SettingCard>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Sandbox</SettingRowTitle>
            <SettingRowDescription>
              {sandboxUsedByCopy(view)}
            </SettingRowDescription>
            {view.sandbox === "podman" && (
              <SettingRowDescription>{PODMAN_NOTE}</SettingRowDescription>
            )}
          </SettingRowText>
          <SettingRowControl>
            <Select.Root
              items={sandboxItems}
              value={view.sandbox}
              onValueChange={(next) => {
                if (next !== null && next !== view.sandbox) {
                  void save({ sandbox: String(next) });
                }
              }}
            >
              <Select.Trigger
                aria-label="Default sandbox"
                className={PHONE_TARGET}
                sizeTo={sandboxItems.map((i) =>
                  i.region ? `${i.label} ${i.region}` : i.label,
                )}
              >
                {currentSandbox?.label ?? sandboxChoiceLabel(view.sandbox)}
                {currentSandbox?.region && (
                  <span className="ml-1.5 text-faint">
                    {currentSandbox.region}
                  </span>
                )}
              </Select.Trigger>
              <Select.Popup align="end">
                {sandboxItems.map((item) => (
                  <Select.Item
                    key={item.value}
                    value={item.value}
                    disabled={item.unavailable}
                    className={PHONE_TARGET}
                  >
                    {item.label}
                    {item.region && (
                      <span className="ml-1.5 text-faint">{item.region}</span>
                    )}
                    {item.unavailable && (
                      <span className="ml-1.5 text-faint">unavailable</span>
                    )}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </SettingRowControl>
        </SettingRow>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Previews</SettingRowTitle>
            <SettingRowDescription>
              Where Portal opens the app while an agent works
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl>
            <OptionSelect
              label="Previews"
              value={view.previews}
              options={previewOptions}
              className={PHONE_TARGET}
              onChange={(next) => {
                if (next !== view.previews) void save({ previews: next });
              }}
            />
          </SettingRowControl>
        </SettingRow>
      </SettingCard>
      <SettingsHint>
        Sandbox providers are connected in{" "}
        {onOpenSandboxes ? (
          <PlainButton
            className="relative text-dim underline decoration-line-strong underline-offset-2 before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[''] hover:text-fg"
            onClick={onOpenSandboxes}
          >
            Organization → Sandboxes
          </PlainButton>
        ) : (
          "Organization → Sandboxes"
        )}
      </SettingsHint>

      <SettingsGroupLabel>Models</SettingsGroupLabel>
      <SettingCard>
        {PROJECT_ROLES.map((role: ProjectRole) => (
          <SettingRow key={role}>
            <SettingRowText>
              <SettingRowTitle>{ROLE_LABELS[role]}</SettingRowTitle>
              <SettingRowDescription>
                {roleScopeCopy(role, view.projects, overrides)}
              </SettingRowDescription>
            </SettingRowText>
            <SettingRowControl>
              <OptionSelect
                label={`${ROLE_LABELS[role]} default model`}
                value={view.models[role]}
                options={optionsFor(view.models[role])}
                className={PHONE_TARGET}
                disabled={!catalog.data}
                onChange={(next) => {
                  if (next !== view.models[role]) {
                    void save({ models: { [role]: next } });
                  }
                }}
              />
            </SettingRowControl>
          </SettingRow>
        ))}
      </SettingCard>

      <SettingsGroupLabel>Websites every agent may open</SettingsGroupLabel>
      <SettingCard>
        <SettingRow className="flex-col items-stretch">
          {view.websites.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {view.websites.map((host) => (
                <li
                  key={host}
                  className="flex items-center gap-1 rounded-control bg-hover py-1 pl-2.5 pr-1 text-supporting text-fg"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {host}
                  </span>
                  <PlainButton
                    aria-label={`Remove ${host}`}
                    className="relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-faint before:absolute before:-inset-2.5 before:content-[''] hover:bg-hover hover:text-fg"
                    onClick={() =>
                      void save({
                        websites: view.websites.filter((w) => w !== host),
                      })
                    }
                  >
                    <IconX size={16} />
                  </PlainButton>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addWebsite();
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Website"
                value={website}
                placeholder="status.example.test"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
                aria-invalid={websiteError ? true : undefined}
                className={cn(
                  "phone:h-11 phone:text-input-phone",
                  websiteError && "border-red",
                )}
                onChange={(e) => {
                  setWebsite(e.target.value);
                  if (websiteError) setWebsiteError(null);
                }}
              />
              {websiteError && (
                <div className="mt-1.5 text-supporting text-red" role="alert">
                  {websiteError}
                </div>
              )}
            </div>
            <Button type="submit" className={PHONE_TARGET}>
              Add
            </Button>
          </form>
        </SettingRow>
      </SettingCard>
      <SettingsHint>
        Unattended runs can only open these websites and the ones a project
        adds. You can open any website
      </SettingsHint>
    </SettingsPanel>
  );
}
