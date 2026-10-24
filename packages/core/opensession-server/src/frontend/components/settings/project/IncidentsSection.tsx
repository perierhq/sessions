import type { ProjectSettingsView } from "../../../../shared/project-settings";
import { useSignals } from "../../../hooks/useIncidents";
import { revalidateProjects } from "../../../hooks/useProjects";
import type { ProductionRunnerView } from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import { monthSpendCopy } from "../../../lib/project-settings/page-model";
import { SettingCard } from "../../../ui/settings";
import { Switch } from "../../../ui/switch";
import { toast } from "../../../ui/toast";
import { PolicySection } from "../incidents/PolicySection";
import { SignalEditor } from "../incidents/SignalEditor";
import { SignalsSection } from "../incidents/SignalsSection";
import { SettingRow } from "../shared";

/**
 * The project's incident settings: the pause switch, its signals and
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

  const setPaused = (paused: boolean) => {
    onSave({ incidents: { agentsPaused: paused } }).then(
      () =>
        toast(
          paused
            ? `Agents paused for ${project}`
            : `Agents resumed for ${project}`,
          {
            action: {
              label: "Undo",
              onClick: () =>
                void onSave({ incidents: { agentsPaused: !paused } }).catch(
                  (error) =>
                    toast(errorMessage(error, "Couldn't save the setting"), {
                      variant: "error",
                    }),
                ),
            },
          },
        ),
      (error) =>
        toast(errorMessage(error, "Couldn't save the setting"), {
          variant: "error",
        }),
    );
  };

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
        showPause={false}
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
