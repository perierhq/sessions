import { useRepoList } from "../../../hooks/useSettingsResources";
import {
  PROJECT_HEADER,
  PROJECT_HEADER_NAME,
  PROJECT_HEADER_SUB,
} from "../../../lib/project-settings-classes";
import { repoLabel } from "../../../lib/repo-label";
import { RepoTile } from "../../RepoTile";

const TILE = 36;

/** The project's tile, name and where it lives on GitHub. The plan's
 *  "N people use it" is left out: nothing counts a project's people
 *  without a new server query. */
export function ProjectHeader({ project }: { project: string }) {
  const repos = useRepoList();
  const repo = repos.data?.find((r) => r.id === project);
  return (
    <header className={PROJECT_HEADER}>
      <RepoTile name={project} size={TILE} />
      <div className="min-w-0">
        <h1 className={PROJECT_HEADER_NAME}>{repoLabel(project)}</h1>
        <p className={PROJECT_HEADER_SUB}>
          {/* Kept blank, at its height, while the repos load, so the line
              doesn't swap from one text to another. */}
          {!repos.data
            ? "\u00a0"
            : repo?.ghRepo
              ? `${repo.ghRepo} on GitHub`
              : "Project settings"}
        </p>
      </div>
    </header>
  );
}
