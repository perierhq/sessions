import { useState } from "react";
import useSWR from "swr";
import type {
  ForgetCustomerResult,
  InboxHealthState,
  InboxView,
} from "../../../shared/support";
import { fetchInboxes, forgetCustomer } from "../../lib/api/support";
import { errorMessage } from "../../lib/error-message";
import {
  FORGET_INPUT,
  FORGET_RESULT,
  FORGET_ROW,
  INBOX_ROW_BUTTON,
} from "../../lib/support-inbox-classes";
import { forgetSummary, healthLine } from "../../lib/inbox-form";
import { usePeople } from "../../lib/people";
import { Button } from "../../ui/button";
import { useConfirm } from "../../ui/confirm";
import { Input } from "../../ui/input";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  SettingsSection,
  StatusChip,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { InboxForm } from "./inboxes/InboxForm";

const INBOXES_KEY = ["api", "support-inboxes"] as const;

const HEALTH_DOT: Record<InboxHealthState, string> = {
  live: "var(--green)",
  polling: "var(--green)",
  connecting: "var(--yellow)",
  "backing-off": "var(--yellow)",
  paused: "var(--red)",
  off: "var(--text-faint)",
};

interface InboxStatus {
  label: string;
  dot: string;
}

function statusOf(inbox: InboxView): InboxStatus {
  if (!inbox.enabled) return { label: "Turned off", dot: HEALTH_DOT.off };
  return {
    label: healthLine(inbox.health),
    dot: HEALTH_DOT[inbox.health.state] ?? HEALTH_DOT.off,
  };
}

/**
 * Settings → Inboxes: the support mailboxes agents read and answer, one row
 * each with its health, "Connect an inbox", and "Forget a customer". The
 * sandbox connections' shape (SandboxesPanel): a list of connections with
 * their state, a form to connect and test one.
 */
export function InboxesPanel() {
  const { data, error, isLoading, mutate } = useSWR(INBOXES_KEY, fetchInboxes);
  const people = usePeople();
  // Which inbox the form edits: null connects a new one, undefined is closed.
  const [editing, setEditing] = useState<InboxView | null | undefined>(
    undefined,
  );
  // Bumped on every open, so the form starts from the stored values.
  const [opened, setOpened] = useState(0);
  const [customer, setCustomer] = useState("");
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState<ForgetCustomerResult | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const openForm = (inbox: InboxView | null) => {
    setOpened((n) => n + 1);
    setEditing(inbox);
  };

  const enabled = data?.enabled ?? false;
  const isOwner = data?.isInstanceOwner ?? false;
  const address = customer.trim().toLowerCase();

  const forget = () => {
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      setForgetError("Enter the customer's email address");
      return;
    }
    setForgetError(null);
    confirm({
      title: `Forget ${address}?`,
      description:
        "Deletes every conversation with this address, the agent sessions that worked on them and their attachments. Mail in the mailbox and issues already created stay.",
      confirmLabel: "Forget",
      destructive: true,
      onConfirm: () => {
        setForgetting(true);
        setForgotten(null);
        forgetCustomer(address).then(
          (result) => {
            setForgetting(false);
            setForgotten(result);
            setCustomer("");
          },
          (cause) => {
            setForgetting(false);
            setForgetError(
              errorMessage(cause, "Couldn't forget this customer"),
            );
          },
        );
      },
    });
  };

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Inboxes"
        description="Support mail that agents can read and answer"
        actions={
          enabled ? (
            <Button
              variant="primary"
              className={INBOX_ROW_BUTTON}
              onClick={() => openForm(null)}
            >
              Connect an inbox
            </Button>
          ) : undefined
        }
      />

      {isLoading && !data ? (
        <SettingCardSkeleton rows={2} />
      ) : error && !data ? (
        <InlineAlert onRetry={() => void mutate()}>
          {errorMessage(error, "Couldn't load the inboxes")}
        </InlineAlert>
      ) : !enabled ? (
        <SettingCard>
          <SettingRow>
            <SettingRowText>
              <SettingRowTitle>Email support is off</SettingRowTitle>
              <SettingRowDescription>
                Set ENABLE_EMAIL_SUPPORT=true and restart Sessions
              </SettingRowDescription>
            </SettingRowText>
          </SettingRow>
        </SettingCard>
      ) : (
        <SettingCard>
          {data?.inboxes.length ? (
            data.inboxes.map((inbox) => {
              const status = statusOf(inbox);
              return (
                <SettingRow key={inbox.id} className="items-start">
                  <SettingRowText>
                    <SettingRowTitle className="[overflow-wrap:anywhere]">
                      {inbox.label}
                    </SettingRowTitle>
                    <SettingRowDescription className="[overflow-wrap:anywhere]">
                      {inbox.address} · {inbox.project}
                    </SettingRowDescription>
                    <div className="mt-1.5">
                      <StatusChip label={status.label} dot={status.dot} />
                    </div>
                  </SettingRowText>
                  <SettingRowControl>
                    <Button
                      variant="soft"
                      className={INBOX_ROW_BUTTON}
                      aria-label={`Edit ${inbox.label}`}
                      onClick={() => openForm(inbox)}
                    >
                      Edit
                    </Button>
                  </SettingRowControl>
                </SettingRow>
              );
            })
          ) : (
            <SettingRow>
              <SettingRowText>
                <SettingRowTitle>No inboxes yet</SettingRowTitle>
                <SettingRowDescription>
                  Connect a support mailbox and agents sort, draft and answer
                  its mail
                </SettingRowDescription>
              </SettingRowText>
            </SettingRow>
          )}
        </SettingCard>
      )}

      <SettingsGroupLabel>Forget a customer</SettingsGroupLabel>
      <SettingsSection>
        <form
          className={FORGET_ROW}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            forget();
          }}
        >
          <Input
            aria-label="Customer address"
            type="email"
            placeholder="customer@example.test"
            autoCapitalize="off"
            spellCheck={false}
            className={FORGET_INPUT}
            value={customer}
            disabled={!isOwner || forgetting}
            onChange={(event) => setCustomer(event.target.value)}
          />
          <Button
            type="button"
            variant="danger"
            className={INBOX_ROW_BUTTON}
            disabled={!isOwner || forgetting || !address}
            onClick={forget}
          >
            Forget
          </Button>
        </form>
        {forgetError && (
          <InlineAlert className="mt-3">{forgetError}</InlineAlert>
        )}
        {forgotten && (
          <ul className={FORGET_RESULT} aria-live="polite">
            <li className="text-fg">{forgetSummary(forgotten)}</li>
            {forgotten.failed > 0 && (
              <li>
                {forgotten.failed === 1
                  ? "1 conversation couldn't be deleted. Try again"
                  : `${forgotten.failed} conversations couldn't be deleted. Try again`}
              </li>
            )}
            {forgotten.notDeleted.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsHint>
        {isOwner
          ? "Deletes everything Sessions holds for one customer. The mailbox is not changed"
          : "Only the instance owner can forget a customer"}
      </SettingsHint>

      {editing !== undefined && data && (
        <InboxForm
          key={`${editing?.id ?? "new"}-${opened}`}
          open
          inbox={editing}
          projects={data.projects}
          people={people.map((person) => person.name)}
          isInstanceOwner={isOwner}
          onClose={() => setEditing(undefined)}
          onSaved={() => void mutate()}
        />
      )}
      {confirmDialog}
    </SettingsPanel>
  );
}
