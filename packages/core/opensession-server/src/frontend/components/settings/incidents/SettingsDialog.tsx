import type * as React from "react";
import { useIsPhone } from "../../../hooks/useIsPhone";
import {
  SETTINGS_DIALOG_BODY,
  SETTINGS_DIALOG_BUTTONS,
  SETTINGS_DIALOG_FOOTER,
  SETTINGS_DIALOG_HEADER,
  SETTINGS_DIALOG_MODAL,
  SETTINGS_DIALOG_MODAL_WIDE,
  SETTINGS_DIALOG_SHEET,
  SETTINGS_DIALOG_TITLE,
} from "../../../lib/incident-settings-classes";
import { Button } from "../../../ui/button";
import { ResponsiveDialog } from "../../../ui/sheet";
import { InlineAlert } from "../../../ui/state";
import { IconX } from "../../icons";

/**
 * One incident setting being edited: a centred dialog on a desktop, a sheet
 * on a phone, with a visible close, the fields, the server's refusal above
 * the buttons, and Cancel and Save. `leading` holds a destructive action at
 * the footer's left.
 */
export function SettingsDialog({
  open,
  onClose,
  title,
  error,
  busy = false,
  canSave = true,
  saveLabel = "Save",
  onSave,
  leading,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  error?: string | null;
  busy?: boolean;
  canSave?: boolean;
  saveLabel?: string;
  onSave: () => void;
  leading?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const phone = useIsPhone();
  return (
    <ResponsiveDialog
      open={open}
      onClose={onClose}
      phone={phone}
      label={title}
      sheetClassName={SETTINGS_DIALOG_SHEET}
      modalClassName={wide ? SETTINGS_DIALOG_MODAL_WIDE : SETTINGS_DIALOG_MODAL}
    >
      {(dismiss) => (
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave && !busy) onSave();
          }}
        >
          <header className={SETTINGS_DIALOG_HEADER}>
            <h2 className={SETTINGS_DIALOG_TITLE}>{title}</h2>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="phone:min-h-11 phone:min-w-11"
              aria-label="Close"
              icon={<IconX />}
              onClick={dismiss}
            />
          </header>
          <div className={SETTINGS_DIALOG_BODY}>{children}</div>
          <footer className={SETTINGS_DIALOG_FOOTER}>
            {error && <InlineAlert>{error}</InlineAlert>}
            <div className={SETTINGS_DIALOG_BUTTONS}>
              {leading && <div className="mr-auto">{leading}</div>}
              <Button type="button" variant="soft" onClick={dismiss}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!canSave || busy}
              >
                {saveLabel}
              </Button>
            </div>
          </footer>
        </form>
      )}
    </ResponsiveDialog>
  );
}
