import { parseIncidentIntent } from "../../shared/incident-decision-copy";
import type { OwnerDecision } from "../../shared/incident-response";
import { BASE_PATH, stripBasePath } from "./base";
import {
  isProjectSectionId,
  type ProjectSectionId,
} from "./project-settings/page-model";
import type { SettingsSectionKey } from "./settings-sections";
import { assetSuffix, splitSessionRef, subagentSuffix } from "./share-link";

export type Route =
  | { view: "prs" }
  | { view: "issues" }
  | { view: "feed" }
  | { view: "new"; prompt?: string }
  | { view: "session"; id: string; subagent?: string[]; asset?: string }
  | {
      view: "workspace";
      id: string;
      tab?: "review" | "conversation" | "video";
    }
  | { view: "pr"; repo: string; branch: string; number?: number }
  | { view: "pr"; repo: string; branch?: undefined; number: number }
  | { view: "support"; threadId: string }
  | { view: "plain"; threadId?: string }
  | { view: "reports"; automationId?: string; reportId?: string }
  | { view: "databases"; databaseId?: string; table?: string }
  | { view: "analytics" }
  | { view: "tasks" }
  | { view: "reviews"; id?: string }
  | { view: "supporttinder" }
  | { view: "automations"; id?: string }
  | { view: "security" }
  | { view: "goals"; id?: string }
  | { view: "incidents"; id?: string; intent?: OwnerDecision }
  | { view: "projectSettings"; project: string; section?: ProjectSectionId }
  | { view: "settings"; section?: SettingsSectionKey }
  | { view: "archived" }
  | { view: "inbox" }
  | { view: "catchup" };

const TOOL_VIEWS = new Set(["automations", "security", "goals"]);
const SETTINGS_SECTIONS: ReadonlySet<string> = new Set<SettingsSectionKey>([
  "myAccounts",
  "preferences",
  "notifications",
  "shortcuts",
  "projectDefaults",
  "general",
  "setup",
  "repos",
  "members",
  "authentication",
  "providers",
  "sandboxes",
  "runners",
  "library",
  "integrations",
  "connections",
  "memory",
  "ingress",
  "storage",
  "prewarming",
  "deploys",
  "papercuts",
  "audit",
  "downloads",
]);
const LEGACY_SETTINGS_SECTIONS = new Map<string, SettingsSectionKey>([
  ["appearance", "preferences"],
  ["model", "providers"],
  ["models", "providers"],
  ["modelProviders", "providers"],
  ["usage", "providers"],
  ["warmPreviews", "prewarming"],
  ["previewPool", "prewarming"],
  ["workspace", "setup"],
  ["personalPrompt", "preferences"],
  ["deskVoice", "preferences"],
  ["composer", "preferences"],
  ["keychain", "myAccounts"],
  ["profile", "myAccounts"],
  ["identity", "general"],
]);

export function isToolView(
  view: string,
): view is "automations" | "security" | "goals" {
  return TOOL_VIEWS.has(view);
}

function isSettingsSection(value: string): value is SettingsSectionKey {
  return SETTINGS_SECTIONS.has(value);
}

function sessionRoute(rest: string): Route {
  const { id, subagent, asset } = splitSessionRef(rest);
  const route: Extract<Route, { view: "session" }> = { view: "session", id };
  if (subagent.length) route.subagent = subagent;
  if (asset) route.asset = asset;
  return route;
}

export function firstMileRequested(pathname: string, search: string): boolean {
  return (
    stripBasePath(pathname) === "/welcome" ||
    new URLSearchParams(search).get("firstmile") === "1"
  );
}

export function parseRoute(pathname: string): Route {
  const path = stripBasePath(pathname);
  const workspaceSession = path.match(/^\/workspace\/[^/]+\/session\/(.+)$/);
  if (workspaceSession) return sessionRoute(workspaceSession[1]!);

  const workspace = path.match(
    /^\/workspace\/([^/]+)(?:\/(review|conversation|video))?$/,
  );
  if (workspace) {
    const tab = workspace[2];
    const route: Extract<Route, { view: "workspace" }> = {
      view: "workspace",
      id: decodeURIComponent(workspace[1]!),
    };
    if (tab === "review" || tab === "conversation" || tab === "video")
      route.tab = tab;
    return route;
  }

  const session = path.match(/^\/session\/(.+)$/);
  if (session) return sessionRoute(session[1]!);

  const pullRequest = path.match(/^\/pr\/([^/]+)\/(.+)$/);
  if (pullRequest) {
    const repo = decodeURIComponent(pullRequest[1]!);
    const ref = decodeURIComponent(pullRequest[2]!);
    return /^\d{1,7}$/.test(ref)
      ? { view: "pr", repo, number: Number(ref) }
      : { view: "pr", repo, branch: ref };
  }

  const support = path.match(/^\/support\/(.+)$/);
  if (support) {
    return { view: "support", threadId: decodeURIComponent(support[1]!) };
  }
  const plain = path.match(/^\/plain(?:\/(.+))?$/);
  if (plain) {
    const route: Extract<Route, { view: "plain" }> = { view: "plain" };
    if (plain[1]) route.threadId = decodeURIComponent(plain[1]);
    return route;
  }
  const reports = path.match(/^\/reports(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (reports) {
    const route: Extract<Route, { view: "reports" }> = { view: "reports" };
    if (reports[1]) route.automationId = decodeURIComponent(reports[1]);
    if (reports[2]) route.reportId = decodeURIComponent(reports[2]);
    return route;
  }
  const databases = path.match(/^\/databases(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (databases) {
    const route: Extract<Route, { view: "databases" }> = { view: "databases" };
    if (databases[1]) route.databaseId = decodeURIComponent(databases[1]);
    if (databases[2]) route.table = decodeURIComponent(databases[2]);
    return route;
  }

  if (path === "/analytics") return { view: "analytics" };
  if (path === "/feed" || path === "/people") return { view: "feed" };
  if (path === "/tasks") return { view: "tasks" };
  if (path === "/issues") return { view: "issues" };
  if (path === "/new") return { view: "new" };

  const automation = path.match(/^\/automations(?:\/(.+))?$/);
  if (automation) {
    const route: Extract<Route, { view: "automations" }> = {
      view: "automations",
    };
    if (automation[1]) route.id = decodeURIComponent(automation[1]);
    return route;
  }
  if (path === "/security") return { view: "security" };
  const goal = path.match(/^\/goals(?:\/(.+))?$/);
  if (goal) {
    const route: Extract<Route, { view: "goals" }> = { view: "goals" };
    if (goal[1]) route.id = decodeURIComponent(goal[1]);
    return route;
  }
  const incident = path.match(/^\/incidents(?:\/([^/]+))?$/);
  if (incident) {
    const route: Extract<Route, { view: "incidents" }> = { view: "incidents" };
    if (incident[1]) route.id = decodeURIComponent(incident[1]);
    return route;
  }
  // Before the generic /settings/<key>: a project and its section ride
  // after the key. /settings/incidents is the old incident settings page,
  // now the project pages.
  const projects = path.match(
    /^\/settings\/(projects|incidents)(?:\/([^/]+)(?:\/([^/]+))?)?$/,
  );
  if (projects) {
    const [, kind, project, section] = projects;
    if (!project) return { view: "settings", section: "projectDefaults" };
    const route: Extract<Route, { view: "projectSettings" }> = {
      view: "projectSettings",
      project: decodeURIComponent(project),
    };
    if (kind === "incidents") route.section = "incidents";
    else if (isProjectSectionId(section)) route.section = section;
    return route;
  }
  if (path === "/connections") {
    return { view: "settings", section: "connections" };
  }

  const settings = path.match(/^\/settings(?:\/(.+))?$/);
  if (settings) {
    const key = settings[1];
    if (key && isToolView(key)) return { view: key };
    if (key && isSettingsSection(key)) {
      return { view: "settings", section: key };
    }
    const legacySection = key ? LEGACY_SETTINGS_SECTIONS.get(key) : undefined;
    return legacySection
      ? { view: "settings", section: legacySection }
      : { view: "settings" };
  }

  if (path === "/archived") return { view: "archived" };
  if (path === "/inbox") return { view: "inbox" };
  if (path === "/catchup") return { view: "catchup" };
  if (path === "/support-tinder") return { view: "supporttinder" };
  const reviews = path.match(/^\/reviews(?:\/(.+))?$/);
  if (reviews) {
    const route: Extract<Route, { view: "reviews" }> = { view: "reviews" };
    if (reviews[1]) route.id = decodeURIComponent(reviews[1]);
    return route;
  }
  return { view: "prs" };
}

/** parseRoute plus what the query carries: a push intent on an incident. */
export function parseRouteWithSearch(pathname: string, search: string): Route {
  const route = parseRoute(pathname);
  if (route.view !== "incidents" || !route.id) return route;
  const intent = parseIncidentIntent(new URLSearchParams(search).get("intent"));
  return intent ? { ...route, intent } : route;
}

export function routePath(route: Route): string {
  switch (route.view) {
    case "session":
      return `${BASE_PATH}/session/${encodeURIComponent(route.id)}${subagentSuffix(route.subagent)}${assetSuffix(route.asset)}`;
    case "workspace":
      return `${BASE_PATH}/workspace/${encodeURIComponent(route.id)}${route.tab ? `/${route.tab}` : ""}`;
    case "pr":
      return `${BASE_PATH}/pr/${encodeURIComponent(route.repo)}/${
        route.branch === undefined
          ? route.number
          : encodeURIComponent(route.branch)
      }`;
    case "support":
      return `${BASE_PATH}/support/${encodeURIComponent(route.threadId)}`;
    case "plain":
      return route.threadId
        ? `${BASE_PATH}/plain/${encodeURIComponent(route.threadId)}`
        : `${BASE_PATH}/plain`;
    case "reports":
      return route.automationId
        ? `${BASE_PATH}/reports/${encodeURIComponent(route.automationId)}${route.reportId ? `/${encodeURIComponent(route.reportId)}` : ""}`
        : `${BASE_PATH}/reports`;
    case "databases":
      return route.databaseId
        ? `${BASE_PATH}/databases/${encodeURIComponent(route.databaseId)}${route.table ? `/${encodeURIComponent(route.table)}` : ""}`
        : `${BASE_PATH}/databases`;
    case "analytics":
      return `${BASE_PATH}/analytics`;
    case "feed":
      return `${BASE_PATH}/feed`;
    case "tasks":
      return `${BASE_PATH}/tasks`;
    case "issues":
      return `${BASE_PATH}/issues`;
    case "new":
      return route.prompt
        ? `${BASE_PATH}/new?prompt=${encodeURIComponent(route.prompt)}`
        : `${BASE_PATH}/new`;
    case "automations":
      return route.id
        ? `${BASE_PATH}/automations/${encodeURIComponent(route.id)}`
        : `${BASE_PATH}/automations`;
    case "security":
      return `${BASE_PATH}/security`;
    case "goals":
      return route.id
        ? `${BASE_PATH}/goals/${encodeURIComponent(route.id)}`
        : `${BASE_PATH}/goals`;
    case "incidents":
      return route.id
        ? `${BASE_PATH}/incidents/${encodeURIComponent(route.id)}${route.intent ? `?intent=${route.intent}` : ""}`
        : `${BASE_PATH}/incidents`;
    case "projectSettings":
      return `${BASE_PATH}/settings/projects/${encodeURIComponent(route.project)}${route.section ? `/${route.section}` : ""}`;
    case "settings":
      if (route.section === "projectDefaults") {
        return `${BASE_PATH}/settings/projects`;
      }
      return route.section
        ? `${BASE_PATH}/settings/${route.section}`
        : `${BASE_PATH}/settings`;
    case "archived":
      return `${BASE_PATH}/archived`;
    case "inbox":
      return `${BASE_PATH}/inbox`;
    case "catchup":
      return `${BASE_PATH}/catchup`;
    case "supporttinder":
      return `${BASE_PATH}/support-tinder`;
    case "reviews":
      return route.id
        ? `${BASE_PATH}/reviews/${encodeURIComponent(route.id)}`
        : `${BASE_PATH}/reviews`;
    default:
      return `${BASE_PATH}/`;
  }
}

/**
 * Where an incident's settings links go: its project's Incidents section,
 * or, for a setup problem, the section that fixes it. A missing sandbox is
 * fixed on the project's page (Where agents run); anything else stays in
 * the app's settings.
 */
export function incidentSettingsRoute(
  project: string,
  fix?: SettingsSectionKey,
): Route {
  if (!fix) return { view: "projectSettings", project, section: "incidents" };
  if (fix === "sandboxes") {
    return { view: "projectSettings", project, section: "where" };
  }
  return { view: "settings", section: fix };
}

export function isSettingsRoute(route: Route): boolean {
  return (
    route.view === "settings" ||
    route.view === "projectSettings" ||
    isToolView(route.view)
  );
}

export function samePanel(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false;
  const id = (route: Route) => ("id" in route ? route.id : undefined);
  return id(a) !== undefined && id(a) === id(b);
}
