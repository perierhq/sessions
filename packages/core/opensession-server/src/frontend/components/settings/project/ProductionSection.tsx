import type * as React from "react";
import type {
  ActionKind,
  IncidentAction,
} from "../../../../shared/incident-response";
import type { ProjectSettingsView } from "../../../../shared/project-settings";
import type { ProductionRunnerView } from "../../../lib/api/incidents";
import { useIsPhone } from "../../../hooks/useIsPhone";
import { hookUrl } from "../../../lib/incidents/signal-form";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import {
  OFFLINE_DOT,
  ONLINE_DOT,
  PRODUCTION_COMMAND,
  PRODUCTION_DESC,
  PRODUCTION_ROW,
  PRODUCTION_ROW_BUTTON,
  PRODUCTION_TEXT,
  PRODUCTION_TILE,
  PRODUCTION_TITLE,
  PRODUCTION_VALUE,
} from "../../../lib/project-settings-classes";
import {
  middleTruncate,
  timeoutCopy,
} from "../../../lib/project-settings/page-model";
import { Button } from "../../../ui/button";
import { useCopy } from "../../../ui/copy";
import { SettingCard } from "../../../ui/settings";
import {
  IconBell,
  IconChevronRight,
  IconCopy,
  IconRocket,
  IconServer,
  IconUndo,
  IconWrench,
} from "../../icons";
import { ActionDialog } from "../incidents/ActionsSection";
import { PairRunnerDialog } from "./PairRunnerDialog";

/** Which production dialog is open; `key` starts each from stored values. */
export type ProductionDialog =
  | { kind: "pair"; key: number }
  | {
      kind: "action";
      key: number;
      action: IncidentAction | null;
      nextKind: ActionKind;
    };

const PLATFORM = new Map([
  ["linux", "Linux"],
  ["darwin", "macOS"],
  ["win32", "Windows"],
]);

/** A phone row has room for about this much of a command. */
const PHONE_COMMAND_CHARS = 24;

/**
 * The project's production: the Runners its actions and checks run on,
 * its deploy and rollback, and the URL its pipeline calls on each release.
 */
export function ProductionSection({
  project,
  view,
  dialog,
  onDialog,
  onSave,
  onView,
  onRevalidate,
}: {
  project: string;
  view: ProjectSettingsView;
  dialog: ProductionDialog | null;
  onDialog: (dialog: ProductionDialog | null) => void;
  onSave: (body: ProjectPatchBody) => Promise<void>;
  onView: (view: ProjectSettingsView) => void;
  onRevalidate: () => void;
}) {
  const phone = useIsPhone();
  const { production } = view.document;
  const bound = view.runners.filter((r) => production.runners.includes(r.id));
  const deploy = production.actions.find((a) => a.kind === "deploy");
  const rollback = production.actions.find((a) => a.kind === "rollback");
  const others = production.actions.filter(
    (a) => a.kind !== "deploy" && a.kind !== "rollback",
  );
  const openPair = () => onDialog({ kind: "pair", key: Date.now() });
  const openAction = (action: IncidentAction | null, nextKind: ActionKind) =>
    onDialog({ kind: "action", key: Date.now(), action, nextKind });
  const dialogRunners: ProductionRunnerView[] = bound.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    online: r.online,
    bound: true,
    problem: null,
  }));

  const command = (action: IncidentAction) => {
    const full = action.command.split("\n")[0] ?? "";
    return (
      <span className={PRODUCTION_COMMAND}>
        <code className="min-w-0 truncate">
          {phone ? middleTruncate(full, PHONE_COMMAND_CHARS) : full}
        </code>
        <span className="shrink-0 font-sans phone:hidden">
          {`· ${timeoutCopy(action.timeoutMs)}`}
        </span>
      </span>
    );
  };

  const actionRow = (
    action: IncidentAction,
    icon: React.ReactNode,
  ): React.ReactNode => (
    <button
      key={action.id}
      type="button"
      className={PRODUCTION_ROW_BUTTON}
      onClick={() => openAction(action, action.kind)}
    >
      <span className={PRODUCTION_TILE} aria-hidden>
        {icon}
      </span>
      <span className={PRODUCTION_TEXT}>
        <span className={PRODUCTION_TITLE}>{action.label}</span>
        {command(action)}
      </span>
      <span className={PRODUCTION_VALUE}>
        Edit
        <IconChevronRight size={18} dense className="text-faint" />
      </span>
    </button>
  );

  return (
    <>
      <SettingCard>
        {bound.length ? (
          bound.map((runner) => (
            <button
              key={runner.id}
              type="button"
              className={PRODUCTION_ROW_BUTTON}
              onClick={() => openPair()}
            >
              <span className={PRODUCTION_TILE} aria-hidden>
                <IconServer size={18} dense />
              </span>
              <span className={PRODUCTION_TEXT}>
                <span className={PRODUCTION_TITLE}>{runner.name}</span>
                <span className={PRODUCTION_DESC}>
                  {`${PLATFORM.get(runner.platform) ?? runner.platform} · reserved for ${project} · checks and actions run here`}
                </span>
              </span>
              <span className={PRODUCTION_VALUE}>
                <span className={runner.online ? ONLINE_DOT : OFFLINE_DOT} />
                {runner.online ? "Online" : "Offline"}
                <IconChevronRight size={18} dense className="text-faint" />
              </span>
            </button>
          ))
        ) : (
          <div className={PRODUCTION_ROW}>
            <span className={PRODUCTION_TILE} aria-hidden>
              <IconServer size={18} dense />
            </span>
            <span className={PRODUCTION_TEXT}>
              <span className={PRODUCTION_TITLE}>No Runner yet</span>
              <span className={PRODUCTION_DESC}>
                Pair one on the production host. Checks and actions run there
              </span>
            </span>
          </div>
        )}
        {deploy ? (
          actionRow(deploy, <IconRocket size={18} dense />)
        ) : (
          <MissingAction
            icon={<IconRocket size={18} dense />}
            title="Deploy"
            desc="Not set up. Agents can only propose a fix until there is one"
            label="Add deploy"
            onAdd={() => openAction(null, "deploy")}
          />
        )}
        {rollback ? (
          actionRow(rollback, <IconUndo size={18} dense />)
        ) : (
          <MissingAction
            icon={<IconUndo size={18} dense />}
            title="Rollback"
            desc="Not set up. A fix that fails after deploy can't be undone"
            label="Add rollback"
            onAdd={() => openAction(null, "rollback")}
          />
        )}
        {others.map((action) =>
          actionRow(action, <IconWrench size={18} dense />),
        )}
        {view.document.releaseHookPath && (
          <ReleaseRow url={hookUrl(view.document.releaseHookPath)} />
        )}
      </SettingCard>

      {dialog?.kind === "pair" && (
        <PairRunnerDialog
          key={dialog.key}
          open
          onClose={() => onDialog(null)}
          project={project}
          view={view}
          onSave={onSave}
          onView={onView}
          onRevalidate={onRevalidate}
        />
      )}
      {dialog?.kind === "action" && (
        <ActionDialog
          key={dialog.key}
          open
          onClose={() => onDialog(null)}
          action={dialog.action}
          actions={production.actions}
          runners={dialogRunners}
          nextKind={dialog.nextKind}
          onSave={(input) =>
            onSave({ production: { actions: input.actions ?? [] } })
          }
          onOpenHosts={() => openPair()}
        />
      )}
    </>
  );
}

function MissingAction({
  icon,
  title,
  desc,
  label,
  onAdd,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  label: string;
  onAdd: () => void;
}) {
  return (
    <div className={PRODUCTION_ROW}>
      <span className={PRODUCTION_TILE} aria-hidden>
        {icon}
      </span>
      <span className={PRODUCTION_TEXT}>
        <span className={PRODUCTION_TITLE}>{title}</span>
        <span className={PRODUCTION_DESC}>{desc}</span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="soft"
        className="shrink-0 phone:min-h-11"
        onClick={onAdd}
      >
        {label}
      </Button>
    </div>
  );
}

function ReleaseRow({ url }: { url: string }) {
  const { copy } = useCopy();
  return (
    <div className={PRODUCTION_ROW}>
      <span className={PRODUCTION_TILE} aria-hidden>
        <IconBell size={18} dense />
      </span>
      <span className={PRODUCTION_TEXT}>
        <span className={PRODUCTION_TITLE}>Release notices</span>
        <span className={PRODUCTION_DESC}>
          Your pipeline tells Sessions about each release, so the last release
          is checked first
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="soft"
        icon={<IconCopy size={15} />}
        className="shrink-0 phone:min-h-11"
        onClick={() => copy(url, { toast: "Copied" })}
      >
        Copy URL
      </Button>
    </div>
  );
}
