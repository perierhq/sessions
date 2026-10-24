import React, { useEffect, useState } from "react";
import type { ProjectListItem } from "../../shared/project-settings";
import { useIsPhone } from "../hooks/useIsPhone";
import { useProjects } from "../hooks/useProjects";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { cn } from "../ui/cn";
import {
  SETTINGS_BACK,
  SETTINGS_CONTENT,
  SETTINGS_CONTENT_SHEET,
  SETTINGS_CONTENT_TOOL,
  SETTINGS_DRAG_HANDLE,
  SETTINGS_PAGE,
  SETTINGS_PANEL_FRAME,
  SETTINGS_PANEL_FRAME_GALLERY,
  SETTINGS_PANEL_FRAME_SHEET,
  SETTINGS_SHEET_LIST,
  SETTINGS_SHEET_SEARCH_BAR,
  SETTINGS_NAV,
  SETTINGS_NAV_CAPTION,
  SETTINGS_NAV_GROUP,
  SETTINGS_NAV_ICON,
  SETTINGS_NAV_LIST,
  SETTINGS_NAV_ROW,
  SETTINGS_NAV_SEARCH,
} from "../lib/settings-classes";
import type { ProjectSectionId } from "../lib/project-settings/page-model";
import {
  firstProjectHit,
  matchProjectSections,
  matchProjects,
  matchSections,
  type SectionHit,
} from "../lib/settings-search";
import {
  SECTIONS,
  TOOL_SECTIONS,
  type SettingsSectionKey,
  type ToolSectionKey,
} from "../lib/settings-sections";
import { Input } from "../ui/input";
import { PhonePage, SheetIconButton } from "../ui/sheet";
import { PhoneTopBar, PhoneTopBarTitle } from "../ui/top-bar";
import { Connections } from "./Connections";
import { IconChevronLeft, IconChevronRight, IconSearch, IconX } from "./icons";
import { MyAccountsPanel } from "./MyAccounts";
import { AuditPanel } from "./settings/AuditPanel";
import { AuthenticationPanel } from "./settings/AuthenticationPanel";
import { DefaultsPanel } from "./settings/DefaultsPanel";
import { DeploysPanel } from "./settings/DeploysPanel";
import { DownloadsPanel } from "./settings/DownloadsPanel";
import { GeneralPanel } from "./settings/GeneralPanel";
import { IntegrationsPanel } from "./settings/IntegrationsPanel";
import { IngressPanel } from "./settings/IngressPanel";
import { LibraryPanel } from "./settings/LibraryPanel";
import { MembersPanel } from "./settings/MembersPanel";
import { MemoryPanel } from "./settings/MemoryPanel";
import { ProvidersPanel } from "./settings/ProvidersPanel";
import { NotificationsPanel } from "./settings/NotificationsPanel";
import { PapercutsPanel } from "./settings/PapercutsPanel";
import { PreferencesPanel } from "./settings/PreferencesPanel";
import { ShortcutsPanel } from "./settings/ShortcutsPanel";
import { PrewarmingPanel } from "./settings/PrewarmingPanel";
import {
  ProjectNavRows,
  ProjectSheetRows,
  type ActiveProject,
} from "./settings/ProjectsNav";
import { ReposPanel } from "./settings/ReposPanel";
import { SandboxesPanel } from "./settings/SandboxesPanel";
import { StoragePanel } from "./settings/StoragePanel";
import { RunnersPanel } from "./settings/RunnersPanel";
import { SettingsAccountCard, SettingsAccountFooter } from "./SettingsAccount";
import { SetupPanel } from "./Setup";

// The full-window Settings surface: a left sub-nav + a scrolling body, reached
// from the "Settings" item in the account menu. Designed to grow — each area is
// just another entry in SECTIONS and a matching panel below. The "Tools" group
// holds the app's tool surfaces (Automations, Goals, …) — those render at their
// own routes (<base>/automations, …) with this surface as chrome, so the
// section is controlled by the router, not local state.
//
// Groups run from what one person owns to what the whole instance does:
// "Personal" is yours alone: who sessions act as, how the app looks and
// behaves for you, and what it notifies you about. "Organization" is shared
// config every session runs under. "Automation" is the standing work the
// instance does on its own:
// those are the tool surfaces, grouped by what they are rather than sold as
// the headline; "Infrastructure" is the machinery prepared ahead of a run; and
// "Activity" is the read-only record agents leave behind.

// The nav table itself lives in lib/settings-sections, because the command
// palette needs the same list and importing this whole component tree to read
// it would be absurd. Re-exported here so existing callers keep their import.
export type { SettingsSectionKey, ToolSectionKey };

/** Sections that are browsed rather than read down, and take the wider
 *  column for it (see SETTINGS_PANEL_FRAME_GALLERY). */
const GALLERY_SECTIONS = new Set<SettingsSectionKey>(["library", "setup"]);

// Settings is a dense mix of headings, row titles, labels, descriptions,
// fields, and tool panels. Body roles share 150% leading; heading and title
// roles stay compact at 110%. The descendant rules deliberately beat local
// one-off leading utilities so every section follows the page-level rhythm.
const SETTINGS_LEADING =
  "leading-normal [&_*]:!leading-normal " +
  "[&_h1]:!leading-[1.1] [&_h2]:!leading-[1.1] [&_h3]:!leading-[1.1] " +
  "[&_h4]:!leading-[1.1] [&_h5]:!leading-[1.1] [&_h6]:!leading-[1.1] " +
  "[&_.font-title]:!leading-[1.1] [&_.text-item-title]:!leading-[1.1] " +
  "[&_.text-dialog-title]:!leading-[1.1] [&_.text-section-title]:!leading-[1.1] " +
  "[&_.text-page-title]:!leading-[1.1] [&_.text-stat]:!leading-[1.1]";

type Section = (typeof SECTIONS)[number];
type SectionGroup = { group: string; items: Section[] };
type FilteredGroup = { group: string; hits: SectionHit<Section>[] };

/** The nav group that also lists every project under its Defaults row. */
const PROJECTS_GROUP = "Projects";

/** Groups with their non-matching rows dropped, and empty groups gone with
 *  them. An empty query filters nothing, so both surfaces render one list.
 *  The Projects group stays while a project or one of its sections
 *  matches, even when Defaults does not. */
function filterGroups(
  groups: SectionGroup[],
  query: string,
  projects: ProjectListItem[],
): FilteredGroup[] {
  const out: FilteredGroup[] = [];
  for (const g of groups) {
    const hits = matchSections(g.items, query);
    if (
      hits.length ||
      (g.group === PROJECTS_GROUP &&
        (matchProjects(projects, query).length > 0 ||
          matchProjectSections(projects, query).length > 0))
    )
      out.push({ group: g.group, hits });
  }
  return out;
}

/**
 * The nav's filter field. Settings spans many sections across five groups,
 * and the group a setting sits in is a judgement call the person hasn't made
 * — so the query also matches per-section keywords ("vim", "cron", "dark
 * mode"), and a row that matched on one says which under its label.
 *
 * Enter opens the first result and Escape clears, so a search can be run and
 * undone without leaving the keyboard.
 */
function NavSearch({
  value,
  onChange,
  onSubmit,
  className,
  sheet,
  ref,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  className?: string;
  /** The desktop nav marks this box when the list scrolls under it. */
  ref?: React.Ref<HTMLDivElement>;
  /** Phone sheet: the field sits in a page of grouped cards rather than in
   *  the desktop sidebar's chrome, so it takes the cards' own fill instead of
   *  an outlined well, and a touch-sized box with a 16px value — anything
   *  smaller and iOS zooms the page when the field takes focus (the command
   *  palette hardcodes 16px for the same reason). */
  sheet?: boolean;
}) {
  // The positioned box wraps the field only, so a caller's className can pad
  // or stick the strip around it without moving the icons off the field.
  return (
    <div className={className} ref={ref}>
      <div className="relative">
        <IconSearch
          size={sheet ? 20 : 18}
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 text-faint",
            sheet ? "left-3.5" : "left-2",
          )}
        />
        <Input
          value={value}
          // type=search for the phone keyboard's Search key; the native
          // cancel button goes, since the field renders its own (bigger,
          // and present at both widths).
          type="search"
          enterKeyHint="search"
          placeholder="Search settings"
          aria-label="Search settings"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          size={sheet ? "lg" : "md"}
          className={cn(
            "[&::-webkit-search-cancel-button]:hidden",
            // `rounded-full`, not the app's squircle corner: a capsule is what
            // iOS puts a search field in, and base.css grants the squircle to
            // every `rounded-*` EXCEPT this one, so it is also the spelling
            // that gets true round ends rather than a superellipse.
            sheet
              ? cn(
                  "h-10 rounded-full border-transparent bg-raised pl-11 text-input-phone",
                  value && "pr-11",
                )
              : cn("pl-8", value && "pr-8"),
          )}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
            else if (e.key === "Escape" && value) {
              // Escape belongs to the field while it has something to clear —
              // unhandled, it would dismiss the whole phone sheet instead.
              e.stopPropagation();
              e.preventDefault();
              onChange("");
            }
          }}
        />
        {value && (
          <button
            type="button"
            aria-label="Clear search"
            className={cn(
              "absolute top-1/2 flex -translate-y-1/2 cursor-pointer items-center justify-center border-none bg-transparent text-faint hover:bg-hover hover:text-fg",
              // Round inside a capsule; the desktop field keeps the app's corner.
              sheet
                ? "right-1.5 size-8 rounded-full"
                : "right-1 size-6 rounded-md",
            )}
            onClick={() => onChange("")}
          >
            <IconX size={sheet ? 18 : 16} />
          </button>
        )}
      </div>
    </div>
  );
}

/** The active section's panel — shared by the desktop split and the phone
 * sheet's detail page. Tool panels come in via children (App owns them). */
function SectionPanel({
  section,
  onOpenOnboarding,
  onSelect,
  onOpenProject,
  children,
}: {
  section: SettingsSectionKey;
  onOpenOnboarding: () => void;
  onSelect: (key: SettingsSectionKey) => void;
  onOpenProject: (project: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <>
      {TOOL_SECTIONS.has(section) && children}
      {section === "projectDefaults" && (
        <DefaultsPanel
          onOpenProject={onOpenProject}
          onOpenSandboxes={() => onSelect("sandboxes")}
        />
      )}
      {section === "notifications" && <NotificationsPanel />}
      {section === "preferences" && <PreferencesPanel />}
      {section === "shortcuts" && <ShortcutsPanel />}
      {section === "general" && <GeneralPanel />}
      {section === "setup" && (
        <SetupPanel onOpenOnboarding={onOpenOnboarding} />
      )}
      {section === "repos" && <ReposPanel />}
      {section === "members" && <MembersPanel />}
      {section === "authentication" && <AuthenticationPanel />}
      {section === "library" && <LibraryPanel />}
      {section === "integrations" && <IntegrationsPanel />}
      {section === "audit" && <AuditPanel />}
      {section === "downloads" && <DownloadsPanel />}
      {section === "providers" && <ProvidersPanel />}
      {section === "sandboxes" && <SandboxesPanel />}
      {section === "runners" && <RunnersPanel />}
      {section === "connections" && <Connections />}
      {section === "myAccounts" && <MyAccountsPanel />}
      {section === "memory" && <MemoryPanel />}
      {section === "ingress" && <IngressPanel />}
      {section === "storage" && <StoragePanel />}
      {section === "prewarming" && <PrewarmingPanel />}
      {section === "papercuts" && <PapercutsPanel />}
      {section === "deploys" && <DeploysPanel />}
    </>
  );
}

export function Settings({
  onBack,
  section,
  project,
  onSelect,
  onOpenProject,
  onShowRoot,
  onOpenOnboarding,
  children,
}: {
  onBack: () => void;
  /** Active section, derived from the route (tools have their own URLs).
   * Undefined = no explicit section: desktop defaults to Account, while the
   * phone sheet stays on its root list of sections. */
  section?: SettingsSectionKey;
  /** The open project's page, when the route is one: its panel comes in
   *  through `children`, like a tool's. */
  project?: ActiveProject;
  /** Navigate to a section — App maps tool keys to their own routes. */
  onSelect: (key: SettingsSectionKey) => void;
  /** Open a project's settings page, at one of its sections. */
  onOpenProject: (project: string, section?: ProjectSectionId) => void;
  /** Phone sheet's back-to-root (navigate to sectionless /settings). */
  onShowRoot?: () => void;
  onOpenOnboarding: () => void;
  /** The active tool's panel (App owns the tool components and their props). */
  children?: React.ReactNode;
}) {
  const isPhone = useIsPhone();
  const projects = useProjects().data ?? [];

  // No page-level Esc handler: Esc belongs to whatever is focused (cancelling
  // an inline edit, closing a menu), not to the settings page itself — losing
  // the whole page to a stray Esc is worse than having no keyboard exit.

  const [query, setQuery] = useState("");
  // The search field is a sibling above the section list, not its parent, so
  // it cannot know on its own when rows have started travelling under it. The
  // app's own chrome rows ask the same question the same way.
  const [searchBar, setSearchBar] = useState<HTMLDivElement | null>(null);
  useScrollEdge(searchBar, "[data-settings-nav-scroll]");

  // Group the nav entries under their group label (order preserved).
  const groups: SectionGroup[] = [];
  for (const s of SECTIONS) {
    let g = groups.find((x) => x.group === s.group);
    if (!g) groups.push((g = { group: s.group, items: [] }));
    g.items.push(s);
  }

  if (isPhone)
    return (
      <MobileSettings
        groups={groups}
        section={section}
        project={project}
        projects={projects}
        onSelect={onSelect}
        onOpenProject={onOpenProject}
        onShowRoot={onShowRoot}
        onBack={onBack}
        onOpenOnboarding={onOpenOnboarding}
      >
        {children}
      </MobileSettings>
    );

  // A bare /settings lands on Account, the first personal section, on desktop.
  // Keep the section out of the URL so phones can stay at the nav root. A
  // project's page is no section at all.
  const active: SettingsSectionKey | null = project
    ? null
    : (section ?? "myAccounts");
  const shown = filterGroups(groups, query, projects);
  const firstHit = shown[0]?.hits[0]?.item;
  const tool = active !== null && TOOL_SECTIONS.has(active);

  return (
    <div className={cn(SETTINGS_PAGE, SETTINGS_LEADING)}>
      {!tool && <div aria-hidden="true" className={SETTINGS_DRAG_HANDLE} />}
      {/* Back and search stay put; only the section list scrolls, so neither
			    they nor the account footer are lost once the list outgrows the nav. */}
      <aside className={SETTINGS_NAV}>
        <button className={SETTINGS_BACK} onClick={onBack}>
          <span className={SETTINGS_NAV_ICON}>
            <IconChevronLeft />
          </span>
          Back to app
        </button>
        <NavSearch
          ref={setSearchBar}
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            if (firstHit) return onSelect(firstHit.key);
            const hit = firstProjectHit(projects, query);
            if (hit) onOpenProject(hit.project, hit.section);
          }}
          className={SETTINGS_NAV_SEARCH}
        />
        {/* The attribute is what useScrollEdge finds the scrollport by. */}
        <div data-settings-nav-scroll className={SETTINGS_NAV_LIST}>
          {shown.map((g) => (
            <div className={SETTINGS_NAV_GROUP} key={g.group}>
              <div className={SETTINGS_NAV_CAPTION}>{g.group}</div>
              {g.hits.map(({ item: s, hint }) => (
                <button
                  key={s.key}
                  className={SETTINGS_NAV_ROW}
                  data-active={active === s.key || undefined}
                  onClick={() => onSelect(s.key)}
                >
                  <span className={SETTINGS_NAV_ICON}>{s.icon}</span>
                  <span className="min-w-0 flex-1">
                    {s.label}
                    {hint && (
                      <span className="block truncate text-meta font-normal text-faint">
                        {hint}
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {g.group === PROJECTS_GROUP && (
                <ProjectNavRows
                  projects={projects}
                  active={project ?? null}
                  query={query}
                  onOpen={onOpenProject}
                />
              )}
            </div>
          ))}
          {shown.length === 0 && (
            <div className="px-2.5 py-3 text-meta text-faint">
              Nothing matches “{query}”.
            </div>
          )}
        </div>
        <SettingsAccountFooter />
      </aside>

      {/* Tool sections fill the whole content area edge-to-edge (they carry
			    their own layout/scrolling); settings panels keep the centered,
			    padded reading column. */}
      <div
        data-settings-scroll
        className={cn(SETTINGS_CONTENT, tool && SETTINGS_CONTENT_TOOL)}
      >
        {active === null ? (
          <div className={SETTINGS_PANEL_FRAME}>{children}</div>
        ) : tool ? (
          <SectionPanel
            section={active}
            onOpenOnboarding={onOpenOnboarding}
            onSelect={onSelect}
            onOpenProject={onOpenProject}
          >
            {children}
          </SectionPanel>
        ) : (
          <div
            className={
              GALLERY_SECTIONS.has(active)
                ? SETTINGS_PANEL_FRAME_GALLERY
                : SETTINGS_PANEL_FRAME
            }
          >
            <SectionPanel
              section={active}
              onOpenOnboarding={onOpenOnboarding}
              onSelect={onSelect}
              onOpenProject={onOpenProject}
            >
              {children}
            </SectionPanel>
          </div>
        )}
      </div>
    </div>
  );
}

/** A row of the phone sheet's grouped section list; its hairline starts
 *  past the glyph and stops at the last row. */
const SHEET_ROW =
  "relative flex min-h-11 w-full items-center gap-3 border-0 bg-transparent px-3.5 py-3 text-left after:absolute after:bottom-0 after:left-[54px] after:right-0 after:h-px after:bg-divider-soft last:after:hidden active:bg-hover";

/**
 * Phone Settings: a bottom sheet sliding up over the root page, with iOS-style
 * paging inside — the root page lists the sections as grouped tappable rows,
 * and picking one slides its panel in from the right (Back slides it out).
 * Which page shows is route-driven: a section in the URL = detail page.
 */
function MobileSettings({
  groups,
  section,
  project,
  projects,
  onSelect,
  onOpenProject,
  onShowRoot,
  onBack,
  onOpenOnboarding,
  children,
}: {
  groups: SectionGroup[];
  section?: SettingsSectionKey;
  project?: ActiveProject;
  projects: ProjectListItem[];
  onSelect: (key: SettingsSectionKey) => void;
  onOpenProject: (project: string, section?: ProjectSectionId) => void;
  onShowRoot?: () => void;
  onBack: () => void;
  onOpenOnboarding: () => void;
  children?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const shown = filterGroups(groups, query, projects);
  const firstHit = shown[0]?.hits[0]?.item;
  // A project's page is a detail page too, keyed "project" here; its panel
  // comes in through `children`.
  const current: SettingsSectionKey | "project" | null = project
    ? "project"
    : (section ?? null);
  // Keep the last opened page mounted while popping back to the root, so
  // the detail page has content during its slide-out.
  const [lastSection, setLastSection] = useState<
    SettingsSectionKey | "project" | null
  >(current);
  const [lastProjectLabel, setLastProjectLabel] = useState<string | null>(
    null,
  );
  const projectLabel = project
    ? (projects.find((p) => p.id === project.project)?.label ??
      project.project)
    : null;
  useEffect(() => {
    if (current) setLastSection(current);
  }, [current]);
  useEffect(() => {
    if (projectLabel) setLastProjectLabel(projectLabel);
  }, [projectLabel]);

  const detail = current;
  const shownSection = detail ?? lastSection;
  const shownLabel =
    shownSection === "project"
      ? (projectLabel ?? lastProjectLabel)
      : SECTIONS.find((s) => s.key === shownSection)?.label;
  const pageEase =
    "transition-transform duration-[var(--dur-lg)] ease-[var(--ease)]";

  return (
    <PhonePage
      onClose={onBack}
      label="Settings"
      className={cn("settings-sheet", SETTINGS_LEADING)}
    >
      {(dismiss) => (
        <>
          <PhoneTopBar>
            {detail && (
              <SheetIconButton
                className="absolute left-3"
                onClick={() => onShowRoot?.()}
                aria-label="Back to settings"
              >
                <IconChevronLeft size={24} />
              </SheetIconButton>
            )}
            {/* The sheet's own title, and the only one on phones: the panel
						    h1 hides in here (`[.settings-sheet_&]:hidden` in ui/settings).
						    This compact navigation chrome uses the 17px body step instead of
						    the larger desktop page-heading scale. */}
            <PhoneTopBarTitle>
              {detail ? shownLabel : "Settings"}
            </PhoneTopBarTitle>
            <SheetIconButton
              className="absolute right-3"
              onClick={dismiss}
              aria-label="Close settings"
            >
              <IconX size={24} />
            </SheetIconButton>
          </PhoneTopBar>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {/* Root page: grouped section list over a bottom search bar.
						    Parked slightly left while a detail page covers it, iOS-style. */}
            <div
              className={cn(
                "absolute inset-0",
                pageEase,
                detail && "-translate-x-1/3",
              )}
              aria-hidden={!!detail}
            >
              <div className={SETTINGS_SHEET_LIST}>
                {shown.map((g) => (
                  <div key={g.group}>
                    <div className="mb-2 mt-5 px-1 text-control-label font-semibold text-faint">
                      {g.group}
                    </div>
                    <div className="overflow-hidden rounded-2xl border border-divider-soft bg-settings-plate">
                      {g.hits.map(({ item: s, hint }) => (
                        <button
                          key={s.key}
                          className={SHEET_ROW}
                          onClick={() => onSelect(s.key)}
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center text-dim">
                            {s.icon}
                          </span>
                          <span className="min-w-0 flex-1 text-item-title font-medium text-fg">
                            {s.label}
                            {hint && (
                              <span className="block truncate text-meta font-normal text-faint">
                                {hint}
                              </span>
                            )}
                          </span>
                          <IconChevronRight
                            size={20}
                            className="shrink-0 text-faint"
                          />
                        </button>
                      ))}
                      {g.group === PROJECTS_GROUP && (
                        <ProjectSheetRows
                          projects={projects}
                          query={query}
                          onOpen={onOpenProject}
                          rowClassName={SHEET_ROW}
                        />
                      )}
                    </div>
                  </div>
                ))}
                {shown.length === 0 && (
                  <div className="mt-6 px-1 text-supporting text-faint">
                    Nothing matches “{query}”.
                  </div>
                )}
                {!query && <SettingsAccountCard />}
              </div>

              {/* Search sits at the bottom edge, where the thumb is and where
							    iOS 26 puts it (the native app's sessions list does the same),
							    on glass — so the list stays legible passing behind it and the
							    way out of a long section list is always in reach. */}
              <NavSearch
                sheet
                value={query}
                onChange={setQuery}
                onSubmit={() => {
            if (firstHit) return onSelect(firstHit.key);
            const hit = firstProjectHit(projects, query);
            if (hit) onOpenProject(hit.project, hit.section);
          }}
                className={SETTINGS_SHEET_SEARCH_BAR}
              />
            </div>

            {/* Detail page: the picked section's panel, slid in from the right. */}
            <div
              className={cn(
                "absolute inset-0 flex flex-col bg-surface",
                pageEase,
                detail ? "translate-x-0" : "translate-x-full",
              )}
              aria-hidden={!detail}
            >
              {shownSection && (
                <div data-settings-scroll className={SETTINGS_CONTENT_SHEET}>
                  {shownSection === "project" ? (
                    <div className={SETTINGS_PANEL_FRAME_SHEET}>{children}</div>
                  ) : TOOL_SECTIONS.has(shownSection) ? (
                    <SectionPanel
                      section={shownSection}
                      onOpenOnboarding={onOpenOnboarding}
                      onSelect={onSelect}
                      onOpenProject={onOpenProject}
                    >
                      {children}
                    </SectionPanel>
                  ) : (
                    <div className={SETTINGS_PANEL_FRAME_SHEET}>
                      <SectionPanel
                        section={shownSection}
                        onOpenOnboarding={onOpenOnboarding}
                        onSelect={onSelect}
                        onOpenProject={onOpenProject}
                      >
                        {children}
                      </SectionPanel>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </PhonePage>
  );
}
