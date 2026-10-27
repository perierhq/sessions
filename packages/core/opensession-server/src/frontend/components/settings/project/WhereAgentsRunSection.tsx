import { useEffect, useState } from "react";
import type {
  ProjectDefaultsView,
  ProjectSettingsView,
  RunPlace,
} from "../../../../shared/project-settings";
import { useSandboxStatus } from "../../../hooks/useSettingsResources";
import {
  fetchSandboxLifecycle,
  saveRepoPreSetupScript,
  type SandboxLifecycleSettings,
} from "../../../lib/api/sandboxes";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import {
  ROLE_GRID,
  ROLE_GRID_LABEL,
  ROLE_GRID_FIX,
  ROLE_GRID_FIX_NOTE,
  ROLE_GRID_NOTE,
  ROLE_GRID_VALUE,
  ROLE_GRID_VALUE_BAD,
  ROW_CONTROLS,
} from "../../../lib/project-settings-classes";
import {
  joinDots,
  RUN_PLACES,
  previewsOptions,
  sandboxName,
  sandboxOptions,
  sandboxRowCopy,
} from "../../../lib/project-settings/page-model";
import { readySandboxProviders } from "../../../lib/ready-sandbox-providers";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { OptionSelect } from "../../../ui/select";
import {
  SettingCard,
  SettingGroup,
  SettingRow,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
} from "../../../ui/settings";
import { IconCheck, IconWarningTriangle, IconX } from "../../icons";
import { SandboxScriptDialog } from "../SandboxScriptDialog";
import { SettingChip } from "./SettingChip";

/**
 * Where the project's agents run: its sandbox (or the global default),
 * what each role ends up on, and where Portal opens previews.
 */
export function WhereAgentsRunSection({
  view,
  defaults,
  onSave,
  onOpenSandboxes,
}: {
  view: ProjectSettingsView;
  defaults: ProjectDefaultsView | undefined;
  onSave: (body: ProjectPatchBody) => void;
  /** Settings, Sandboxes: where a provider gets connected. */
  onOpenSandboxes: () => void;
}) {
  const status = useSandboxStatus();
  const ready = readySandboxProviders(status.data);
  const regions: Record<string, string | undefined> = {};
  for (const connection of status.data?.connections ?? []) {
    const region = connection.settings.region;
    if (region) regions[connection.provider] = region;
  }
  const effective = view.effective.sandbox;
  const copy = sandboxRowCopy(effective);
  const defaultLabel =
    defaults && defaults.sandbox !== "none"
      ? sandboxName(defaults.sandbox, regions[defaults.sandbox])
      : defaults
        ? "This machine"
        : null;
  const sandbox = view.document.sandbox;
  const notReady = RUN_PLACES.some(
    ([key]) => effective[key].state === "not-ready",
  );
  return (
    <SettingCard>
      <SettingGroup>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Sandbox</SettingRowTitle>
            <SettingRowDescription>{copy.description}</SettingRowDescription>
          </SettingRowText>
          <div className={ROW_CONTROLS}>
            {/* On the default, the select already reads "Use default
                (…)"; only the way back from a choice of its own shows. */}
            {copy.chip === "Set here" && (
              <SettingChip
                chip={copy.chip}
                subject="the sandbox"
                onReset={() => onSave({ sandbox: "default" })}
              />
            )}
            <OptionSelect
              label="Sandbox"
              value={sandbox}
              options={sandboxOptions({
                ready,
                current: sandbox,
                defaultLabel,
                regions,
              })}
              onChange={(next) => onSave({ sandbox: next })}
              className="phone:min-h-11"
            />
          </div>
        </SettingRow>
        <div className={ROLE_GRID}>
          {RUN_PLACES.map(([key, label]) => (
            <RunPlaceCell key={key} label={label} place={effective[key]} />
          ))}
        </div>
        {notReady ? (
          <div className={ROLE_GRID_FIX}>
            {effective.note && (
              <p className={ROLE_GRID_FIX_NOTE}>{effective.note}</p>
            )}
            <Button
              size="sm"
              className="shrink-0 phone:min-h-11"
              onClick={onOpenSandboxes}
            >
              Open sandbox settings
            </Button>
          </div>
        ) : (
          effective.note && <p className={ROLE_GRID_NOTE}>{effective.note}</p>
        )}
      </SettingGroup>
      <SettingRow>
        <SettingRowText>
          <SettingRowTitle>Previews</SettingRowTitle>
          <SettingRowDescription>
            Where Portal opens the app while an agent works
          </SettingRowDescription>
        </SettingRowText>
        <div className={ROW_CONTROLS}>
          <OptionSelect
            label="Previews"
            value={view.previews}
            options={previewsOptions({
              ready,
              current: view.previews,
              regions,
            })}
            onChange={(next) => onSave({ previews: next })}
            className="phone:min-h-11"
          />
        </div>
      </SettingRow>
      <SetupScriptRow project={view.document.project} />
    </SettingCard>
  );
}

/** The project's setup script, kept in settings: it runs before
 *  `.agents/setup` in every new Sandbox and is part of the project
 *  snapshot's inputs. */
function SetupScriptRow({ project }: { project: string }) {
  const [lifecycle, setLifecycle] = useState<SandboxLifecycleSettings | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    fetchSandboxLifecycle()
      .then(setLifecycle)
      .catch(() => {});
  }, []);
  if (!lifecycle) return null;
  const script = lifecycle.preSetupScripts[project] ?? null;
  return (
    <>
      <SettingRow>
        <SettingRowText>
          <SettingRowTitle>Setup script</SettingRowTitle>
          <SettingRowDescription>
            {script
              ? "Runs before .agents/setup in every new sandbox. Changing it refreshes the project snapshot."
              : "Optional. Sets up sandboxes for this project without committing anything."}
          </SettingRowDescription>
        </SettingRowText>
        <div className={ROW_CONTROLS}>
          <Button
            size="sm"
            className="phone:min-h-11"
            onClick={() => setEditing(true)}
          >
            {script ? "Edit" : "Add"}
          </Button>
        </div>
      </SettingRow>
      <SandboxScriptDialog
        open={editing}
        onOpenChange={setEditing}
        title="Setup script"
        description="Runs from the checkout right before .agents/setup, once per new sandbox. Keep secrets in environment settings, not here."
        value={script}
        placeholder={"#!/usr/bin/env bash\nset -euo pipefail\nbun install"}
        onSave={async (next) => {
          setLifecycle(await saveRepoPreSetupScript(project, next));
        }}
      />
    </>
  );
}

/** One role's place: a check where it can run, a cross where it can't
 *  start, a warning with the reason where its sandbox provider isn't set
 *  up yet. Where it comes from the global default, screen readers hear
 *  so; the Sandbox row above already shows it. */
function RunPlaceCell({ label, place }: { label: string; place: RunPlace }) {
  let mark;
  let text: string;
  if (place.state === "cant-start") {
    mark = <IconX size={14} dense className="text-red" />;
    text = "Can't start";
  } else if (place.state === "not-ready") {
    mark = <IconWarningTriangle size={14} dense className="text-yellow" />;
    text = place.reason;
  } else {
    mark = <IconCheck size={14} dense className="text-green" />;
    text = joinDots(place.label);
  }
  return (
    <div className="min-w-0">
      <div className={ROLE_GRID_LABEL}>{label}</div>
      <div
        className={cn(
          ROLE_GRID_VALUE,
          place.state === "cant-start" && ROLE_GRID_VALUE_BAD,
        )}
      >
        <span aria-hidden className="flex shrink-0">
          {mark}
        </span>
        <span className="min-w-0 text-balance">{text}</span>
        {place.state !== "cant-start" && place.source === "default" && (
          <span className="sr-only">, from the global default</span>
        )}
      </div>
    </div>
  );
}
