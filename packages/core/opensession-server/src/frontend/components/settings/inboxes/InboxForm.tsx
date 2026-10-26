import { useId, useState } from "react";
import {
  type InboxProjectOption,
  type InboxTestResult,
  type InboxView,
  MAILBOX_BEHAVIOURS,
  type MailTlsMode,
  type MailboxBehaviour,
  SUPPORT_TOPICS,
  defaultMailPort,
} from "../../../../shared/support";
import {
  MAILBOX_BEHAVIOUR_COPY,
  SUPPORT_TOPIC_LABELS,
} from "../../../../shared/support-copy";
import {
  createInbox,
  deleteInbox,
  patchInbox,
  testInbox,
} from "../../../lib/api/support";
import { startKnowledgeImport } from "../../../lib/api/knowledge";
import { ApiError } from "../../../lib/api/request";
import { errorMessage } from "../../../lib/error-message";
import {
  CHECK_ROW,
  DIALOG_INPUT,
  FIELD_HINT,
} from "../../../lib/incident-settings-classes";
import {
  AUTONOMY_CHOICES,
  type InboxFormState,
  type MailServerKind,
  draftStatsLine,
  effectiveCopyToSent,
  emptyInboxForm,
  formChanged,
  formFromInbox,
  inboxFormError,
  newInboxFromForm,
  patchFromForm,
  routineWaitLocked,
  serverMoved,
  setServerField,
  showsConnectorWarning,
  testBodyFromForm,
  testResultLines,
  tlsChoices,
} from "../../../lib/inbox-form";
import {
  DEFAULT_IMPORT_MONTHS,
  monthOptions,
} from "../../../lib/knowledge/import-model";
import {
  INBOX_AUTONOMY_CHOICE,
  INBOX_AUTONOMY_CHOICES,
  INBOX_FORM_PAIR,
  INBOX_LEARN_ROW,
  INBOX_LEARN_CONTROLS,
  INBOX_LEGEND,
  INBOX_LEGEND_ROW,
  INBOX_SELECT,
  INBOX_TEST_LINES,
} from "../../../lib/support-inbox-classes";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { useConfirm } from "../../../ui/confirm";
import { Input } from "../../../ui/input";
import { Radio, RadioGroup } from "../../../ui/radio";
import { OptionSelect } from "../../../ui/select";
import { InlineAlert } from "../../../ui/state";
import { Switch } from "../../../ui/switch";
import { toast } from "../../../ui/toast";
import { FormField, FormSection } from "../incidents/FormParts";
import { SettingsDialog } from "../incidents/SettingsDialog";
import { agentInProse } from "../../../lib/brand";

const TLS_LABELS: Record<MailTlsMode, string> = {
  implicit: "TLS",
  starttls: "STARTTLS",
  none: "None (this machine only)",
};

const SERVER_TITLES: Record<MailServerKind, string> = {
  imap: "IMAP",
  smtp: "SMTP",
};

const CONNECTOR_WARNING =
  "Routine replies can carry what the project's connectors, web search and websites return. Draft is safer while you get to know the agent.";

const LEARN_COPY = `${agentInProse({ start: true })} reads the replies your team sent from this inbox and adds them to the project's knowledge. Answers older than the latest docs change or release come in as reference`;

/**
 * Connect or edit one support inbox: the mailbox and its two servers (with
 * Test connection), how its mail is handled, what happens in the mailbox,
 * and how long Sessions keeps it. A centred dialog on a desktop and a
 * bottom sheet on a phone (`SettingsDialog`). Callers key it by the inbox
 * and each opening, so it starts from the stored values. Once a new inbox
 * is connected the dialog offers one more step, "Learn from past replies":
 * a mailbox import of the inbox's Sent mail into its project's knowledge.
 */
export function InboxForm({
  open,
  inbox,
  projects,
  people,
  isInstanceOwner,
  onClose,
  onSaved,
  onReload,
}: {
  open: boolean;
  /** null connects a new inbox. */
  inbox: InboxView | null;
  projects: InboxProjectOption[];
  /** Names a person can be picked by, for the owner. */
  people: string[];
  isInstanceOwner: boolean;
  onClose: () => void;
  /** Refreshes the inbox list (after a save, or a refused stale one). */
  onSaved: () => void;
  /** Opens the form again on the inbox as it is now, dropping edits. */
  onReload: () => void;
}) {
  // A new inbox's owner is "" until picked: the server makes whoever
  // connects it the owner.
  const [form, setForm] = useState<InboxFormState>(() =>
    inbox ? formFromInbox(inbox) : emptyInboxForm(projects[0]?.id ?? "", ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Someone else saved the inbox first: Save can't win until a reload.
  const [stale, setStale] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<InboxTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const autonomyId = useId();
  // The inbox just connected: the dialog becomes the import offer.
  const [created, setCreated] = useState<InboxView | null>(null);
  const [months, setMonths] = useState(String(DEFAULT_IMPORT_MONTHS));

  const editing = inbox !== null;
  const set = (patch: Partial<InboxFormState>) =>
    setForm((current) => ({ ...current, ...patch }));
  const setServer = (
    which: MailServerKind,
    patch: Partial<InboxFormState["imap"]>,
  ) => setForm((current) => setServerField(current, which, patch));

  /** A refused save: a 409 refreshes the list and offers Reload. */
  const saveFailed = (cause: unknown, fallback: string) => {
    setBusy(false);
    setError(errorMessage(cause, fallback));
    if (cause instanceof ApiError && cause.status === 409) {
      setStale(true);
      onSaved();
    }
  };

  const project = projects.find((p) => p.id === form.project);
  const warn = showsConnectorWarning(
    form.autonomy,
    project?.supportConnectors ?? false,
  );
  const lines = tested ? testResultLines(tested) : null;

  const save = () => {
    const invalid = inboxFormError(form, inbox);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    if (inbox) {
      const patch = patchFromForm(inbox, form);
      if (Object.keys(patch).length === 1) {
        onClose();
        return;
      }
      setBusy(true);
      patchInbox(inbox.id, patch).then(
        () => {
          setBusy(false);
          toast("Saved");
          onSaved();
          onClose();
        },
        (cause) => saveFailed(cause, "Couldn't save the inbox"),
      );
      return;
    }
    setBusy(true);
    createInbox(newInboxFromForm(form)).then(
      ({ inbox: connected }) => {
        setBusy(false);
        toast("Inbox connected");
        onSaved();
        setCreated(connected);
      },
      (cause) => {
        setBusy(false);
        setError(errorMessage(cause, "Couldn't connect the inbox"));
      },
    );
  };

  const runTest = () => {
    setTesting(true);
    setTested(null);
    setTestError(null);
    testInbox(testBodyFromForm(form, inbox)).then(
      (result) => {
        setTesting(false);
        setTested(result);
      },
      (cause) => {
        setTesting(false);
        setTestError(errorMessage(cause, "Couldn't test the connection"));
      },
    );
  };

  const toggleEnabled = () => {
    if (!inbox) return;
    // Turning off or on saves only that: other edits would be lost.
    if (formChanged(inbox, form)) {
      confirm({
        title: "Discard your changes?",
        description: `${inbox.enabled ? "Turning the inbox off" : "Turning the inbox on"} saves only that. Your other changes are lost`,
        confirmLabel: inbox.enabled ? "Turn off" : "Turn on",
        onConfirm: saveEnabled,
      });
      return;
    }
    saveEnabled();
  };

  const saveEnabled = () => {
    if (!inbox) return;
    setBusy(true);
    patchInbox(inbox.id, {
      expectedRevision: inbox.revision,
      enabled: !inbox.enabled,
    }).then(
      () => {
        setBusy(false);
        toast(inbox.enabled ? "Inbox turned off" : "Inbox turned on");
        onSaved();
        onClose();
      },
      (cause) => saveFailed(cause, "Couldn't change the inbox"),
    );
  };

  const remove = () => {
    if (!inbox) return;
    confirm({
      title: "Remove this inbox?",
      description: "Conversations stay; Sessions stops reading the mailbox",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () => {
        setBusy(true);
        deleteInbox(inbox.id).then(
          () => {
            setBusy(false);
            toast("Inbox removed");
            onSaved();
            onClose();
          },
          (cause) => {
            setBusy(false);
            setError(errorMessage(cause, "Couldn't remove the inbox"));
          },
        );
      },
    });
  };

  const serverFields = (which: MailServerKind) => {
    const server = form[which];
    const title = SERVER_TITLES[which];
    const saved = inbox?.[which];
    const moved = saved ? serverMoved(saved, server) : false;
    return (
      <div className="flex flex-col gap-3">
        <FormField label={`${title} server`}>
          <Input
            aria-label={`${title} server`}
            className={DIALOG_INPUT}
            value={server.host}
            placeholder={`${which}.example.test`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setServer(which, { host: e.target.value })}
          />
        </FormField>
        <div className={INBOX_FORM_PAIR}>
          <FormField label={`${title} port`}>
            <Input
              aria-label={`${title} port`}
              className={DIALOG_INPUT}
              inputMode="numeric"
              value={server.port}
              onChange={(e) => setServer(which, { port: e.target.value })}
            />
          </FormField>
          <FormField label={`${title} security`}>
            <OptionSelect<MailTlsMode>
              label={`${title} security`}
              className={INBOX_SELECT}
              value={server.tls}
              options={tlsChoices(server.host, saved?.tls ?? null).map(
                (tls) => ({ value: tls, label: TLS_LABELS[tls] }),
              )}
              onChange={(tls) => {
                // A port still at the old mode's usual one follows the mode.
                const usual = String(defaultMailPort(which, server.tls));
                const port =
                  server.port === usual
                    ? String(defaultMailPort(which, tls))
                    : server.port;
                setServer(which, { tls, port });
              }}
            />
          </FormField>
        </div>
        <FormField label={`${title} user name`}>
          <Input
            aria-label={`${title} user name`}
            className={DIALOG_INPUT}
            value={server.user}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setServer(which, { user: e.target.value })}
          />
        </FormField>
        <FormField
          label={`${title} password`}
          hint={
            moved
              ? "Enter the password again for the changed server"
              : saved?.hasPassword
                ? "Leave empty to keep the saved password"
                : "An app password if the account has two-step sign-in"
          }
        >
          <Input
            aria-label={`${title} password`}
            className={DIALOG_INPUT}
            type="password"
            autoComplete="new-password"
            value={server.password}
            placeholder={saved?.hasPassword && !moved ? "Saved" : ""}
            onChange={(e) => setServer(which, { password: e.target.value })}
          />
        </FormField>
      </div>
    );
  };

  const learn = () => {
    if (!created) return;
    setBusy(true);
    setError(null);
    startKnowledgeImport(created.project, "mailbox", {
      inboxId: created.id,
      months: Number(months),
    }).then(
      () => {
        setBusy(false);
        toast("Importing past replies");
        onClose();
      },
      (cause) => {
        setBusy(false);
        setError(errorMessage(cause, "Couldn't start the import"));
      },
    );
  };

  if (created)
    return (
      <SettingsDialog
        open={open}
        onClose={onClose}
        title="Inbox connected"
        error={error}
      >
        <div className={INBOX_LEARN_ROW}>
          <div className="min-w-0">
            <div className="text-item-title font-medium text-fg">
              Learn from past replies
            </div>
            <p className={`${FIELD_HINT} mt-1`}>{LEARN_COPY}</p>
          </div>
          <div className={INBOX_LEARN_CONTROLS}>
            <OptionSelect
              label="How far back"
              className={INBOX_SELECT}
              value={months}
              options={monthOptions()}
              onChange={setMonths}
            />
            <Button
              type="button"
              variant="primary"
              className="phone:min-h-11"
              disabled={busy}
              onClick={learn}
            >
              Import
            </Button>
          </div>
        </div>
      </SettingsDialog>
    );

  const ownerOptions = [
    ...(editing ? [] : [{ value: "", label: "You" }]),
    ...[...new Set([...(form.owner ? [form.owner] : []), ...people])].map(
      (name) => ({ value: name, label: name }),
    ),
  ];
  const waitLocked = routineWaitLocked(form, inbox, isInstanceOwner);
  const stats = inbox?.draftStats;

  return (
    <>
      <SettingsDialog
        open={open}
        onClose={onClose}
        title={editing ? `Edit ${inbox.label}` : "Connect an inbox"}
        error={error}
        busy={busy}
        onSave={save}
        wide
        leading={
          stale ? (
            <Button
              type="button"
              variant="soft"
              className="phone:min-h-11"
              onClick={onReload}
            >
              Reload
            </Button>
          ) : inbox ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="soft"
                className="phone:min-h-11"
                disabled={busy}
                onClick={toggleEnabled}
              >
                {inbox.enabled ? "Turn off" : "Turn on"}
              </Button>
              {isInstanceOwner && (
                <Button
                  type="button"
                  variant="danger"
                  className="phone:min-h-11"
                  disabled={busy}
                  onClick={remove}
                >
                  Remove inbox
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        <FormSection title="Mailbox">
          <FormField label="Address">
            <Input
              aria-label="Address"
              className={DIALOG_INPUT}
              type="email"
              value={form.address}
              placeholder="help@example.test"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => set({ address: e.target.value })}
            />
          </FormField>
          <FormField label="Name shown to customers">
            <Input
              aria-label="Name shown to customers"
              className={DIALOG_INPUT}
              value={form.label}
              placeholder="Acme support"
              onChange={(e) => set({ label: e.target.value })}
            />
          </FormField>
          {serverFields("imap")}
          {serverFields("smtp")}
          {isInstanceOwner && (
            <label className={CHECK_ROW}>
              <span className="min-w-0 flex-1">
                Mail servers on this machine or a private network
              </span>
              <Switch
                checked={form.allowInternalHost}
                onCheckedChange={(allowInternalHost) =>
                  set({ allowInternalHost })
                }
              />
            </label>
          )}
          <div className="flex flex-col items-start gap-2">
            <Button
              type="button"
              variant="soft"
              className="phone:min-h-11"
              disabled={testing}
              onClick={runTest}
            >
              Test connection
            </Button>
            {testing && <p className={FIELD_HINT}>Testing the connection</p>}
            {testError && <InlineAlert>{testError}</InlineAlert>}
            {lines && (
              <ul className={INBOX_TEST_LINES} aria-live="polite">
                <li className={tested?.imap.ok ? "text-fg" : "text-red"}>
                  {lines.imap}
                </li>
                <li className={tested?.smtp.ok ? "text-fg" : "text-red"}>
                  {lines.smtp}
                </li>
              </ul>
            )}
          </div>
        </FormSection>

        <FormSection title="Handling">
          <FormField label="Project">
            {projects.length ? (
              <OptionSelect
                label="Project"
                className={INBOX_SELECT}
                value={form.project}
                options={projects.map((p) => ({ value: p.id, label: p.id }))}
                onChange={(next) => set({ project: next })}
              />
            ) : (
              <p className={FIELD_HINT}>Add a repository first</p>
            )}
          </FormField>
          <FormField label="Owner">
            {ownerOptions.length > (editing ? 0 : 1) ? (
              <OptionSelect
                label="Owner"
                className={INBOX_SELECT}
                value={form.owner}
                options={ownerOptions}
                onChange={(owner) => set({ owner })}
              />
            ) : (
              <Input
                aria-label="Owner"
                className={DIALOG_INPUT}
                value={form.owner}
                onChange={(e) => set({ owner: e.target.value })}
              />
            )}
          </FormField>
          <div className="flex flex-col gap-1.5">
            <div className={INBOX_LEGEND_ROW}>
              <span id={autonomyId} className={INBOX_LEGEND}>
                Autonomy
              </span>
              {stats && (
                <span className="text-meta text-dim">
                  {draftStatsLine(stats)}
                </span>
              )}
            </div>
            <RadioGroup
              aria-labelledby={autonomyId}
              className={INBOX_AUTONOMY_CHOICES}
              value={form.autonomy}
              onValueChange={(next) => {
                const choice = AUTONOMY_CHOICES.find((c) => c.value === next);
                if (choice) set({ autonomy: choice.value });
              }}
            >
              {AUTONOMY_CHOICES.map((choice) => (
                <label key={choice.value} className={INBOX_AUTONOMY_CHOICE}>
                  <Radio
                    value={choice.value}
                    aria-label={choice.label}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-fg">
                      {choice.label}
                    </span>
                    <span className="block text-meta text-dim">
                      {choice.description}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
          {form.autonomy === "routine" && (
            <div className="flex flex-col gap-2">
              <label className={CHECK_ROW}>
                <span className="min-w-0 flex-1">Wait before sending</span>
                <Switch
                  aria-label="Wait before sending"
                  checked={form.routineWaits}
                  disabled={!!waitLocked}
                  onCheckedChange={(routineWaits) => set({ routineWaits })}
                />
              </label>
              {form.routineWaits ? (
                <FormField
                  label="Minutes to wait"
                  hint={
                    waitLocked ??
                    "A routine reply waits this long so someone can stop it"
                  }
                >
                  <Input
                    aria-label="Minutes to wait"
                    className={DIALOG_INPUT}
                    inputMode="numeric"
                    value={form.vetoMinutes}
                    onChange={(e) => set({ vetoMinutes: e.target.value })}
                  />
                </FormField>
              ) : (
                <p className={FIELD_HINT}>Routine replies send right away</p>
              )}
            </div>
          )}
          {warn && (
            <InlineAlert variant="warn">{CONNECTOR_WARNING}</InlineAlert>
          )}
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className={INBOX_LEGEND}>Never without a person</legend>
            <p className={`${FIELD_HINT} mb-1.5`}>
              Mail about these always waits for you. So does a customer who asks
              for a person, sounds upset or repeats a question
            </p>
            {SUPPORT_TOPICS.map((topic) => (
              <label key={topic} className={CHECK_ROW}>
                <Checkbox
                  checked={form.neverWithoutAPerson.includes(topic)}
                  onCheckedChange={(checked) =>
                    set({
                      neverWithoutAPerson: checked
                        ? [...form.neverWithoutAPerson, topic]
                        : form.neverWithoutAPerson.filter((t) => t !== topic),
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  {SUPPORT_TOPIC_LABELS[topic]}
                </span>
              </label>
            ))}
          </fieldset>
        </FormSection>

        <FormSection title="Mailbox behaviour">
          <FormField label="When a conversation is handled">
            <OptionSelect<MailboxBehaviour>
              label="When a conversation is handled"
              className={INBOX_SELECT}
              value={form.mailbox}
              options={MAILBOX_BEHAVIOURS.map((value) => ({
                value,
                label: MAILBOX_BEHAVIOUR_COPY[value],
              }))}
              onChange={(mailbox) => set({ mailbox })}
            />
          </FormField>
          <label className={CHECK_ROW}>
            <span className="min-w-0 flex-1">Save a copy in Sent</span>
            <Switch
              aria-label="Save a copy in Sent"
              checked={effectiveCopyToSent(form)}
              onCheckedChange={(copyToSent) =>
                set({ copyToSent, copyToSentTouched: true })
              }
            />
          </label>
          <FormField label="Send limit per minute">
            <Input
              aria-label="Send limit per minute"
              className={DIALOG_INPUT}
              inputMode="numeric"
              value={form.sendLimitPerMinute}
              onChange={(e) => set({ sendLimitPerMinute: e.target.value })}
            />
          </FormField>
        </FormSection>

        <FormSection title="Retention">
          <div className={INBOX_FORM_PAIR}>
            <FormField label="Conversations (days)">
              <Input
                aria-label="Conversations (days)"
                className={DIALOG_INPUT}
                inputMode="numeric"
                value={form.conversationDays}
                onChange={(e) => set({ conversationDays: e.target.value })}
              />
            </FormField>
            <FormField label="Attachments (days)">
              <Input
                aria-label="Attachments (days)"
                className={DIALOG_INPUT}
                inputMode="numeric"
                value={form.attachmentDays}
                onChange={(e) => set({ attachmentDays: e.target.value })}
              />
            </FormField>
          </div>
          <p className={FIELD_HINT}>
            Counted from when a conversation closes. Retention never changes the
            mailbox
          </p>
        </FormSection>
      </SettingsDialog>
      {confirmDialog}
    </>
  );
}
