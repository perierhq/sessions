import type * as React from "react";
import useSWR, { mutate as mutateKey } from "swr";
import type { RedactedProjectSettings } from "../../../../shared/incident-response";
import type { SignalView } from "../../../../shared/incidents";
import {
  useProjectSettings,
  useProjectSettingsList,
  useSignals,
} from "../../../hooks/useIncidents";
import { apiSWRKey } from "../../../lib/api-swr";
import {
  type ProjectSettingsInput,
  type ProjectSettingsView,
  updateProjectSettingsApi,
} from "../../../lib/api/incidents";
import { fetchRepos } from "../../../lib/api/repos";
import { errorMessage } from "../../../lib/error-message";
import {
  patchSettings,
  projectSummary,
} from "../../../lib/incidents/policy-copy";
import { repoLabel } from "../../../lib/repo-label";
import { OptionSelect } from "../../../ui/select";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
} from "../../../ui/settings";
import { EmptyState, InlineAlert } from "../../../ui/state";
import { RepoTile } from "../../RepoTile";
import { PolicySection } from "./PolicySection";
import { SettingLinkRow } from "./SettingLinkRow";

const REPO_TILE = 28;

/** The groups a project's page places after its policy, each owned by its
 *  own section. */
export interface IncidentSettingsSections {
  signals?: React.ReactNode;
  actions?: React.ReactNode;
  access?: React.ReactNode;
}

/**
 * Settings → Incidents. Without a project, every repository with a line on
 * its signals and policy; with one, that project's policy, signals, actions
 * and access.
 */
export function IncidentSettings({
  project,
  onOpenProject,
}: {
  project?: string;
  onOpenProject: (id: string) => void;
}) {
  const repos = useSWR(["api", "repos-for-incident-settings"], fetchRepos);
  const signals = useSignals();
  const ids = (repos.data ?? []).map((repo) => repo.id);
  if (project && !ids.includes(project)) ids.unshift(project);
  if (!project)
    return (
      <IncidentProjectsIndex
        projects={repos.data ? ids : null}
        error={repos.error ? errorMessage(repos.error, "") : null}
        onRetry={() => void repos.mutate()}
        signals={signals.data ?? []}
        onOpen={onOpenProject}
      />
    );
  return (
    <IncidentProjectSettings
      key={project}
      project={project}
      projects={ids}
      onOpenProject={onOpenProject}
    />
  );
}

function IncidentProjectsIndex({
  projects,
  error,
  onRetry,
  signals,
  onOpen,
}: {
  projects: string[] | null;
  error: string | null;
  onRetry: () => void;
  signals: SignalView[];
  onOpen: (id: string) => void;
}) {
  const list = useProjectSettingsList();
  const byProject = new Map<string, RedactedProjectSettings>(
    (list.data ?? []).map((settings) => [settings.project, settings]),
  );
  let body: React.ReactNode;
  if (error)
    body = (
      <InlineAlert onRetry={onRetry}>
        {error || "Couldn't load the projects"}
      </InlineAlert>
    );
  else if (!projects) body = <SettingCardSkeleton rows={3} icon={REPO_TILE} />;
  else if (!projects.length)
    body = (
      <SettingCard>
        <EmptyState placement="row">
          No projects yet. Add a repository to watch it in production
        </EmptyState>
      </SettingCard>
    );
  else
    body = (
      <SettingCard>
        {projects.map((id) => (
          <SettingLinkRow
            key={id}
            leading={<RepoTile name={id} size={REPO_TILE} />}
            title={repoLabel(id)}
            description={projectSummary(
              byProject.get(id) ?? null,
              signals.filter((signal) => signal.project === id).length,
            )}
            onClick={() => onOpen(id)}
          />
        ))}
      </SettingCard>
    );
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Incidents"
        description="What agents may do when something breaks, per project"
      />
      {body}
    </SettingsPanel>
  );
}

function IncidentProjectSettings({
  project,
  projects,
  onOpenProject,
}: {
  project: string;
  projects: string[];
  onOpenProject: (id: string) => void;
}) {
  const settings = useProjectSettings(project);
  const save = async (input: ProjectSettingsInput) => {
    await settings.mutate(
      async (current) => {
        const saved = await updateProjectSettingsApi(project, input);
        return current ? { ...current, settings: saved } : current;
      },
      {
        optimisticData: (current) =>
          current
            ? {
                ...current,
                settings: patchSettings(current.settings, input),
              }
            : (current ?? null),
        rollbackOnError: true,
        revalidate: true,
      },
    );
    void mutateKey(apiSWRKey.incidentProjects());
  };
  return (
    <IncidentSettingsView
      project={project}
      label={repoLabel(project)}
      view={settings.data}
      error={settings.error ? errorMessage(settings.error, "") : null}
      onRetry={() => void settings.mutate()}
      onSave={save}
      picker={
        projects.length > 1 && (
          <OptionSelect
            label="Project"
            value={project}
            options={projects.map((id) => ({
              value: id,
              label: repoLabel(id),
            }))}
            onChange={onOpenProject}
          />
        )
      }
      sections={{}}
    />
  );
}

/**
 * A project's incident settings, as data in and elements out. `view` is
 * undefined while loading and null when the server has no fix loop, which
 * leaves the signals working and everything else as one notice.
 */
export function IncidentSettingsView({
  project,
  label,
  view,
  error = null,
  onRetry,
  onSave,
  picker,
  sections,
}: {
  project: string;
  label: string;
  view: ProjectSettingsView | null | undefined;
  error?: string | null;
  onRetry?: () => void;
  onSave: (input: ProjectSettingsInput) => Promise<void>;
  picker?: React.ReactNode;
  sections: IncidentSettingsSections;
}) {
  let policy: React.ReactNode;
  if (error)
    policy = (
      <InlineAlert className="mt-2" onRetry={onRetry}>
        {error || "Couldn't load the settings"}
      </InlineAlert>
    );
  else if (view === undefined)
    policy = (
      <>
        <SettingCardSkeleton rows={1} className="mt-2" />
        <SettingsGroupLabel>Autonomy</SettingsGroupLabel>
        <SettingCardSkeleton rows={6} />
        <SettingsGroupLabel>Budget</SettingsGroupLabel>
        <SettingCardSkeleton rows={2} />
      </>
    );
  else if (view === null)
    policy = (
      <InlineAlert variant="info" className="mt-2">
        Autonomy, budget and actions need the incident fix loop on this server.
        Signals work now
      </InlineAlert>
    );
  else
    policy = (
      <PolicySection
        project={project}
        settings={view.settings}
        spend={view.spend}
        onSave={onSave}
      />
    );
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Incidents"
        description={`${label} · what the agents may do when something breaks`}
        actions={picker}
      />
      {policy}
      {sections.signals}
      {view ? sections.actions : null}
      {sections.access}
    </SettingsPanel>
  );
}
