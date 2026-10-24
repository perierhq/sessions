import type * as React from "react";
import { useState } from "react";
import type { SignalView } from "../../../../shared/incidents";
import { useSignals } from "../../../hooks/useIncidents";
import type { ProductionRunnerView } from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import { projectWindows } from "../../../lib/incidents/maintenance-form";
import {
  ruleCaption,
  signalCaption,
  sortSignals,
} from "../../../lib/incidents/signal-summary";
import { signalStateWord } from "../../../lib/incidents/tone";
import { repoLabel } from "../../../lib/repo-label";
import { Button } from "../../../ui/button";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
} from "../../../ui/settings";
import { EmptyState, InlineAlert } from "../../../ui/state";
import { ProjectMaintenanceDialog } from "./MaintenanceWindowsEditor";
import { SettingLinkRow } from "./SettingLinkRow";
import { SignalEditor } from "./SignalEditor";

/** The caption under a signal's name: the kind and cadence, then the rule
 *  when the caption does not already say it. */
function rowCaption(signal: SignalView): string {
  const caption = signalCaption(signal);
  const rule = ruleCaption(signal);
  return caption.includes(rule) ? caption : `${caption} · ${rule}`;
}

function stateWord(signal: SignalView): string {
  if (!signal.enabled) return "Off";
  return signalStateWord(signal.evaluation?.state ?? "unknown");
}

/**
 * A project's signals: one row each, problems first, opening the editor;
 * `Add a signal` above them.
 */
export function SignalsSection({
  project,
  runners,
  onSaved,
}: {
  project: string;
  /** The project's bound production Runners ("Check from"). */
  runners: ProductionRunnerView[];
  /** A signal or maintenance window was saved (readiness counts them). */
  onSaved?: () => void;
}) {
  const signals = useSignals();
  const saved = () => {
    void signals.mutate();
    onSaved?.();
  };
  // `key` starts every open from the signal as stored.
  const [editor, setEditor] = useState<{
    key: number;
    signal: SignalView | null;
  } | null>(null);
  const [opens, setOpens] = useState(0);
  const [open, setOpen] = useState(false);
  const openEditor = (signal: SignalView | null) => {
    setOpens(opens + 1);
    setEditor({ key: opens + 1, signal });
    setOpen(true);
  };
  const [maintenance, setMaintenance] = useState<{ key: number } | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const all = signals.data ?? [];
  const own = all.filter((signal) => signal.project === project);
  const planned = projectWindows(own).length;
  return (
    <>
      <SignalsList
        project={project}
        signals={signals.data ? all : null}
        error={
          signals.error
            ? errorMessage(signals.error, "Couldn't load the signals")
            : null
        }
        onRetry={() => void signals.mutate()}
        onOpen={openEditor}
        trailing={
          own.length > 0 && (
            <SettingLinkRow
              title="Maintenance windows"
              description="Planned downtime doesn't open incidents"
              value={planned ? `${planned} planned` : "None planned"}
              onClick={() => {
                setOpens(opens + 1);
                setMaintenance({ key: opens + 1 });
                setMaintenanceOpen(true);
              }}
            />
          )
        }
      />
      {maintenance && (
        <ProjectMaintenanceDialog
          key={maintenance.key}
          open={maintenanceOpen}
          onClose={() => setMaintenanceOpen(false)}
          project={project}
          signals={sortSignals(own)}
          onSaved={saved}
        />
      )}
      {editor && (
        <SignalEditor
          key={editor.key}
          open={open}
          onClose={() => setOpen(false)}
          project={project}
          signal={editor.signal}
          runners={runners}
          signals={all}
          onSaved={saved}
        />
      )}
    </>
  );
}

/** The Signals group, as data in and row presses out. `signals` is null
 *  while they load. */
export function SignalsList({
  project,
  signals,
  error,
  onRetry,
  onOpen,
  trailing,
}: {
  project: string;
  signals: SignalView[] | null;
  error: string | null;
  onRetry: () => void;
  onOpen: (signal: SignalView | null) => void;
  /** Rows after the signals, inside the same card (maintenance windows). */
  trailing?: React.ReactNode;
}) {
  const label = repoLabel(project);
  const own = sortSignals(
    (signals ?? []).filter((signal) => signal.project === project),
  );
  let body: React.ReactNode;
  if (error) body = <InlineAlert onRetry={onRetry}>{error}</InlineAlert>;
  else if (!signals) body = <SettingCardSkeleton rows={2} />;
  else
    body = (
      <SettingCard>
        {own.length ? (
          own.map((signal) => (
            <SettingLinkRow
              key={signal.id}
              title={signal.name}
              description={rowCaption(signal)}
              value={stateWord(signal)}
              onClick={() => onOpen(signal)}
            />
          ))
        ) : (
          <EmptyState
            placement="row"
            action={
              <Button
                size="sm"
                variant="soft"
                className="phone:min-h-11"
                onClick={() => onOpen(null)}
              >
                Add a signal
              </Button>
            }
          >
            {`No signals for ${label} yet. A signal checks something in production and opens an incident when it breaks`}
          </EmptyState>
        )}
        {trailing}
      </SettingCard>
    );
  return (
    <>
      <SettingsGroupLabel
        actions={
          own.length > 0 && (
            <Button
              size="sm"
              variant="soft"
              className="phone:min-h-11"
              onClick={() => onOpen(null)}
            >
              Add a signal
            </Button>
          )
        }
      >
        Signals
      </SettingsGroupLabel>
      {body}
    </>
  );
}
