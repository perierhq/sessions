import { useRef, useState } from "react";
import type { ProjectRemigrateResult } from "../../../../shared/project-settings";
import { Button } from "../../../ui/button";
import { useConfirm } from "../../../ui/confirm";
import { InlineAlert } from "../../../ui/state";
import { toast } from "../../../ui/toast";

/**
 * A legacy store changed after this project was migrated (an old gateway
 * still draining during an upgrade). The button re-reads this project's old
 * settings and replaces its current ones, after a backup, so it asks first,
 * stays busy until the server answers and then says what happened.
 * `onRemigrate` answers `null` when the run failed (the caller says why).
 */
export function DriftNotice({
  project,
  onRemigrate,
}: {
  project: string;
  onRemigrate: () => Promise<ProjectRemigrateResult | null>;
}) {
  const [busy, setBusy] = useState(false);
  // Two confirms in one tick both see `busy` false; this one they share.
  const running = useRef(false);
  const [confirm, confirmDialog] = useConfirm();
  const done = () => {
    running.current = false;
    setBusy(false);
  };
  const run = () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onRemigrate().then((result) => {
      done();
      if (result) toast(resultText(result), { variant: "success" });
    }, done);
  };
  return (
    <InlineAlert variant="warn" className="mb-3">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
        Settings changed during the upgrade
        <Button
          type="button"
          size="sm"
          variant="soft"
          className="phone:min-h-11"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() =>
            confirm({
              title: `Re-run the migration for ${project}?`,
              description: `This re-reads ${project}'s old settings and replaces its current settings with them. The current settings are backed up first. Other projects are not touched`,
              confirmLabel: "Re-run migration",
              onConfirm: run,
            })
          }
        >
          {busy ? "Migrating" : "Re-run migration"}
        </Button>
      </span>
      {confirmDialog}
    </InlineAlert>
  );
}

function resultText(result: ProjectRemigrateResult): string {
  const dropped = result.report.dropped.length;
  const parts = [`Re-ran the migration for ${result.project}`];
  if (result.backupPath) parts.push(`Backup: ${result.backupPath}`);
  if (dropped)
    parts.push(
      `${dropped} ${dropped === 1 ? "setting" : "settings"} couldn't carry over`,
    );
  return parts.join(". ");
}
