import type { ProjectListItem } from "../../../shared/project-settings";
import { projectStatusPhrase } from "../../lib/project-settings/defaults-model";
import {
  PROJECT_SECTIONS,
  type ProjectSectionId,
} from "../../lib/project-settings/page-model";
import {
  SETTINGS_NAV_ICON,
  SETTINGS_NAV_ROW,
} from "../../lib/settings-classes";
import {
  matchProjectSections,
  matchProjects,
} from "../../lib/settings-search";
import { cn } from "../../ui/cn";
import { IconChevronRight } from "../icons";
import { RepoTile } from "../RepoTile";

// The projects in the Settings nav, under Defaults in the Projects group:
// each with its one status phrase (lib/project-settings/defaults-model), and
// the open one with its page's sections under it. The list comes from
// /api/projects, so these are not rows of the SECTIONS table.

export type ActiveProject = { project: string; section?: ProjectSectionId };

/** The phrase on the right of a project row. */
function StatusPhrase({ item }: { item: ProjectListItem }) {
  return (
    <span className="shrink-0 text-meta font-normal tabular-nums text-faint">
      {projectStatusPhrase(item)}
    </span>
  );
}

/** Desktop nav rows: one per project, and the open project's sections. */
export function ProjectNavRows({
  projects,
  active,
  query,
  onOpen,
}: {
  projects: ProjectListItem[];
  active: ActiveProject | null;
  query: string;
  onOpen(project: string, section?: ProjectSectionId): void;
}) {
  const shown = matchProjects(projects, query);
  const sectionHits = matchProjectSections(projects, query);
  return (
    <>
      {shown.map((item) => {
        const open = active?.project === item.id;
        return (
          <div key={item.id}>
            <button
              type="button"
              className={SETTINGS_NAV_ROW}
              data-active={(open && !active?.section) || undefined}
              aria-current={open && !active?.section ? "page" : undefined}
              onClick={() => onOpen(item.id)}
            >
              <span className={SETTINGS_NAV_ICON}>
                <RepoTile name={item.id} size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <StatusPhrase item={item} />
            </button>
            {open && !query && (
              <div className="flex flex-col">
                {PROJECT_SECTIONS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={cn(SETTINGS_NAV_ROW, "pl-[38px] phone:min-h-11")}
                    data-active={active?.section === id || undefined}
                    aria-current={
                      active?.section === id ? "location" : undefined
                    }
                    onClick={() => onOpen(item.id, id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {sectionHits.map((hit) => (
        <button
          key={`${hit.project}:${hit.section}`}
          type="button"
          className={SETTINGS_NAV_ROW}
          onClick={() => onOpen(hit.project, hit.section)}
        >
          <span className={SETTINGS_NAV_ICON}>
            <RepoTile name={hit.project} size={16} />
          </span>
          <span className="min-w-0 flex-1">
            {hit.label}
            {hit.hint && (
              <span className="block truncate text-meta font-normal text-faint">
                {hit.hint}
              </span>
            )}
          </span>
        </button>
      ))}
    </>
  );
}

/** The phone sheet's rows, inside the Projects card under Defaults. */
export function ProjectSheetRows({
  projects,
  query,
  onOpen,
  rowClassName,
}: {
  projects: ProjectListItem[];
  query: string;
  onOpen(project: string, section?: ProjectSectionId): void;
  /** The card's own row class, so the separators line up with Defaults. */
  rowClassName?: string;
}) {
  const shown = matchProjects(projects, query);
  const sectionHits = matchProjectSections(projects, query);
  const rows = [
    ...shown.map((item) => ({
      key: item.id,
      project: item.id,
      section: undefined,
      label: item.label,
      hint: undefined as string | undefined,
      value: projectStatusPhrase(item),
    })),
    ...sectionHits.map((hit) => ({
      key: `${hit.project}:${hit.section}`,
      project: hit.project,
      section: hit.section,
      label: hit.label,
      hint: hit.hint,
      value: null,
    })),
  ];
  return (
    <>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          className={cn(
            "relative flex min-h-11 w-full items-center gap-3 border-0 bg-transparent px-3.5 py-3 text-left active:bg-hover",
            rowClassName,
          )}
          onClick={() => onOpen(row.project, row.section)}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center">
            <RepoTile name={row.project} size={22} />
          </span>
          <span className="min-w-0 flex-1 text-item-title font-medium text-fg">
            {row.label}
            {row.hint && (
              <span className="block truncate text-meta font-normal text-faint">
                {row.hint}
              </span>
            )}
          </span>
          {row.value && (
            <span className="shrink-0 text-supporting text-faint tabular-nums">
              {row.value}
            </span>
          )}
          <IconChevronRight size={20} className="shrink-0 text-faint" />
        </button>
      ))}
    </>
  );
}
