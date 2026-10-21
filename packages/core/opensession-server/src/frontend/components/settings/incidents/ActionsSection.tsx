import type * as React from "react";
import { useEffect, useEffectEvent, useId, useState } from "react";
import {
  ACTION_KINDS,
  type ActionKind,
  type ActionTemplateName,
  type IncidentAction,
} from "../../../../shared/incident-response";
import {
  bindProductionRunnerApi,
  type ProductionPairing,
  type ProductionRunnerView,
  type ProjectSettingsInput,
  type ProjectSettingsView,
  startProductionPairingApi,
} from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import {
  ACTION_ROW_COMMAND,
  ACTION_ROW_DESC,
  CHECK_ROW,
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
  HOST_LIST,
  HOST_ROW,
  HOST_ROW_NAME,
  HOST_ROW_TEXT,
  PAIRING_WELL,
} from "../../../lib/incident-settings-classes";
import {
  ACTION_KIND_LABELS,
  ACTION_TIMEOUT_CHOICES,
  type ActionDraft,
  type ActionField,
  actionBadges,
  applyTemplate,
  commandProblem,
  draftFromAction,
  draftToAction,
  firstLine,
  newAction,
  PLACEHOLDER_LIST,
  runnerInUse,
  switchActionKind,
  TEMPLATE_LABELS,
  TEMPLATE_NAMES,
  takenKinds,
  templateNamed,
  withAction,
  withoutAction,
} from "../../../lib/incidents/action-form";
import {
  minutesOptions,
  withCurrent,
} from "../../../lib/incidents/policy-copy";
import { repoLabel } from "../../../lib/repo-label";
import { clockTime } from "../../../lib/time";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { useConfirm } from "../../../ui/confirm";
import { FieldGrid, Input, Textarea } from "../../../ui/input";
import { OptionSelect } from "../../../ui/select";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../../ui/settings";
import { EmptyState, InlineAlert } from "../../../ui/state";
import { Switch } from "../../../ui/switch";
import { toast } from "../../../ui/toast";
import { IconPlus } from "../../icons";
import { CopyUrl, FormField, FormSection } from "./FormParts";
import { SettingLinkRow } from "./SettingLinkRow";
import { SettingsDialog } from "./SettingsDialog";

type Save = (input: ProjectSettingsInput) => Promise<void>;
type Dialog =
  | { kind: "hosts" }
  | { kind: "action"; action: IncidentAction | null };

const PAIRING_POLL_MS = 5_000;
const NO_TEMPLATE = "none";

function runnerName(runner: ProductionRunnerView): string {
  return runner.label || runner.name;
}

/** The kind a new action starts as: the deploy, then the rollback, until
 *  the project has them. */
function nextKind(actions: IncidentAction[]): ActionKind {
  if (!actions.some((a) => a.kind === "deploy")) return "deploy";
  if (!actions.some((a) => a.kind === "rollback")) return "rollback";
  return "pause";
}

/**
 * The project's actions: where they run (its production hosts) and the
 * command each one maps to. Agents propose them; Sessions runs them.
 */
export function ActionsSection({
  project,
  view,
  onSave,
  onRevalidate,
}: {
  project: string;
  view: ProjectSettingsView;
  onSave: Save;
  /** Reload the project's settings and Runners. */
  onRevalidate: () => void;
}) {
  const label = repoLabel(project);
  const { actions } = view.settings;
  const bound = view.runners.filter((runner) => runner.bound);
  const nameOf = (id: string) => {
    const runner = view.runners.find((r) => r.id === id);
    return runner ? runnerName(runner) : id;
  };
  // `key` starts every open from the settings as stored.
  const [dialog, setDialog] = useState<(Dialog & { key: number }) | null>(null);
  const [open, setOpen] = useState(false);
  const [opens, setOpens] = useState(0);
  const show = (next: Dialog) => {
    setOpens(opens + 1);
    setDialog({ ...next, key: opens + 1 });
    setOpen(true);
  };
  const addAction = () => show({ kind: "action", action: null });

  const addButton = (
    <Button
      size="sm"
      variant="soft"
      className="phone:min-h-11"
      onClick={addAction}
    >
      Add an action
    </Button>
  );

  return (
    <>
      <SettingsGroupLabel actions={actions.length > 0 && addButton}>
        Actions
      </SettingsGroupLabel>
      <SettingCard>
        <SettingLinkRow
          title="Production hosts"
          description="Actions run here. Checks that depend on IP or TLS fingerprint can run here too"
          value={
            bound.length ? bound.map(runnerName).join(", ") : "None paired"
          }
          onClick={() => show({ kind: "hosts" })}
        />
        {actions.length ? (
          actions.map((action) => (
            <SettingLinkRow
              key={action.id}
              title={action.label}
              description={
                <span className={ACTION_ROW_DESC}>
                  <code className={ACTION_ROW_COMMAND}>
                    {firstLine(action.command)}
                  </code>
                  <span className="shrink-0">on {nameOf(action.runner)}</span>
                </span>
              }
              stacked
              value={actionBadges(action).map((badge) => (
                <Badge key={badge.text} tone={badge.tone}>
                  {badge.text}
                </Badge>
              ))}
              onClick={() => show({ kind: "action", action })}
            />
          ))
        ) : (
          <EmptyState placement="row" action={addButton}>
            No actions yet. Agents can only propose a fix until there is a
            deploy or rollback action
          </EmptyState>
        )}
      </SettingCard>
      <SettingsHint>
        Agents propose actions; Sessions checks the policy and runs them
      </SettingsHint>

      {dialog?.kind === "hosts" && (
        <ProductionHostsDialog
          key={dialog.key}
          open={open}
          onClose={() => setOpen(false)}
          project={project}
          label={label}
          view={view}
          onSave={onSave}
          onRevalidate={onRevalidate}
        />
      )}
      {dialog?.kind === "action" && (
        <ActionDialog
          key={dialog.key}
          open={open}
          onClose={() => setOpen(false)}
          action={dialog.action}
          actions={actions}
          runners={bound}
          nextKind={nextKind(actions)}
          onSave={onSave}
          onOpenHosts={() => show({ kind: "hosts" })}
        />
      )}
    </>
  );
}

/**
 * Which paired Runners serve the project's production, and pairing a new
 * one. Each switch writes at once; reserving a Runner that serves anything
 * else asks first, since it stops serving it.
 */
function ProductionHostsDialog({
  open,
  onClose,
  project,
  label,
  view,
  onSave,
  onRevalidate,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  label: string;
  view: ProjectSettingsView;
  onSave: Save;
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
  const [confirm, confirmDialog] = useConfirm();

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

  const bind = (runner: ProductionRunnerView, confirmed: boolean) => {
    setBusy(runner.id);
    bindProductionRunnerApi(project, runner.id, confirmed).then(
      () => {
        setBusy(null);
        onRevalidate();
        toast(`${runnerName(runner)} now serves ${label}`);
      },
      (error) => {
        setBusy(null);
        setRowError({
          id: runner.id,
          message: errorMessage(error, "Couldn't use this host"),
        });
      },
    );
  };

  const toggle = (runner: ProductionRunnerView, on: boolean) => {
    setRowError(null);
    if (on) {
      if (!runner.confirm) return bind(runner, false);
      confirm({
        title: `Reserve ${runnerName(runner)} for ${label}?`,
        description: `${runner.confirm}. Once reserved, only ${label} incidents can use it, and what it runs now stops`,
        confirmLabel: "Reserve",
        destructive: true,
        onConfirm: () => bind(runner, true),
      });
      return;
    }
    const inUse = runnerInUse(view.settings.actions, runner.id);
    if (inUse) return setRowError({ id: runner.id, message: inUse });
    setBusy(runner.id);
    onSave({
      productionRunners: view.settings.productionRunners.filter(
        (id) => id !== runner.id,
      ),
    }).then(
      () => setBusy(null),
      (error) => {
        setBusy(null);
        setRowError({
          id: runner.id,
          message: errorMessage(error, "Couldn't remove this host"),
        });
      },
    );
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
    <>
      <SettingsDialog
        open={open}
        onClose={onClose}
        title="Production hosts"
        error={pairError}
      >
        <p className={FIELD_HINT}>
          {`Runners reserved for ${label} incidents. Actions run on them, and checks can too. Nothing else can use a reserved Runner`}
        </p>
        <ProductionHostsList
          label={label}
          runners={view.runners}
          busy={busy}
          error={rowError}
          onToggle={toggle}
        />
        {pairing ? (
          <div className={PAIRING_WELL}>
            <p className="m-0 text-body text-fg">
              {`Run this on the production host. It joins as a Runner that may only run commands for ${label}`}
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
              Pair a new host
            </Button>
          </div>
        )}
      </SettingsDialog>
      {confirmDialog}
    </>
  );
}

/** The paired Runners with their state and a switch each, as data in and
 *  toggles out. A Runner with a problem can be switched off, never on. */
export function ProductionHostsList({
  label,
  runners,
  busy,
  error = null,
  onToggle,
}: {
  label: string;
  runners: ProductionRunnerView[];
  /** The Runner being switched. */
  busy: string | null;
  error?: { id: string; message: string } | null;
  onToggle: (runner: ProductionRunnerView, on: boolean) => void;
}) {
  if (!runners.length)
    return (
      <EmptyState placement="row">
        No Runners paired yet. Pair one on the production host
      </EmptyState>
    );
  return (
    <ul className={cn(HOST_LIST, "m-0 list-none p-0")}>
      {runners.map((runner) => {
        const name = runnerName(runner);
        const rowMessage = error?.id === runner.id ? error.message : null;
        return (
          <li key={runner.id} className={HOST_ROW}>
            <span className={HOST_ROW_TEXT}>
              <span className={HOST_ROW_NAME}>{name}</span>
              <span className="text-meta text-dim">
                {runner.online ? "Online" : "Offline"}
                {runner.label && runner.label !== runner.name
                  ? ` · ${runner.name}`
                  : ""}
              </span>
              {runner.problem ? (
                <span className="text-meta text-red">{runner.problem}</span>
              ) : runner.confirm ? (
                <span className="text-meta text-yellow">{runner.confirm}</span>
              ) : null}
              {rowMessage && (
                <span role="alert" className={FIELD_ERROR}>
                  {rowMessage}
                </span>
              )}
            </span>
            <Switch
              checked={runner.bound}
              disabled={
                busy === runner.id || (!runner.bound && !!runner.problem)
              }
              aria-label={`Use ${name} for ${label}`}
              onCheckedChange={(on) => onToggle(runner, on)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** Add or edit one action. Save sends the project's whole list. */
function ActionDialog({
  open,
  onClose,
  action,
  actions,
  runners,
  nextKind: firstKind,
  onSave,
  onOpenHosts,
}: {
  open: boolean;
  onClose: () => void;
  action: IncidentAction | null;
  actions: IncidentAction[];
  /** The project's bound production Runners. */
  runners: ProductionRunnerView[];
  nextKind: ActionKind;
  onSave: Save;
  onOpenHosts: () => void;
}) {
  const [draft, setDraft] = useState<ActionDraft>(() =>
    action
      ? draftFromAction(action, false)
      : draftFromAction(
          newAction(
            firstKind,
            runners[0]?.id ?? "",
            actions.map((a) => a.id),
          ),
          true,
        ),
  );
  const [fieldError, setFieldError] = useState<{
    field: ActionField;
    error: string;
  } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const idBase = useId();
  const idFor = (field: ActionField) => `${idBase}-${field}`;

  const save = () => {
    const out = draftToAction(draft, actions);
    if ("field" in out) {
      setFieldError(out);
      document.getElementById(idFor(out.field))?.focus();
      return;
    }
    setBusy(true);
    setServerError(null);
    onSave({ actions: withAction(actions, out.action) }).then(
      () => {
        setBusy(false);
        toast(action ? "Action saved" : "Action added");
        onClose();
      },
      (error) => {
        setBusy(false);
        setServerError(errorMessage(error, "Couldn't save the action"));
      },
    );
  };

  const remove = () => {
    if (!action) return;
    confirm({
      title: `Remove ${action.label}?`,
      description: "Incidents can no longer run it",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () =>
        onSave({ actions: withoutAction(actions, action.id) }).then(
          () => {
            toast("Action removed");
            onClose();
          },
          (error) =>
            setServerError(errorMessage(error, "Couldn't remove the action")),
        ),
    });
  };

  return (
    <>
      <SettingsDialog
        open={open}
        onClose={onClose}
        title={action ? `Edit ${action.label}` : "New action"}
        error={serverError}
        busy={busy}
        onSave={save}
        wide
        leading={
          action ? (
            <Button type="button" variant="danger" onClick={remove}>
              Remove
            </Button>
          ) : null
        }
      >
        <ActionFields
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setFieldError(null);
          }}
          error={fieldError}
          idFor={idFor}
          runners={runners}
          others={actions.filter((a) => a.id !== action?.id)}
          onOpenHosts={() => {
            onClose();
            onOpenHosts();
          }}
        />
      </SettingsDialog>
      {confirmDialog}
    </>
  );
}

/**
 * The action dialog's fields, as data in and edits out: what kind, where it
 * runs, the command and its limits, and what it touches.
 */
export function ActionFields({
  draft,
  onChange,
  error,
  idFor,
  runners,
  others,
  onOpenHosts,
}: {
  draft: ActionDraft;
  onChange: (next: ActionDraft) => void;
  error: { field: ActionField; error: string } | null;
  idFor: (field: ActionField) => string;
  runners: ProductionRunnerView[];
  /** The project's other actions (one deploy and one rollback each). */
  others: IncidentAction[];
  onOpenHosts: () => void;
}) {
  const [template, setTemplate] = useState<ActionTemplateName | null>(null);
  const scopeId = useId();
  const set = (patch: Partial<ActionDraft>) => onChange({ ...draft, ...patch });
  const messageId = (field: ActionField) => `${idFor(field)}-message`;
  const errorOf = (field: ActionField) =>
    error?.field === field ? error.error : null;
  const taken = takenKinds(others, draft.id);
  const commandError = errorOf("command") ?? commandProblem(draft.command);
  const runnerOptions = runners.map((runner) => ({
    value: runner.id,
    label: runnerName(runner),
  }));
  // A host that left the project still shows, so the select never lies.
  if (draft.runner && !runners.some((r) => r.id === draft.runner))
    runnerOptions.push({
      value: draft.runner,
      label: `${draft.runner} (not a production host)`,
    });
  const text = (
    field: "label" | "cwd" | "usd",
    value: string,
    onText: (value: string) => void,
    props: React.ComponentProps<typeof Input> = {},
  ) => (
    <Input
      id={idFor(field)}
      value={value}
      aria-invalid={error?.field === field || undefined}
      aria-describedby={error?.field === field ? messageId(field) : undefined}
      autoComplete="off"
      spellCheck={false}
      {...props}
      className={cn(DIALOG_INPUT, props.className)}
      onChange={(event) => onText(event.currentTarget.value)}
    />
  );

  return (
    <>
      <FieldGrid>
        <FormField label="Kind">
          <OptionSelect<ActionKind>
            label="Kind"
            value={draft.kind}
            options={ACTION_KINDS.map((kind) => ({
              value: kind,
              label: ACTION_KIND_LABELS[kind],
              disabled: taken.includes(kind),
            }))}
            onChange={(kind) =>
              onChange(switchActionKind(draft, kind, template))
            }
            className="w-full justify-between phone:min-h-11"
          />
        </FormField>
        <FormField
          label="Name"
          htmlFor={idFor("label")}
          error={errorOf("label")}
          messageId={messageId("label")}
        >
          {text("label", draft.label, (label) => set({ label }), {
            maxLength: 60,
          })}
        </FormField>
      </FieldGrid>
      <FormField
        label="Runs on"
        error={errorOf("runner")}
        messageId={messageId("runner")}
      >
        {runners.length ? (
          <OptionSelect
            label="Runs on"
            value={draft.runner}
            options={runnerOptions}
            onChange={(runner) => set({ runner })}
            className="w-full justify-between phone:min-h-11"
          />
        ) : (
          <InlineAlert
            variant="info"
            onRetry={onOpenHosts}
            retryLabel="Production hosts"
          >
            Pair a production host first
          </InlineAlert>
        )}
      </FormField>
      <FormField label="Start from a template">
        <OptionSelect
          label="Start from a template"
          value={template ?? NO_TEMPLATE}
          options={[
            { value: NO_TEMPLATE, label: "None" },
            ...TEMPLATE_NAMES.map((name) => ({
              value: name,
              label: TEMPLATE_LABELS[name],
            })),
          ]}
          onChange={(name) => {
            const picked = templateNamed(name);
            setTemplate(picked);
            if (!picked) return;
            onChange(applyTemplate(draft, picked));
          }}
          className="w-full justify-between phone:min-h-11"
        />
      </FormField>
      <FormField
        label="Command"
        htmlFor={idFor("command")}
        error={commandError}
        messageId={messageId("command")}
        hint={`Placeholders: ${PLACEHOLDER_LIST}. Sessions quotes their values, so keep them outside quotes`}
      >
        <Textarea
          id={idFor("command")}
          value={draft.command}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder="./deploy.sh {{ref}}"
          aria-invalid={!!commandError || undefined}
          aria-describedby={messageId("command")}
          className={cn("font-mono", DIALOG_INPUT)}
          onChange={(event) => set({ command: event.currentTarget.value })}
        />
      </FormField>
      {commandError && (
        <p className={FIELD_HINT}>
          {`Placeholders: ${PLACEHOLDER_LIST}. Sessions quotes their values, so keep them outside quotes`}
        </p>
      )}
      <FieldGrid>
        <FormField
          label="Working directory"
          htmlFor={idFor("cwd")}
          error={errorOf("cwd")}
          messageId={messageId("cwd")}
        >
          {text("cwd", draft.cwd, (cwd) => set({ cwd }), {
            placeholder: "/srv/app",
            className: "font-mono",
          })}
        </FormField>
        <FormField label="Timeout">
          <OptionSelect
            label="Timeout"
            value={String(draft.timeoutMs)}
            options={minutesOptions(
              withCurrent(ACTION_TIMEOUT_CHOICES, draft.timeoutMs),
            )}
            onChange={(ms) => set({ timeoutMs: Number(ms) })}
            className="w-full justify-between phone:min-h-11"
          />
        </FormField>
      </FieldGrid>
      <div className="flex flex-col">
        <label className={CHECK_ROW}>
          <span className="min-w-0 flex-1">Can be undone</span>
          <Switch
            checked={draft.reversible}
            onCheckedChange={(reversible) => set({ reversible })}
          />
        </label>
        <label className={CHECK_ROW}>
          <span className="min-w-0 flex-1">Costs money</span>
          <Switch
            checked={draft.costs}
            onCheckedChange={(costs) => set({ costs })}
          />
        </label>
        {draft.costs && (
          <FormField
            label="Each run costs, in dollars"
            htmlFor={idFor("usd")}
            error={errorOf("usd")}
            messageId={messageId("usd")}
            className="pb-2"
          >
            {text("usd", draft.usd, (usd) => set({ usd }), {
              inputMode: "decimal",
              placeholder: "5.00",
              className: "tabular-nums",
            })}
          </FormField>
        )}
        <label className={CHECK_ROW}>
          <span className="min-w-0 flex-1">Needs a secret</span>
          <Switch
            checked={draft.needsSecret}
            onCheckedChange={(needsSecret) => set({ needsSecret })}
          />
        </label>
        <p className={FIELD_HINT}>
          Never without you decides which of these wait for you
        </p>
      </div>
      <FormSection title="Scope">
        <p className={FIELD_HINT}>
          Globs like src/** or db/migrations/**. Empty paths means anywhere
        </p>
        {(
          [
            ["services", "Services", "api, worker"],
            ["paths", "Paths", "src/**"],
            ["migrationPaths", "Migration paths", "db/migrations/**"],
          ] as const
        ).map(([key, label, placeholder]) => (
          <FormField key={key} label={label} htmlFor={`${scopeId}-${key}`}>
            <Input
              id={`${scopeId}-${key}`}
              value={draft[key]}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className={cn("font-mono", DIALOG_INPUT)}
              onChange={(event) => set({ [key]: event.currentTarget.value })}
            />
          </FormField>
        ))}
      </FormSection>
    </>
  );
}
