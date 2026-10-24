import { useState } from "react";
import { Button } from "../../../ui/button";
import { useConfirm } from "../../../ui/confirm";
import { InlineAlert } from "../../../ui/state";

/**
 * A legacy store changed after this project was migrated (an old gateway
 * still draining during an upgrade). The button runs the migration for
 * every project on this instance, so it asks first and stays busy until
 * the run answers.
 */
export function DriftNotice({ onMigrate }: { onMigrate: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const run = () => {
    if (busy) return;
    setBusy(true);
    onMigrate().then(
      () => setBusy(false),
      () => setBusy(false),
    );
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
              title: "Migrate settings for all projects again?",
              description:
                "This runs the upgrade's migration for every project on this instance, not only this one. Projects that already have settings keep them",
              confirmLabel: "Migrate",
              onConfirm: run,
            })
          }
        >
          {busy ? "Migrating" : "Migrate all projects"}
        </Button>
      </span>
      {confirmDialog}
    </InlineAlert>
  );
}
