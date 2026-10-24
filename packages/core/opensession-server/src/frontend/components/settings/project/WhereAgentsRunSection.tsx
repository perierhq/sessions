import type {
  ProjectDefaultsView,
  ProjectSettingsView,
  RunPlace,
} from "../../../../shared/project-settings";
import { useSandboxStatus } from "../../../hooks/useSettingsResources";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import {
  ROLE_GRID,
  ROLE_GRID_LABEL,
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
import { IconCheck, IconReturn, IconX } from "../../icons";
import { SettingChip } from "./SettingChip";

/**
 * Where the project's agents run: its sandbox (or the global default),
 * what each role ends up on, and where Portal opens previews.
 */
export function WhereAgentsRunSection({
  view,
  defaults,
  onSave,
}: {
  view: ProjectSettingsView;
  defaults: ProjectDefaultsView | undefined;
  onSave: (body: ProjectPatchBody) => void;
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
  return (
    <SettingCard>
      <SettingGroup>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Sandbox</SettingRowTitle>
            <SettingRowDescription>{copy.description}</SettingRowDescription>
          </SettingRowText>
          <div className={ROW_CONTROLS}>
            <SettingChip
              chip={copy.chip}
              subject="the sandbox"
              onReset={() => onSave({ sandbox: "default" })}
            />
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
        {effective.note && <p className={ROLE_GRID_NOTE}>{effective.note}</p>}
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
    </SettingCard>
  );
}

/** One role's place: a check where it runs as set, a return arrow where
 *  it falls back to the default, a cross where it can't start. */
function RunPlaceCell({ label, place }: { label: string; place: RunPlace }) {
  let mark;
  let text: string;
  if (place.state === "cant-start") {
    mark = <IconX size={14} dense className="text-red" />;
    text = "Can't start";
  } else {
    mark =
      place.source === "default" ? (
        <IconReturn size={14} dense className="text-dim" />
      ) : (
        <IconCheck size={14} dense className="text-green" />
      );
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
        {place.state === "ok" && place.source === "default" && (
          <span className="sr-only">, from the global default</span>
        )}
      </div>
    </div>
  );
}
