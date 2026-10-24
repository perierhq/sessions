import {
  PROJECT_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type ProjectRole,
  type ProjectSettingsView,
} from "../../../../shared/project-settings";
import { useModelCatalog } from "../../../hooks/useSettingsResources";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import { ROW_CONTROLS } from "../../../lib/project-settings-classes";
import { modelChip } from "../../../lib/project-settings/page-model";
import { OptionSelect } from "../../../ui/select";
import {
  SettingCard,
  SettingRow,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsHint,
} from "../../../ui/settings";
import { SettingChip } from "./SettingChip";

/** The model each role runs on in this project, over the global default. */
export function ModelsSection({
  project,
  view,
  onSave,
}: {
  project: string;
  view: ProjectSettingsView;
  onSave: (body: ProjectPatchBody) => void;
}) {
  const catalog = useModelCatalog();
  const models = catalog.data?.models ?? [];
  const optionsFor = (role: ProjectRole) => {
    const current = view.effective.models[role];
    const options = models.map((m) => ({ value: m.id, label: m.label }));
    if (!options.some((o) => o.value === current.model))
      options.unshift({ value: current.model, label: current.label });
    return options;
  };
  const set = (role: ProjectRole, model: string | null) =>
    onSave({ models: { [role]: model } });
  return (
    <>
      <SettingCard>
        {PROJECT_ROLES.map((role) => {
          const current = view.effective.models[role];
          return (
            <SettingRow key={role}>
              <SettingRowText>
                <SettingRowTitle>{ROLE_LABELS[role]}</SettingRowTitle>
                <SettingRowDescription>
                  {ROLE_DESCRIPTIONS[role]}
                </SettingRowDescription>
              </SettingRowText>
              <div className={ROW_CONTROLS}>
                <SettingChip
                  chip={modelChip(current.source)}
                  subject={ROLE_LABELS[role]}
                  onReset={() => set(role, null)}
                />
                <OptionSelect
                  label={`Model for ${ROLE_LABELS[role]}`}
                  value={current.model}
                  options={optionsFor(role)}
                  onChange={(model) => set(role, model)}
                  className="phone:min-h-11"
                />
              </div>
            </SettingRow>
          );
        })}
      </SettingCard>
      <SettingsHint>
        {`Default comes from Projects → Defaults. A model set here applies to ${project} only`}
      </SettingsHint>
    </>
  );
}
