import { useEffect, useEffectEvent, useState } from "react";
import type { ProjectSettingsView } from "../../../../shared/project-settings";
import {
  type ProductionPairing,
  type ProductionRunnerView,
  startProductionPairingApi,
} from "../../../lib/api/incidents";
import { bindProjectRunner } from "../../../lib/api/projects";
import { errorMessage } from "../../../lib/error-message";
import { runnerInUse } from "../../../lib/incidents/action-form";
import {
  FIELD_HINT,
  PAIRING_WELL,
} from "../../../lib/incident-settings-classes";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import { clockTime } from "../../../lib/time";
import { Button } from "../../../ui/button";
import { toast } from "../../../ui/toast";
import { IconPlus } from "../../icons";
import { ProductionHostsList } from "../incidents/ActionsSection";
import { CopyUrl } from "../incidents/FormParts";
import { SettingsDialog } from "../incidents/SettingsDialog";

const PAIRING_POLL_MS = 5_000;

/**
 * Pick the Runners that serve the project's production, or pair a new one.
 * Each switch writes at once; switching a Runner off that an action runs on
 * says so instead.
 */
export function PairRunnerDialog({
  open,
  onClose,
  project,
  view,
  onSave,
  onView,
  onRevalidate,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  view: ProjectSettingsView;
  onSave: (body: ProjectPatchBody) => Promise<void>;
  onView: (view: ProjectSettingsView) => void;
  onRevalidate: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [pairing, setPairing] = useState<ProductionPairing | null>(null);
  const [expired, setExpired] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const { production } = view.document;
  const runners: ProductionRunnerView[] = view.runners.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    online: r.online,
    bound: production.runners.includes(r.id),
    problem: null,
  }));

  // While a code is out, look for the host it pairs; stop at its expiry.
  const poll = useEffectEvent(() => {
    if (pairing && Date.now() >= pairing.expiresAt) {
      setPairing(null);
      setExpired(true);
      return;
    }
    onRevalidate();
  });
  useEffect(() => {
    if (!pairing || !open) return;
    const timer = setInterval(poll, PAIRING_POLL_MS);
    return () => clearInterval(timer);
  }, [pairing, open]);

  const toggle = (runner: ProductionRunnerView, on: boolean) => {
    setRowError(null);
    setBusy(runner.id);
    const done = () => setBusy(null);
    const fail = (fallback: string) => (error: unknown) => {
      setBusy(null);
      setRowError({ id: runner.id, message: errorMessage(error, fallback) });
    };
    if (on) {
      bindProjectRunner(project, runner.id).then((next) => {
        done();
        onView(next);
        toast(`${runner.name} now serves ${project}`);
      }, fail("Couldn't use this Runner"));
      return;
    }
    const inUse = runnerInUse(production.actions, runner.id);
    if (inUse) {
      setBusy(null);
      setRowError({ id: runner.id, message: inUse });
      return;
    }
    onSave({
      production: {
        runners: production.runners.filter((id) => id !== runner.id),
      },
    }).then(done, fail("Couldn't remove this Runner"));
  };

  const pair = () => {
    setPairError(null);
    setExpired(false);
    setPairingBusy(true);
    startProductionPairingApi(project).then(
      (next) => {
        setPairingBusy(false);
        setPairing(next);
      },
      (error) => {
        setPairingBusy(false);
        setPairError(errorMessage(error, "Couldn't start pairing"));
      },
    );
  };

  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="Pair a Runner"
      error={pairError}
    >
      <p className={FIELD_HINT}>
        {`Runners reserved for ${project}. Actions run on them, and checks can too. Nothing else can use a reserved Runner`}
      </p>
      <ProductionHostsList
        label={project}
        runners={runners}
        busy={busy}
        error={rowError}
        onToggle={toggle}
      />
      {pairing ? (
        <div className={PAIRING_WELL}>
          <p className="m-0 text-body text-fg">
            {`Run this on the production host. It joins as a Runner that may only run commands for ${project}`}
          </p>
          <CopyUrl url={pairing.command} label="the pairing command" />
          <p className={FIELD_HINT}>
            {`Expires at ${clockTime(new Date(pairing.expiresAt).toISOString())}. The code works once and is not shown again`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          {expired && (
            <p className={FIELD_HINT}>
              The code expired. Pair again for a new one
            </p>
          )}
          <Button
            type="button"
            variant="soft"
            icon={<IconPlus size={16} />}
            className="phone:min-h-11"
            disabled={pairingBusy}
            onClick={pair}
          >
            Pair new
          </Button>
        </div>
      )}
    </SettingsDialog>
  );
}
