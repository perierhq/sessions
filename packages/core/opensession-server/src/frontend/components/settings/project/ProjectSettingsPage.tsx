import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import type {
  AccessCellChange,
  ProjectSettingsView,
  ReadinessFix,
} from "../../../../shared/project-settings";
import { useIsPhone } from "../../../hooks/useIsPhone";
import { revalidateSandboxStatus } from "../../../hooks/useSettingsResources";
import {
  projectSWRKey,
  revalidateProjects,
  useProjectDefaults,
  useProjectSettings,
} from "../../../hooks/useProjects";
import { routePath } from "../../../lib/app-route";
import {
  allowAgentsOnConnector,
  ApiError,
  migrateProjects,
  patchProjectSettings,
} from "../../../lib/api/projects";
import { errorMessage } from "../../../lib/error-message";
import {
  PROJECT_PAGE_FRAME,
  PROJECT_SECTION,
  PROJECT_SECTION_HEAD,
  PROJECT_SECTION_TITLE,
} from "../../../lib/project-settings-classes";
import {
  PROJECT_SECTIONS,
  applyCellChange,
  sectionAnchorId,
  type ProjectSectionId,
} from "../../../lib/project-settings/page-model";
import {
  isStaleRevision,
  type ProjectPatchBody,
  STALE_SETTINGS_MESSAGE,
  sendProjectPatch,
} from "../../../lib/project-settings/save";
import { scrollToProjectSection } from "../../../lib/project-settings/scroll";
import { Button } from "../../../ui/button";
import { useConfirm } from "../../../ui/confirm";
import { SettingCardSkeleton, SettingsPanel } from "../../../ui/settings";
import { InlineAlert } from "../../../ui/state";
import { toast } from "../../../ui/toast";
import { IconPlus } from "../../icons";
import { AccessSection } from "./AccessSection";
import { ConnectSandboxForm } from "./ConnectSandboxForm";
import { DriftNotice } from "./DriftNotice";
import { IncidentsSection } from "./IncidentsSection";
import { ModelsSection } from "./ModelsSection";
import { ProductionSection, type ProductionDialog } from "./ProductionSection";
import { ProjectHeader } from "./ProjectHeader";
import { ReadinessChecklist } from "./ReadinessChecklist";
import { SignalExceptions } from "./SignalExceptions";
import { WhereAgentsRunSection } from "./WhereAgentsRunSection";

type Optimistic = (view: ProjectSettingsView) => ProjectSettingsView;

const TITLES = new Map<ProjectSectionId, string>(PROJECT_SECTIONS);

/**
 * One project's settings: the readiness checklist, where its agents run,
 * their models, production, what they may use, and its incident policy.
 * Every control saves at once against the revision the page loaded. A stale
 * revision refetches; a small change is sent once more, a whole list or
 * object is refused so the person sees the other tab's edit first.
 */
export function ProjectSettingsPage({
  project,
  section,
  onOpenSection,
  onOpenSettings,
}: {
  project: string;
  section?: ProjectSectionId;
  onOpenSection: (id: ProjectSectionId) => void;
  /** Open another Settings page (a fix that lives elsewhere). */
  onOpenSettings?: (section: "providers" | "sandboxes") => void;
}) {
  const settings = useProjectSettings(project);
  const defaults = useProjectDefaults();
  const phone = useIsPhone();
  const [production, setProduction] = useState<ProductionDialog | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [addSignal, setAddSignal] = useState<number | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  // Saves run one at a time, so each sends the revision the last one left.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const view = settings.data;

  const loaded = view !== undefined;
  useEffect(() => {
    if (section && loaded) scrollToProjectSection(section);
  }, [section, loaded]);

  /** Open a section from a fix: the route, and the scroll for when the
   *  route already names it. */
  const openSection = (id: ProjectSectionId) => {
    onOpenSection(id);
    scrollToProjectSection(id);
  };

  const send = async (body: ProjectPatchBody, optimistic?: Optimistic) => {
    let revision: number | null = null;
    await settings.mutate(
      (current) => {
        if (!current) return current;
        revision = current.document.revision;
        return optimistic ? optimistic(current) : current;
      },
      { revalidate: false },
    );
    if (revision === null) throw new Error("Settings haven't loaded yet");
    try {
      const next = await sendProjectPatch(body, revision, {
        send: (patch) => patchProjectSettings(project, patch),
        refetch: () => settings.mutate(),
        onRetry: async (fresh) => {
          toast(STALE_SETTINGS_MESSAGE);
          if (optimistic)
            await settings.mutate(optimistic(fresh), { revalidate: false });
        },
      });
      await settings.mutate(next, { revalidate: false });
      revalidateProjects(projectSWRKey.projectSettings(project));
    } catch (error) {
      // A stale revision has already been refetched.
      if (!isStaleRevision(error)) void settings.mutate();
      throw error;
    }
  };

  /** Save, rejecting with the server's reason (dialogs show it). */
  const save = (body: ProjectPatchBody, optimistic?: Optimistic) => {
    const run = queue.current.then(() => send(body, optimistic));
    queue.current = run.catch(() => {});
    return run;
  };

  /** Save from a one-tap control: a refusal is a toast. */
  const saveNow = (body: ProjectPatchBody, optimistic?: Optimistic) => {
    save(body, optimistic).catch((error) =>
      toast(saveErrorText(error), { variant: "error" }),
    );
  };

  const changeCell = (change: AccessCellChange) =>
    saveNow({ access: { cells: [change] } }, (v) => applyCellChange(v, change));

  const allowAgents = (server: string) =>
    confirm({
      title: `Allow agents to open ${server}?`,
      description: `${server} is limited to named people. Runs that carry no person, like automations, reviews and incident agents, can then use it in every project that ticks it`,
      confirmLabel: "Allow agents",
      onConfirm: () =>
        allowAgentsOnConnector(server).then(
          () => {
            toast(`Agents can open ${server}`);
            revalidateProjects();
          },
          (error) => toast(saveErrorText(error), { variant: "error" }),
        ),
    });

  const openSettings = (target: "providers" | "sandboxes") => {
    if (onOpenSettings) onOpenSettings(target);
    else
      window.location.assign(routePath({ view: "settings", section: target }));
  };

  const fix = (next: ReadinessFix) => {
    switch (next.kind) {
      case "providers":
        return openSettings("providers");
      case "connect-sandbox":
        return openSettings("sandboxes");
      case "pair-runner":
        openSection("production");
        return setProduction({ kind: "pair", key: Date.now() });
      case "add-action":
        openSection("production");
        return setProduction({
          kind: "action",
          key: Date.now(),
          action: null,
          nextKind: next.action,
        });
      case "add-signal":
        openSection("incidents");
        return setAddSignal(Date.now());
      case "allow-agents":
        return allowAgents(next.server);
      case "unpause":
        return saveNow({ incidents: { agentsPaused: false } });
    }
  };

  let body: React.ReactNode;
  if (settings.error && !view)
    body = (
      <InlineAlert onRetry={() => void settings.mutate()}>
        {settings.error instanceof ApiError && settings.error.status === 404
          ? `There is no project called ${project}`
          : errorMessage(settings.error, "Couldn't load the settings")}
      </InlineAlert>
    );
  else if (!view)
    body = (
      <>
        <SettingCardSkeleton rows={3} />
        <SettingCardSkeleton rows={3} className="mt-10" />
        <SettingCardSkeleton rows={5} className="mt-10" />
      </>
    );
  else
    body = (
      <>
        {view.drift && (
          <DriftNotice
            onMigrate={() =>
              migrateProjects({ dryRun: false }).then(
                () => revalidateProjects(),
                (error) => {
                  toast(saveErrorText(error), { variant: "error" });
                },
              )
            }
          />
        )}
        <ReadinessChecklist
          project={project}
          readiness={view.readiness}
          onFix={fix}
          connectForm={
            <ConnectSandboxForm
              hasGlobalDefault={
                defaults.data ? defaults.data.sandbox !== "none" : true
              }
              onConnected={() => {
                revalidateSandboxStatus();
                revalidateProjects();
              }}
            />
          }
        />
        <Section id="where">
          <WhereAgentsRunSection
            view={view}
            defaults={defaults.data}
            onSave={saveNow}
          />
        </Section>
        <Section id="models">
          <ModelsSection project={project} view={view} onSave={saveNow} />
        </Section>
        <Section
          id="production"
          action={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<IconPlus size={16} />}
              className="min-h-11"
              onClick={() => setProduction({ kind: "pair", key: Date.now() })}
            >
              {phone ? "Runner" : "Pair a Runner"}
            </Button>
          }
        >
          <ProductionSection
            project={project}
            view={view}
            dialog={production}
            onDialog={setProduction}
            onSave={(b) => save(b)}
            onView={(next) => {
              void settings.mutate(next, { revalidate: false });
              revalidateProjects(projectSWRKey.projectSettings(project));
            }}
            onRevalidate={() => revalidateProjects()}
          />
        </Section>
        <Section
          id="access"
          action={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<IconPlus size={16} />}
              className="min-h-11"
              onClick={() => setAdding(Date.now())}
            >
              Add
            </Button>
          }
        >
          <AccessSection
            view={view}
            adding={adding}
            onAddingChange={setAdding}
            onCellChange={changeCell}
            onAllowAgents={allowAgents}
            onSave={(b) => save(b)}
          />
          <SignalExceptions
            exceptions={view.access.signalExceptions}
            onSave={(b) => save(b)}
          />
        </Section>
        <Section id="incidents">
          <IncidentsSection
            project={project}
            view={view}
            addSignal={addSignal}
            onAddSignalClose={() => setAddSignal(null)}
            onSave={(b) => save(b)}
          />
        </Section>
      </>
    );

  return (
    <div className={PROJECT_PAGE_FRAME}>
      <SettingsPanel className="self-start">
        <ProjectHeader project={project} />
        {body}
      </SettingsPanel>
      {confirmDialog}
    </div>
  );
}

function saveErrorText<Rejected>(error: Rejected): string {
  if (error instanceof ApiError && error.status === 403)
    return "Only a signed-in person can change this";
  return errorMessage(error, "Couldn't save the setting");
}

function Section({
  id,
  action,
  children,
}: {
  id: ProjectSectionId;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const titleId = `${sectionAnchorId(id)}-title`;
  return (
    <section
      id={sectionAnchorId(id)}
      aria-labelledby={titleId}
      className={PROJECT_SECTION}
    >
      <div className={PROJECT_SECTION_HEAD}>
        <h2 id={titleId} className={PROJECT_SECTION_TITLE}>
          {TITLES.get(id)}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
