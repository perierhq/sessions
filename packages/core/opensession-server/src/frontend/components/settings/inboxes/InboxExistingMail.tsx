import { useState } from "react";
import {
  DEFAULT_BRING_IN_DAYS,
  type InboxView,
} from "../../../../shared/support";
import { bringInMail } from "../../../lib/api/support";
import { errorMessage } from "../../../lib/error-message";
import {
  bringInChoices,
  bringInLabel,
  broughtInLine,
  existingMailOffer,
} from "../../../lib/inbox-form";
import {
  INBOX_EXISTING,
  INBOX_EXISTING_SELECT,
  INBOX_EXISTING_TEXT,
  INBOX_LEARN_CONTROLS,
} from "../../../lib/support-inbox-classes";
import { Button } from "../../../ui/button";
import { OptionSelect } from "../../../ui/select";
import { toast } from "../../../ui/toast";

/**
 * Under an inbox's health: how much unread mail was already there when it
 * first connected (Sessions starts with the mail that arrives after), and
 * "Bring in the last N days". Nothing comes in unless someone presses it.
 */
export function InboxExistingMail({
  inbox,
  isInstanceOwner,
  onBroughtIn,
}: {
  inbox: InboxView;
  isInstanceOwner: boolean;
  onBroughtIn: () => void;
}) {
  const [days, setDays] = useState(String(DEFAULT_BRING_IN_DAYS));
  const [busy, setBusy] = useState(false);
  const offer = existingMailOffer(inbox, isInstanceOwner);
  if (!offer) return null;

  const bringIn = () => {
    const n = Number(days);
    setBusy(true);
    bringInMail(inbox.id, n).then(
      ({ count }) => {
        setBusy(false);
        toast(broughtInLine({ at: "", days: n, count }), {
          variant: count ? "success" : "default",
        });
        onBroughtIn();
      },
      (cause) => {
        setBusy(false);
        toast(errorMessage(cause, "Couldn't bring in the mail"), {
          variant: "error",
        });
      },
    );
  };

  return (
    <div className={INBOX_EXISTING}>
      <p className={INBOX_EXISTING_TEXT}>{offer.text}</p>
      {offer.canBringIn && (
        <div className={INBOX_LEARN_CONTROLS}>
          <OptionSelect
            label="How far back"
            className={INBOX_EXISTING_SELECT}
            value={days}
            options={bringInChoices()}
            disabled={busy}
            onChange={setDays}
          />
          <Button
            type="button"
            variant="soft"
            className="phone:min-h-11"
            disabled={busy}
            onClick={bringIn}
          >
            {bringInLabel(Number(days))}
          </Button>
        </div>
      )}
    </div>
  );
}
