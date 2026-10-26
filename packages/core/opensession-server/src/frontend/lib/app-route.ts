import { parseIncidentIntent } from "../../shared/incident-decision-copy";
import {
  KNOWLEDGE_FILTERS,
  type KnowledgeFilter,
} from "../../shared/knowledge";
import type { OwnerDecision } from "../../shared/incident-response";
import {
  parseSupportIntent,
  parseSupportItemId,
  type SupportIntent,
} from "../../shared/support";
import { BASE_PATH, stripBasePath } from "./base";
import {
  isProjectSectionId,
  type ProjectSectionId,
} from "./project-settings/page-model";
import type { SettingsSectionKey } from "./settings-sections";

/** The Knowledge page's tabs (`/settings/projects/<p>/knowledge/<tab>`). */
export const KNOWLEDGE_TABS = [
  "articles",
  "suggestions",
  "needs-check",
  "import",
  "history",
] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number];

/** Where the Knowledge page is: a tab, and the item open in it. */
export interface KnowledgeRoute {
  tab: KnowledgeTab;
  /** A repository path, e.g. `articles/export.md`. */
  path?: string;
  /** The Articles list's filter chip (`?filter=`), absent for All. */
  filter?: KnowledgeFilter;
  /** The Articles list's search (`?q=`), trimmed, absent when empty. */
  q?: string;
}

/** `?filter=&q=` for the Articles list, read back by
 *  parseRouteWithSearch. */
function knowledgeQuery(route: KnowledgeRoute): string {
  const params = new URLSearchParams();
  if (route.filter && route.filter !== "all")
    params.set("filter", route.filter);
  if (route.q) params.set("q", route.q);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** The Articles list's filter and search from the query; nothing for any
 *  other tab, or an item open in the editor. */
function withKnowledgeQuery(
  route: KnowledgeRoute,
  search: string,
): KnowledgeRoute {
  if (route.tab !== "articles" || route.path) return route;
  const params = new URLSearchParams(search);
  const next: KnowledgeRoute = { ...route };
  const filter = KNOWLEDGE_FILTERS.find((f) => f === params.get("filter"));
  if (filter && filter !== "all") next.filter = filter;
  const q = params.get("q")?.trim();
  if (q) next.q = q;
  return next;
}

function knowledgeTab(raw: string): KnowledgeTab {
  return KNOWLEDGE_TABS.find((tab) => tab === raw) ?? "articles";
}
import { assetSuffix, splitSessionRef, subagentSuffix } from "./share-link";

/**
 * A Support list item id (`<channel>:<id>`) from a `/support/<id>` path. A
 * bare id, from a link written before email joined the list, is a Plain
 * thread; so is one whose prefix is not a known channel. Idempotent.
 */
export function supportItemIdFromPath(raw: string): string {
  return parseSupportItemId(raw) ? raw : `plain:${raw}`;
}

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
  /** threadId: a Support list item id (`email:sc_…`, `plain:th_…`);
   *  intent: a support push's button, on an email conversation. */
  | { view: "support"; threadId: string; intent?: SupportIntent }
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
  /** `knowledge` (only with section "knowledge") opens the Knowledge page;
   *  without it the section is an anchor on the project's page. */
  | {
      view: "projectSettings";
      project: string;
      section?: ProjectSectionId;
      knowledge?: KnowledgeRoute;
    }
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
  "inboxes",
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

/** A decoded path segment; a malformed escape is kept as written. */
function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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
    return {
      view: "support",
      threadId: supportItemIdFromPath(decodeURIComponent(support[1]!)),
    };
  }
  // The Support list itself lives on the Support tool's page.
  if (path === "/support") return { view: "plain" };
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
  // A project's Knowledge page: a tab, then the item's path as one
  // encoded segment (a path written with plain slashes reads the same).
  const knowledge = path.match(
    /^\/settings\/projects\/([^/]+)\/knowledge\/([^/]+)(?:\/(.+))?$/,
  );
  if (knowledge) {
    const [, project, tab, itemPath] = knowledge;
    const route: KnowledgeRoute = { tab: knowledgeTab(segment(tab!)) };
    if (itemPath) route.path = segment(itemPath);
    return {
      view: "projectSettings",
      project: segment(project!),
      section: "knowledge",
      knowledge: route,
    };
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

/**
 * The current path of a link written in an old form, or `null` when the
 * path is already current. /settings/incidents/<project> became the
 * project's page, so a copied link should read the new path.
 */
export function legacyRoutePath(pathname: string): string | null {
  if (!/^\/settings\/incidents(?:\/[^/]+)?$/.test(stripBasePath(pathname)))
    return null;
  return routePath(parseRoute(pathname));
}

/** parseRoute plus what the query carries: a push intent on an incident
 *  or on an email conversation, the Knowledge list's filter and search. */
export function parseRouteWithSearch(pathname: string, search: string): Route {
  const route = parseRoute(pathname);
  if (route.view === "projectSettings" && route.knowledge)
    return { ...route, knowledge: withKnowledgeQuery(route.knowledge, search) };
  if (route.view === "support") {
    if (!route.threadId.startsWith("email:")) return route;
    const intent = parseSupportIntent(
      new URLSearchParams(search).get("intent"),
    );
    return intent ? { ...route, intent } : route;
  }
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
      // The item id's `:` reads better left as it is, and parseRoute
      // decodes either form.
      return `${BASE_PATH}/support/${encodeURIComponent(route.threadId).replace(/%3A/gi, ":")}${route.intent ? `?intent=${route.intent}` : ""}`;
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
    case "projectSettings": {
      const base = `${BASE_PATH}/settings/projects/${encodeURIComponent(route.project)}`;
      if (route.knowledge) {
        const { tab, path } = route.knowledge;
        return `${base}/knowledge/${tab}${path ? `/${encodeURIComponent(path)}` : ""}${knowledgeQuery(route.knowledge)}`;
      }
      return `${base}${route.section ? `/${route.section}` : ""}`;
    }
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
/**
 * Where an incident's settings link lands: the project's page, at `section`
 * (Incidents unless named), or the global section that fixes `fix`.
 */
export function incidentSettingsRoute(
  project: string,
  {
    fix,
    section = "incidents",
  }: { fix?: SettingsSectionKey; section?: ProjectSectionId } = {},
): Route {
  if (!fix) return { view: "projectSettings", project, section };
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
  // The Knowledge list under another filter or search is the same place:
  // the URL follows it without a history entry per keystroke.
  if (a.view === "projectSettings" && b.view === "projectSettings") {
    const [x, y] = [a.knowledge, b.knowledge];
    return (
      !!x &&
      !!y &&
      a.project === b.project &&
      x.tab === y.tab &&
      x.path === y.path
    );
  }
  const id = (route: Route) => ("id" in route ? route.id : undefined);
  return id(a) !== undefined && id(a) === id(b);
}
