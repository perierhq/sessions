import type * as React from "react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  type AccessPreview,
  type AccessProfileField,
  type AccessProfileFields,
  type CompleteAccessProfile,
  type CredentialGrantMode,
  egressRouteKey,
  hostGrantKey,
  type IncidentAccessSettingsView,
  type IncidentAgentRole,
  INCIDENT_AGENT_ROLES,
} from "../../../../shared/incident-access";
import type { SignalView } from "../../../../shared/incidents";
import { useAccessSettings, useSignals } from "../../../hooks/useIncidents";
import { fetchModels } from "../../../lib/api/automations";
import {
  type AccessPreviewInput,
  apiStatus,
  deleteAccessOverride,
  previewAccessApi,
  type ProjectSettingsView,
  putAccessOverride,
  putAccessProfile,
  resetAccessSettings,
} from "../../../lib/api/incidents";
import { fetchRunners } from "../../../lib/api/runners";
import { errorMessage } from "../../../lib/error-message";
import {
  ACCESS_PREVIEW,
  CHECK_LIST,
  CHECK_ROW,
  ACCESS_FIELD,
  ACCESS_FIELD_HEAD,
  ACCESS_INHERIT,
  CREDENTIAL_LINE,
  FIELD_ERROR,
  FIELD_HINT,
  SETTING_WIDE_CONTROL,
  SETTING_WIDE_SELECT,
} from "../../../lib/incident-settings-classes";
import {
  AUTOMATIC,
  describeField,
  effectiveProfile,
  egressLabel,
  FIELD_LABELS,
  GRANT_MODE_LABELS,
  type GrantedChoices,
  grantedChoices,
  grantsSummary,
  independenceText,
  inheritField,
  MODE_LABELS,
  modelChoices,
  overrideSummary,
  previewDraft,
  ROLE_LABELS,
  summaryWithoutRole,
  toggleIn,
} from "../../../lib/incidents/access-form";
import { repoLabel } from "../../../lib/repo-label";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { useConfirm } from "../../../ui/confirm";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { OptionSelect } from "../../../ui/select";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
} from "../../../ui/settings";
import { InlineAlert, SkeletonBar } from "../../../ui/state";
import { toast } from "../../../ui/toast";
import { SettingRow } from "../shared";
import { AccessGrantsDialog } from "./AccessGrantsDialog";
import { FormField, ListInput } from "./FormParts";
import { SettingLinkRow } from "./SettingLinkRow";
import { SettingsDialog } from "./SettingsDialog";

type Agents = { investigatorModel?: string; verifierModel?: string };
type ModelsView = ProjectSettingsView["models"];
type AccessDialog =
  | { kind: "grants" }
  | { kind: "add-override" }
  | { kind: "role"; role: IncidentAgentRole; signal: SignalView | null };

const PREVIEW_DELAY_MS = 400;
const CONFLICT = "Access settings changed since you loaded them";
const NO_ROUTE = "none";

/**
 * Who the incident agents are and what they may reach: the project's
 * grants (the ceiling), a profile per role, the role models, and
 * per-signal overrides. Writes carry the revision they were made against;
 * a stale one reloads and says so.
 */
export function AccessSection({
  project,
  models,
  agents,
  onSaveModels,
}: {
  project: string;
  /** The fix loop's role models; null when the server has no fix loop. */
  models: ModelsView | null;
  agents: Agents | null;
  onSaveModels: (agents: {
    investigatorModel?: string | null;
    verifierModel?: string | null;
  }) => Promise<void>;
}) {
  const label = repoLabel(project);
  const access = useAccessSettings(project);
  const signals = useSignals();
  const view = access.data;
  const runners = useSWR(
    view ? ["api", "runners-for-incident-access"] : null,
    fetchRunners,
  );
  const catalog = useSWR(
    models ? ["api", "models-for-incident-access"] : null,
    fetchModels,
  );
  const previewKey = (role: IncidentAgentRole) =>
    view
      ? ["api", "incident-access-preview", project, role, view.revision]
      : null;
  const investigator = useSWR(previewKey("investigator"), () =>
    previewAccessApi({ project, role: "investigator" }),
  );
  const verifier = useSWR(previewKey("verifier"), () =>
    previewAccessApi({ project, role: "verifier" }),
  );
  const [confirm, confirmDialog] = useConfirm();
  // `key` starts every open from the settings as stored.
  const [dialog, setDialog] = useState<(AccessDialog & { key: number }) | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [opens, setOpens] = useState(0);
  const show = (next: AccessDialog) => {
    setOpens(opens + 1);
    setDialog({ ...next, key: opens + 1 });
    setOpen(true);
  };

  const own = (signals.data ?? []).filter((s) => s.project === project);
  const runnerName = (id: string) => {
    const runner = runners.data?.runners.find((r) => r.id === id);
    return runner ? runner.label || runner.name : id;
  };
  const credentialName = (id: string) =>
    view?.credentialInfo[id]?.service ?? id;
  const saved = (next: IncidentAccessSettingsView) =>
    void access.mutate(next, { revalidate: false });
  const conflict = async () => {
    toast(CONFLICT, { variant: "error" });
    return (await access.mutate()) ?? null;
  };
  const previewOf = (
    role: IncidentAgentRole,
  ): AccessPreview | { error: string } | undefined => {
    const swr = role === "investigator" ? investigator : verifier;
    if (swr.error)
      return { error: errorMessage(swr.error, "Couldn't preview access") };
    return swr.data;
  };

  const reset = () =>
    confirm({
      title: `Reset access for ${label}?`,
      description:
        "Every role goes back to the defaults and every credential grant is removed",
      confirmLabel: "Reset",
      destructive: true,
      onConfirm: () =>
        resetAccessSettings(project, view?.revision).then(
          (next) => {
            saved(next);
            toast(`Access for ${label} is back to the defaults`);
          },
          (error) => {
            if (apiStatus(error) === 409) void conflict();
            else
              toast(errorMessage(error, "Couldn't reset access"), {
                variant: "error",
              });
          },
        ),
    });

  const setModel = (role: IncidentAgentRole, value: string) => {
    const key = role === "investigator" ? "investigatorModel" : "verifierModel";
    onSaveModels({ [key]: value === AUTOMATIC ? null : value }).catch((error) =>
      toast(errorMessage(error, "Couldn't save the model"), {
        variant: "error",
      }),
    );
  };

  const openOverride = (role: IncidentAgentRole, signalId: string) =>
    show({
      kind: "role",
      role,
      signal: own.find((s) => s.id === signalId) ?? null,
    });

  return (
    <>
      <AccessRows
        label={label}
        view={view}
        error={
          access.error
            ? {
                message: errorMessage(
                  access.error,
                  "Couldn't load the access settings",
                ),
                unreadable: apiStatus(access.error) === 500,
              }
            : null
        }
        previews={{
          investigator: previewOf("investigator"),
          verifier: previewOf("verifier"),
        }}
        models={models}
        agents={agents}
        modelOptions={modelChoices(catalog.data?.models ?? [], null)}
        signals={own}
        runnerName={runnerName}
        onOpenGrants={() => show({ kind: "grants" })}
        onOpenRole={(role) => show({ kind: "role", role, signal: null })}
        onOpenOverride={(o) => openOverride(o.role, o.signalId)}
        onAddOverride={() => show({ kind: "add-override" })}
        onModel={setModel}
        onReset={reset}
        onRetry={() => void access.mutate()}
      />
      {view && dialog?.kind === "grants" && (
        <AccessGrantsDialog
          key={dialog.key}
          open={open}
          onClose={() => setOpen(false)}
          project={project}
          label={label}
          view={view}
          onSaved={saved}
          onConflict={conflict}
        />
      )}
      {view && dialog?.kind === "add-override" && (
        <AddOverrideDialog
          key={dialog.key}
          open={open}
          onClose={() => setOpen(false)}
          signals={own}
          onNext={(role, signalId) => openOverride(role, signalId)}
        />
      )}
      {view && dialog?.kind === "role" && (
        <RoleDialog
          key={dialog.key}
          open={open}
          onClose={() => setOpen(false)}
          project={project}
          role={dialog.role}
          signal={dialog.signal}
          view={view}
          runnerName={runnerName}
          credentialName={credentialName}
          modelOptions={modelChoices(catalog.data?.models ?? [], null)}
          onSaved={saved}
          onConflict={conflict}
        />
      )}
      {confirmDialog}
    </>
  );
}

/**
 * The Access group, as data in and presses out: the grants, a row per role,
 * the role models (with the fix loop), and a row per override. `view` is
 * undefined while loading and null when the server has no access profiles.
 */
export function AccessRows({
  label,
  view,
  error,
  previews,
  models,
  agents,
  modelOptions,
  signals,
  runnerName,
  onOpenGrants,
  onOpenRole,
  onOpenOverride,
  onAddOverride,
  onModel,
  onReset,
  onRetry,
}: {
  label: string;
  view: IncidentAccessSettingsView | null | undefined;
  error: { message: string; unreadable: boolean } | null;
  previews: Record<
    IncidentAgentRole,
    AccessPreview | { error: string } | undefined
  >;
  models: ModelsView | null;
  agents: Agents | null;
  modelOptions: Array<{ value: string; label: string }>;
  /** The project's signals. */
  signals: SignalView[];
  runnerName: (id: string) => string;
  onOpenGrants: () => void;
  onOpenRole: (role: IncidentAgentRole) => void;
  onOpenOverride: (o: IncidentAccessSettingsView["overrides"][number]) => void;
  onAddOverride: () => void;
  onModel: (role: IncidentAgentRole, value: string) => void;
  onReset: () => void;
  onRetry: () => void;
}) {
  const heading = (actions?: React.ReactNode) => (
    <SettingsGroupLabel actions={actions}>Access</SettingsGroupLabel>
  );
  if (error)
    return (
      <>
        {heading()}
        {error.unreadable ? (
          <InlineAlert onRetry={onReset} retryLabel="Reset to defaults">
            {error.message}
          </InlineAlert>
        ) : (
          <InlineAlert onRetry={onRetry}>{error.message}</InlineAlert>
        )}
      </>
    );
  if (view === undefined)
    return (
      <>
        {heading()}
        <SettingCardSkeleton rows={3} />
      </>
    );
  if (view === null)
    return (
      <>
        {heading()}
        <InlineAlert variant="info">
          Access profiles need incident agent access on this server
        </InlineAlert>
      </>
    );

  const roleDescription = (role: IncidentAgentRole) => {
    const preview = previews[role];
    if (!preview) return <SkeletonBar className="mt-1 h-2.5 w-[52%]" />;
    if ("access" in preview && preview.access)
      return summaryWithoutRole(preview.access.summary, role);
    return (
      <span className="text-red">
        {preview.error ?? "Couldn't work out this role's access"}
      </span>
    );
  };
  const modelRow = (role: IncidentAgentRole) => {
    if (!models) return null;
    const key = role === "investigator" ? "investigatorModel" : "verifierModel";
    const current = agents?.[key];
    let desc: React.ReactNode;
    if ("error" in models)
      desc = <span className="text-red">{models.error}</span>;
    else if (role === "investigator") desc = models.investigator.label;
    else
      desc = `${models.verifier.label} · ${independenceText(models.verifier.independence)}`;
    const options = [...modelOptions];
    if (current && !options.some((o) => o.value === current))
      options.push({ value: current, label: current });
    return (
      <SettingRow
        key={`${role}-model`}
        title={`${ROLE_LABELS[role]} model`}
        desc={desc}
        controlClassName={SETTING_WIDE_CONTROL}
        control={
          <OptionSelect
            label={`${ROLE_LABELS[role]} model`}
            value={current ?? AUTOMATIC}
            options={options}
            onChange={(value) => onModel(role, value)}
            className={SETTING_WIDE_SELECT}
          />
        }
      />
    );
  };
  const signalName = (id: string) =>
    signals.find((s) => s.id === id)?.name ?? id;

  return (
    <>
      {heading(
        <Button
          size="sm"
          variant="soft"
          className="phone:min-h-11"
          disabled={!signals.length}
          onClick={onAddOverride}
        >
          Add an override
        </Button>,
      )}
      <SettingCard>
        <SettingLinkRow
          title="What this project may grant"
          description={`The most any incident agent in ${label} can get`}
          value={grantsSummary(view.grants)}
          stacked
          onClick={onOpenGrants}
        />
        {INCIDENT_AGENT_ROLES.map((role) => (
          <SettingLinkRow
            key={role}
            title={ROLE_LABELS[role]}
            description={roleDescription(role)}
            value={MODE_LABELS[view.profiles[role].mode]}
            onClick={() => onOpenRole(role)}
          />
        ))}
        {INCIDENT_AGENT_ROLES.map(modelRow)}
        {view.overrides.map((o) => (
          <SettingLinkRow
            key={`${o.role}-${o.signalId}`}
            title={`${signalName(o.signalId)} · ${ROLE_LABELS[o.role]}`}
            description={overrideSummary(o)}
            onClick={() => onOpenOverride(o)}
          />
        ))}
      </SettingCard>
      {!view.isDefault && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 px-5">
          <p className="m-0 min-w-0 text-supporting text-faint">
            {`Changed by ${view.updatedBy}`}
          </p>
          <Button
            size="sm"
            variant="danger"
            className="shrink-0 phone:min-h-11"
            onClick={onReset}
          >
            Reset to defaults
          </Button>
        </div>
      )}
    </>
  );
}

/** Pick a signal and a role, then edit that override. */
function AddOverrideDialog({
  open,
  onClose,
  signals,
  onNext,
}: {
  open: boolean;
  onClose: () => void;
  signals: SignalView[];
  onNext: (role: IncidentAgentRole, signalId: string) => void;
}) {
  const [signalId, setSignalId] = useState(signals[0]?.id ?? "");
  const [role, setRole] = useState<IncidentAgentRole>("investigator");
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="Add an override"
      saveLabel="Next"
      canSave={!!signalId}
      onSave={() => {
        onClose();
        onNext(role, signalId);
      }}
    >
      <p className={FIELD_HINT}>
        An override gives one signal's agent different access from its role
      </p>
      <FormField label="Signal">
        <OptionSelect
          label="Signal"
          value={signalId}
          options={signals.map((s) => ({ value: s.id, label: s.name }))}
          onChange={setSignalId}
          className="w-full justify-between phone:min-h-11"
        />
      </FormField>
      <FormField label="Role">
        <Segmented
          className="self-start"
          label="Role"
          value={role}
          onValueChange={(next) =>
            setRole(next === "verifier" ? "verifier" : "investigator")
          }
        >
          {INCIDENT_AGENT_ROLES.map((r) => (
            <SegmentedOption key={r} value={r} className="phone:min-h-11">
              {ROLE_LABELS[r]}
            </SegmentedOption>
          ))}
        </Segmented>
      </FormField>
    </SettingsDialog>
  );
}

function seedFields(
  view: IncidentAccessSettingsView,
  role: IncidentAgentRole,
  signalId: string | null,
): AccessProfileFields {
  if (!signalId) return structuredClone(view.profiles[role]);
  const stored = view.overrides.find(
    (o) => o.role === role && o.signalId === signalId,
  );
  return structuredClone(stored?.fields ?? {});
}

/**
 * One role's profile, or one signal's override of it, with a live preview
 * of what the agent would get. The preview runs on the server against the
 * draft (debounced); a draft it refuses cannot be saved.
 */
function RoleDialog({
  open,
  onClose,
  project,
  role,
  signal,
  view,
  runnerName,
  credentialName,
  modelOptions,
  onSaved,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  role: IncidentAgentRole;
  /** An override's signal; null edits the role's profile. */
  signal: SignalView | null;
  view: IncidentAccessSettingsView;
  runnerName: (id: string) => string;
  credentialName: (id: string) => string;
  modelOptions: Array<{ value: string; label: string }>;
  onSaved: (next: IncidentAccessSettingsView) => void;
  onConflict: () => Promise<IncidentAccessSettingsView | null>;
}) {
  const signalId = signal?.id ?? null;
  const [fields, setFields] = useState(() => seedFields(view, role, signalId));
  // Bumped when fresh values replace the draft, so list fields re-seed.
  const [generation, setGeneration] = useState(0);
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const exists =
    signalId !== null &&
    view.overrides.some((o) => o.role === role && o.signalId === signalId);

  const draftKey = JSON.stringify(fields);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      const body: AccessPreviewInput = {
        project,
        role,
        draft: previewDraft(role, signalId, JSON.parse(draftKey)),
      };
      if (signalId) body.signalId = signalId;
      previewAccessApi(body).then(
        (next) => {
          if (!live) return;
          setPreview(next);
          setPreviewError(null);
        },
        (cause) => {
          if (live)
            setPreviewError(errorMessage(cause, "Couldn't preview access"));
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, project, role, signalId, draftKey]);

  const fail = (cause: unknown, fallback: string) => {
    setBusy(false);
    if (apiStatus(cause) !== 409)
      return setError(errorMessage(cause, fallback));
    void onConflict().then((fresh) => {
      if (!fresh) return;
      setFields(seedFields(fresh, role, signalId));
      setGeneration(generation + 1);
    });
  };

  const save = () => {
    setBusy(true);
    setError(null);
    const pending = signalId
      ? putAccessOverride(project, role, signalId, fields, view.revision)
      : putAccessProfile(project, role, fields, view.revision);
    pending.then(
      (next) => {
        setBusy(false);
        onSaved(next);
        toast("Access saved");
        onClose();
      },
      (cause) => fail(cause, "Couldn't save access"),
    );
  };

  const remove = () => {
    if (!signalId) return;
    confirm({
      title: "Remove this override?",
      description: `${signal?.name ?? signalId}'s ${ROLE_LABELS[role].toLowerCase()} goes back to the role's access`,
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () =>
        deleteAccessOverride(project, role, signalId, view.revision).then(
          (next) => {
            onSaved(next);
            toast("Override removed");
            onClose();
          },
          (cause) => fail(cause, "Couldn't remove the override"),
        ),
    });
  };

  return (
    <>
      <SettingsDialog
        open={open}
        onClose={onClose}
        title={
          signal ? `${signal.name} · ${ROLE_LABELS[role]}` : ROLE_LABELS[role]
        }
        error={error ?? previewError}
        busy={busy}
        canSave={!previewError}
        onSave={save}
        wide
        leading={
          exists ? (
            <Button type="button" variant="danger" onClick={remove}>
              Remove
            </Button>
          ) : null
        }
      >
        <RoleFields
          key={generation}
          role={role}
          partial={signalId !== null}
          fields={fields}
          roleProfile={view.profiles[role]}
          choices={grantedChoices(view.grants)}
          onChange={setFields}
          runnerName={runnerName}
          credentialName={credentialName}
          modelOptions={modelOptions}
        />
        <AccessPreviewWell preview={preview} />
      </SettingsDialog>
      {confirmDialog}
    </>
  );
}

/** What the agent would get with the draft: the summary, its tool count,
 *  and every warning. Holds its height while the first answer arrives. */
function AccessPreviewWell({ preview }: { preview: AccessPreview | null }) {
  return (
    <section className={ACCESS_PREVIEW} aria-live="polite">
      <h3 className="m-0 text-label font-semibold text-fg">
        What the agent gets
      </h3>
      {preview ? (
        <>
          {preview.access && (
            <p className="m-0 text-body text-fg [overflow-wrap:anywhere]">
              {preview.access.summary}
            </p>
          )}
          {preview.error && <p className={FIELD_ERROR}>{preview.error}</p>}
          <p className={FIELD_HINT}>
            {preview.tools.length === 1
              ? "1 tool"
              : `${preview.tools.length} tools`}
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning} className="m-0 text-meta text-yellow">
              {warning}
            </p>
          ))}
        </>
      ) : (
        <>
          <SkeletonBar className="w-[66%]" />
          <SkeletonBar className="h-2.5 w-[35%]" />
        </>
      )}
    </section>
  );
}

/**
 * A role's fields, as data in and edits out, each limited to what the
 * project grants. `partial` edits an override: every field starts as the
 * role's and holds its own value only once "Use the role's setting" is
 * cleared. The verifier's mode is always read-only.
 */
export function RoleFields({
  role,
  partial,
  fields,
  roleProfile,
  choices,
  onChange,
  runnerName,
  credentialName,
  modelOptions,
}: {
  role: IncidentAgentRole;
  partial: boolean;
  fields: AccessProfileFields;
  roleProfile: CompleteAccessProfile;
  choices: GrantedChoices;
  onChange: (fields: AccessProfileFields) => void;
  runnerName: (id: string) => string;
  credentialName: (id: string) => string;
  modelOptions: Array<{ value: string; label: string }>;
}) {
  const inherited = (field: AccessProfileField) =>
    partial && !Object.hasOwn(fields, field);
  const current = effectiveProfile(roleProfile, fields);
  const value = <F extends AccessProfileField>(field: F) => current[field];
  const set = (patch: AccessProfileFields) => onChange({ ...fields, ...patch });

  const modelName = (id: string) =>
    modelOptions.find((o) => o.value === id)?.label ?? id;
  const block = (
    field: AccessProfileField,
    title: string,
    control: () => React.ReactNode,
    hint?: React.ReactNode,
  ) => {
    const inherits = inherited(field);
    return (
      <div className={ACCESS_FIELD}>
        <div className={ACCESS_FIELD_HEAD}>
          <span className="text-label font-medium text-dim">{title}</span>
          {partial && (
            <label className={ACCESS_INHERIT}>
              <Checkbox
                checked={inherits}
                onCheckedChange={(on) =>
                  onChange(inheritField(fields, field, on, roleProfile))
                }
              />
              Use the role's setting
            </label>
          )}
        </div>
        {inherits ? (
          <p className="m-0 text-body text-dim [overflow-wrap:anywhere]">
            {describeField(field, roleProfile, {
              runner: runnerName,
              credential: credentialName,
              repo: repoLabel,
              model: modelName,
            })}
          </p>
        ) : (
          control()
        )}
        {hint && <p className={FIELD_HINT}>{hint}</p>}
      </div>
    );
  };

  const checks = (
    field: "connections" | "repos" | "runners",
    items: string[],
    name: (id: string) => string,
    empty: string,
  ) =>
    block(field, FIELD_LABELS[field], () =>
      items.length ? (
        <div className={CHECK_LIST}>
          {items.map((item) => (
            <label key={item} className={CHECK_ROW}>
              <Checkbox
                checked={value(field).includes(item)}
                onCheckedChange={() =>
                  set({ [field]: toggleIn(value(field), item, (s) => s) })
                }
              />
              <span className="min-w-0 flex-1 truncate">{name(item)}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className={FIELD_HINT}>{empty}</p>
      ),
    );

  const verifier = role === "verifier";
  const egress = value("egress");
  const credentials = value("credentials");

  return (
    <>
      {block(
        "mode",
        "Mode",
        () => (
          <Segmented
            className="self-start"
            label="Mode"
            value={verifier ? "ask" : value("mode")}
            disabled={verifier}
            onValueChange={(mode) =>
              set({ mode: mode === "code" ? "code" : "ask" })
            }
          >
            <SegmentedOption value="ask" className="phone:min-h-11">
              {MODE_LABELS.ask}
            </SegmentedOption>
            <SegmentedOption
              value="code"
              className="phone:min-h-11"
              disabled={choices.maxMode === "ask"}
            >
              {MODE_LABELS.code}
            </SegmentedOption>
          </Segmented>
        ),
        verifier
          ? "The verifier may not edit the candidate"
          : choices.maxMode === "ask"
            ? "The project grants read-only at most"
            : undefined,
      )}
      {checks(
        "connections",
        choices.connections,
        (s) => s,
        "The project grants no connections",
      )}
      {checks(
        "repos",
        choices.repos,
        repoLabel,
        "The project grants no repositories",
      )}
      {checks(
        "runners",
        choices.runners,
        runnerName,
        "The project grants no Runners",
      )}
      {block("hosts", "Hosts", () =>
        choices.hosts.length ? (
          <div className={CHECK_LIST}>
            {choices.hosts.map((host) => (
              <label key={hostGrantKey(host)} className={CHECK_ROW}>
                <Checkbox
                  checked={value("hosts").some(
                    (h) => hostGrantKey(h) === hostGrantKey(host),
                  )}
                  onCheckedChange={() =>
                    set({ hosts: toggleIn(value("hosts"), host, hostGrantKey) })
                  }
                />
                <span className="min-w-0 flex-1 truncate">
                  {host.ssh
                    ? `${runnerName(host.runner)} › ${host.ssh}`
                    : runnerName(host.runner)}
                </span>
                <span className="shrink-0 text-meta text-dim">Read-only</span>
              </label>
            ))}
          </div>
        ) : (
          <p className={FIELD_HINT}>The project grants no hosts</p>
        ),
      )}
      {block("credentials", "Credentials", () =>
        choices.credentials.length ? (
          <div className={CHECK_LIST}>
            {choices.credentials.map(({ credential, maxMode }) => {
              const picked = credentials.find(
                (c) => c.credential === credential,
              );
              const pick = (mode: CredentialGrantMode | null) =>
                set({
                  credentials: [
                    ...credentials.filter((c) => c.credential !== credential),
                    ...(mode ? [{ credential, mode }] : []),
                  ],
                });
              return (
                <div key={credential} className={CREDENTIAL_LINE}>
                  <label className={CHECK_ROW}>
                    <Checkbox
                      checked={!!picked}
                      onCheckedChange={(on) => pick(on ? "once" : null)}
                    />
                    <span className="min-w-0 truncate">
                      {credentialName(credential)}
                    </span>
                  </label>
                  {picked && (
                    <Segmented
                      label={`How ${credentialName(credential)} is lent`}
                      value={picked.mode}
                      size="sm"
                      onValueChange={(mode) =>
                        pick(mode === "standing" ? "standing" : "once")
                      }
                    >
                      <SegmentedOption value="once" className="phone:min-h-11">
                        {GRANT_MODE_LABELS.once}
                      </SegmentedOption>
                      <SegmentedOption
                        value="standing"
                        className="phone:min-h-11"
                        disabled={maxMode === "once"}
                      >
                        {GRANT_MODE_LABELS.standing}
                      </SegmentedOption>
                    </Segmented>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className={FIELD_HINT}>The project lends no credentials</p>
        ),
      )}
      {block(
        "deniedTools",
        "Blocked tools",
        () => (
          <ListInput
            label="Blocked tools"
            value={value("deniedTools")}
            placeholder="bash, write"
            onChange={(deniedTools) => set({ deniedTools })}
          />
        ),
        "Tool names, comma separated. Blocking narrows; it never adds",
      )}
      {block("egress", "Network route", () => (
        <OptionSelect
          label="Network route"
          value={egress ? egressRouteKey(egress) : NO_ROUTE}
          options={[
            { value: NO_ROUTE, label: "None" },
            ...choices.egress.map((route) => ({
              value: egressRouteKey(route),
              label: egressLabel(route, runnerName),
            })),
          ]}
          onChange={(key) =>
            set({
              egress:
                choices.egress.find((r) => egressRouteKey(r) === key) ?? null,
            })
          }
          className="w-full justify-between phone:min-h-11"
        />
      ))}
      {partial &&
        block("model", "Model", () => {
          const model = value("model");
          const options = [...modelOptions];
          if (model && !options.some((o) => o.value === model))
            options.push({ value: model, label: model });
          return (
            <OptionSelect
              label="Model"
              value={model ?? AUTOMATIC}
              options={options}
              onChange={(next) =>
                set({ model: next === AUTOMATIC ? null : next })
              }
              className="w-full justify-between phone:min-h-11"
            />
          );
        })}
    </>
  );
}
