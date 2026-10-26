import type { ProjectSettingsView } from "../../../../shared/project-settings";
import { useSignals } from "../../../hooks/useIncidents";
import { revalidateProjects } from "../../../hooks/useProjects";
import type { ProductionRunnerView } from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import { SETTING_SWITCH_HIT } from "../../../lib/incident-settings-classes";
import { monthSpendCopy } from "../../../lib/project-settings/page-model";
import { SettingCard } from "../../../ui/settings";
import { Switch } from "../../../ui/switch";
import { toast } from "../../../ui/toast";
import { PolicySection } from "../incidents/PolicySection";
import { SignalEditor } from "../incidents/SignalEditor";
import { SignalsSection } from "../incidents/SignalsSection";
import { SettingRow } from "../shared";

/**
 * The project's incident settings: the pause switches, its signals and
 * maintenance windows, what agents may do on their own, and the budget.
 * `addSignal` opens a new signal's editor (the checklist's fix).
 */
export function IncidentsSection({
  project,
  view,
  addSignal,
  onAddSignalClose,
  onSave,
}: {
  project: string;
  view: ProjectSettingsView;
  addSignal: number | null;
  onAddSignalClose: () => void;
  onSave: (body: ProjectPatchBody) => Promise<void>;
}) {
  const signals = useSignals();
  const { incidents, production } = view.document;
  const runners: ProductionRunnerView[] = view.runners
    .filter((r) => production.runners.includes(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      online: r.online,
      bound: true,
      problem: null,
    }));

  /** Save one of the two pause switches; a save that lands offers Undo. */
  const setSwitch = (
    field: "agentsPaused" | "incidentsPaused",
    on: boolean,
    landed: string,
  ) => {
    onSave({ incidents: { [field]: on } }).then(
      () =>
        toast(landed, {
          action: {
            label: "Undo",
            onClick: () =>
              void onSave({ incidents: { [field]: !on } }).catch((error) =>
                toast(errorMessage(error, "Couldn't save the setting"), {
                  variant: "error",
                }),
              ),
          },
        }),
      (error) =>
        toast(errorMessage(error, "Couldn't save the setting"), {
          variant: "error",
        }),
    );
  };
  const setPaused = (paused: boolean) =>
    setSwitch(
      "agentsPaused",
      paused,
      paused ? `Agents paused for ${project}` : `Agents resumed for ${project}`,
    );
  const setIncidentsPaused = (paused: boolean) =>
    setSwitch(
      "incidentsPaused",
      paused,
      paused
        ? `New incidents paused for ${project}`
        : `New incidents resumed for ${project}`,
    );

  return (
    <>
      <SettingCard>
        <SettingRow
          title="Pause all agents"
          desc={`Stops every incident run for ${project} right now. Signals keep checking`}
          control={
            <Switch
              checked={incidents.agentsPaused}
              onCheckedChange={setPaused}
              aria-label="Pause all agents"
              className={SETTING_SWITCH_HIT}
            />
          }
        />
        <SettingRow
          title="Pause new incidents"
          desc={`Signals keep checking, but none opens or reopens an incident for ${project}`}
          control={
            <Switch
              checked={incidents.incidentsPaused}
              onCheckedChange={setIncidentsPaused}
              aria-label="Pause new incidents"
              className={SETTING_SWITCH_HIT}
            />
          }
        />
      </SettingCard>
      <SignalsSection
        project={project}
        runners={runners}
        onSaved={() => revalidateProjects()}
      />
      <PolicySection
        project={project}
        settings={incidents}
        autonomyLabel="On their own"
        monthDescription={monthSpendCopy(view.monthSpendUsd, new Date())}
        onSave={(input) => onSave({ incidents: input })}
      />
      {addSignal !== null && (
        <SignalEditor
          key={addSignal}
          open
          onClose={onAddSignalClose}
          project={project}
          signal={null}
          runners={runners}
          signals={signals.data ?? []}
          onSaved={() => {
            void signals.mutate();
            revalidateProjects();
          }}
        />
      )}
    </>
  );
}
