import {
  ROLE_LABELS,
  type IncidentRole,
  type ProjectSignalException,
} from "../../../../shared/project-settings";
import { useSignals } from "../../../hooks/useIncidents";
import { errorMessage } from "../../../lib/error-message";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import { Button } from "../../../ui/button";
import { useConfirm } from "../../../ui/confirm";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../../ui/settings";
import { toast } from "../../../ui/toast";
import { SettingRow } from "../shared";

/**
 * Per-signal access that differs from the table, carried over from the old
 * settings. They still apply; the only change left is to remove one.
 * Hidden when there are none.
 */
export function SignalExceptions({
  exceptions,
  onSave,
}: {
  exceptions: ProjectSignalException[];
  onSave: (body: ProjectPatchBody) => Promise<void>;
}) {
  const signals = useSignals();
  const [confirm, confirmDialog] = useConfirm();
  if (!exceptions.length) return null;
  const nameOf = (id: string) =>
    signals.data?.find((s) => s.id === id)?.name ?? id;
  const askRemove = (signalId: string, role: IncidentRole) =>
    confirm({
      title: `Remove the ${ROLE_LABELS[role]} exception for ${nameOf(signalId)}?`,
      description:
        "The agent then gets the access in the table above. An exception can't be made again",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () => void remove(signalId, role),
    });
  const remove = (signalId: string, role: IncidentRole) =>
    onSave({
      access: { removeSignalExceptions: [{ signalId, role }] },
    }).then(
      () => toast("Exception removed"),
      (error) =>
        toast(errorMessage(error, "Couldn't remove the exception"), {
          variant: "error",
        }),
    );
  return (
    <>
      <SettingsGroupLabel>Signal exceptions</SettingsGroupLabel>
      <SettingCard>
        {exceptions.map((e) => (
          <SettingRow
            key={`${e.signalId}:${e.role}`}
            title={nameOf(e.signalId)}
            desc={`${ROLE_LABELS[e.role]}, changed by ${e.updatedBy}`}
            control={
              <Button
                type="button"
                size="sm"
                variant="soft"
                className="phone:min-h-11"
                onClick={() => askRemove(e.signalId, e.role)}
              >
                Remove
              </Button>
            }
          />
        ))}
      </SettingCard>
      <SettingsHint>
        These signals give an agent different access from the table above
      </SettingsHint>
      {confirmDialog}
    </>
  );
}
