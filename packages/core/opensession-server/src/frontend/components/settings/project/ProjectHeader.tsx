import useSWR from "swr";
import { fetchRepos } from "../../../lib/api/repos";
import {
  PROJECT_HEADER,
  PROJECT_HEADER_NAME,
  PROJECT_HEADER_SUB,
} from "../../../lib/project-settings-classes";
import { repoLabel } from "../../../lib/repo-label";
import { RepoTile } from "../../RepoTile";

const TILE = 36;

/** The project's tile, name and where it lives on GitHub. */
export function ProjectHeader({ project }: { project: string }) {
  const repos = useSWR(["api", "repos-for-project-settings"], fetchRepos);
  const repo = repos.data?.find((r) => r.id === project);
  return (
    <header className={PROJECT_HEADER}>
      <RepoTile name={project} size={TILE} />
      <div className="min-w-0">
        <h1 className={PROJECT_HEADER_NAME}>{repoLabel(project)}</h1>
        <p className={PROJECT_HEADER_SUB}>
          {repo?.ghRepo ? `${repo.ghRepo} on GitHub` : "Project settings"}
        </p>
      </div>
    </header>
  );
}
