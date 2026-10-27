import { useNavigation } from "../hooks/useNavigation";
import { useProjectSettings } from "../hooks/useProjects";
import { useRepoList } from "../hooks/useSettingsResources";
import type { RepoInfo } from "../lib/api/repos";
import type { Automation } from "../lib/api";
import {
  automationPlaceCopy,
  automationProject,
} from "../lib/automation-environment";
import { FIELD_LABEL } from "../lib/automation-form";
import { PlainButton } from "../ui/plain-button";
import { OptionSelect } from "../ui/select";
import { RepoTile, repoLabel } from "./RepoTile";

/**
 * Where an automation runs, in one line: its project's place for
 * automations, or the disposable sandbox it kept from before projects had
 * their own. `link` adds the way to change it.
 */
export function AutomationPlace({
  automation,
  link = false,
}: {
  automation: Pick<Automation, "sandbox" | "repo">;
  link?: boolean;
}) {
  const navigation = useNavigation();
  const repos = useRepoList();
  const repo = automationProject(automation, repos.data);
  const place = useProjectSettings(repo).data?.effective.sandbox.automations;
  const copy = automationPlaceCopy(automation, place, repo);
  if (!link || automation.sandbox || !repo) return <>{copy}</>;
  return (
    <>
      {copy}{" "}
      <PlainButton
        className="relative cursor-pointer border-0 bg-transparent p-0 text-supporting text-link no-underline before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[''] hover:underline"
        onClick={() => navigation.openProjectSettings(repo, "where")}
      >
        Change
      </PlainButton>
    </>
  );
}

/**
 * The automation's project, and under it where that project runs it. Agents,
 * models and access are set per project, so this is the first thing that
 * decides what a run can do. With one project there is nothing to pick, and
 * the field names it instead.
 */
export function AutomationProjectField({
  value,
  repos,
  sandbox,
  onChange,
}: {
  value: string | null;
  repos: RepoInfo[] | undefined;
  /** A kept disposable sandbox: its place line says so, as it did before. */
  sandbox: boolean;
  onChange: (project: string) => void;
}) {
  const options = (repos ?? []).map((repo) => ({
    value: repo.id,
    label: repo.label || repoLabel(repo.id),
    icon: <RepoTile name={repo.id} size={16} />,
  }));
  // A repo that is no longer registered still reads as itself rather than as
  // an empty trigger. Saving leaves it alone unless another one is picked.
  if (value && !options.some((option) => option.value === value))
    options.push({
      value,
      label: repoLabel(value),
      icon: <RepoTile name={value} size={16} />,
    });
  const picker = (repos?.length ?? 0) > 1;
  const name = value
    ? (options.find((option) => option.value === value)?.label ??
      repoLabel(value))
    : "Default project";
  return (
    <div className={FIELD_LABEL}>
      <span>Project</span>
      {picker && value ? (
        <OptionSelect
          label="Project"
          value={value}
          options={options}
          onChange={onChange}
          className="phone:min-h-11"
        />
      ) : (
        // The same height as the picker, so the line below stays put when
        // the project list lands with a second project in it.
        <span className="flex min-h-8 items-center gap-2 text-sm font-normal text-fg phone:min-h-11">
          {value && <RepoTile name={value} size={16} />}
          {name}
        </span>
      )}
      <span className="mt-1 text-supporting font-normal leading-snug text-dim">
        <AutomationPlace
          automation={{ sandbox, repo: value ?? undefined }}
          link
        />
      </span>
    </div>
  );
}
