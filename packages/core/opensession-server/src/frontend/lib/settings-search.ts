/**
 * Search over the Settings nav.
 *
 * Settings is a couple of dozen sections deep and their names are the *place*
 * a setting lives, not the words anyone arrives with: "dark mode" is in
 * Preferences, "cron" in Automations. So each section carries a
 * few aliases — the notable settings inside it plus the words people reach for
 * — and a query matches a section's label, its group, or one of those.
 *
 * Keywords are deliberately hand-written rather than scraped from the panels:
 * a panel's rows are loaded lazily and its copy changes for reasons that have
 * nothing to do with findability, so an index built from them would be both
 * unavailable at nav-render time and noisy. Keep an entry short — the terms
 * someone would type, not a summary of the page.
 */

import {
  PROJECT_SECTIONS,
  type ProjectSectionId,
} from "./project-settings/page-model";

export const SETTINGS_KEYWORDS = {
  projectDefaults: [
    "defaults",
    "default model",
    "default sandbox",
    "websites",
    "previews",
    "projects",
    "egress",
    "allowlist",
  ],
  myAccounts: [
    // Your profile lives at the top of this page, so its words have to find
    // it here.
    "profile",
    "avatar",
    "picture",
    "photo",
    "profile picture",
    "my name",
    "change my name",
    "rename",
    "display name",
    "timezone",
    "my email",
    "oauth",
    "sign in",
    "connect account",
    "act as me",
    "personal token",
    "github account",
    // The keychain is a section of this page, so its words have to find it
    // here — nothing else in Settings answers "secrets".
    "keychain",
    "credentials",
    "secrets",
    "grants",
    "access request",
  ],
  preferences: [
    "theme",
    "accent",
    "dark mode",
    "light mode",
    "row density",
    "show in sidebar",
    "default model",
    "code workspace",
    "checkout",
    "worktree",
    "output style",
    "concise",
    "response length",
    "send messages with",
    "pending sends",
    "outbox",
    "local storage",
    "enter key",
    "steer",
    "queue",
    "follow-up",
    "next button",
    "next chat",
    "vim mode",
    "debug",
    "agentation",
    "page feedback",
    "pin new sessions",
    "tool calls",
    "transcript",
    "desk voice",
    "personal prompt",
    "standing instructions",
  ],
  notifications: [
    "push",
    "desktop notifications",
    "sound",
    "alerts",
    "reviews",
    "review requests",
    "team review requests",
    "code owners",
    "codeowners",
    "mentions",
    "collaborators",
    "reminders",
    "inbox",
  ],
  shortcuts: [
    "keyboard",
    "key bindings",
    "rebind",
    "hotkey",
    "chord",
    "command menu",
    "archive shortcut",
  ],
  general: [
    "workspace name",
    "instance name",
    "branding",
    "product name",
    "agent name",
    "identity",
    "persona",
    "default repo",
  ],
  setup: ["onboarding", "getting started", "checklist", "first run"],
  repos: [
    "repositories",
    "projects",
    "checkout",
    "worktree",
    "branch",
    "clone",
  ],
  members: ["team", "people", "teammates", "access"],
  authentication: [
    "sign in",
    "login",
    "github",
    "oauth",
    "device flow",
    "none",
  ],
  providers: [
    "models",
    "default model",
    "engine",
    "pi",
    "claude accounts",
    "codex",
    "xai",
    "grok",
    "supergrok",
    "api key",
    "fallback",
    "usage",
    "spend",
    "cost",
    "tokens",
    "credits",
    "limits",
    "quota",
  ],
  runners: ["run hosts", "machines", "workers", "capacity", "detached runs"],
  library: ["templates", "prompts", "skills", "starters", "commands"],
  sandboxes: [
    "daytona",
    "boat",
    "box",
    "tart",
    "mac vm",
    "macos",
    "use.computer",
    "usecomputer",
    "this machine",
    "container",
    "podman",
    "isolation",
    "compute",
  ],
  integrations: [
    "tools",
    "webhooks",
    "credentials",
    "github app",
    "private key",
    "client secret",
  ],
  inboxes: ["inbox", "email", "imap", "smtp", "support", "mailbox"],
  connections: ["mcp servers", "tools", "agents", "add mcp server"],
  memory: ["facts", "remember", "scopes"],
  automations: ["scheduled", "cron", "triggers", "watchers", "jobs"],
  goals: ["standing goals", "objectives"],
  security: ["scans", "deepsec", "vulnerabilities", "findings"],
  ingress: [
    "webhooks",
    "public",
    "github",
    "plain",
    "cloudflare tunnel",
    "caddy",
    "dns",
    "oidc",
    "workload identity",
  ],
  storage: ["assets", "s3", "r2", "bucket", "object storage", "cloudflare"],
  prewarming: [
    "acceleration",
    "faster starts",
    "dependency cache",
    "preview pool",
    "warm",
    "install",
  ],
  deploys: ["releases", "restart", "version"],
  papercuts: ["friction", "annoyances"],
  audit: ["history", "events", "who did what"],
  downloads: [
    "download",
    "mac app",
    "desktop app",
    "install",
    "pwa",
    "home screen",
    "dmg",
  ],
};

const SETTINGS_KEYWORD_LOOKUP = new Map<string, string[]>(
  Object.entries(SETTINGS_KEYWORDS),
);

export type SectionLike = { key: string; label: string; group: string };

export type SectionHit<T extends SectionLike> = {
  item: T;
  /** The keyword that matched, when the label itself did not — shown under
   *  the row so a result that looks unrelated explains itself. */
  hint?: string;
};

/**
 * Filter sections against a query. An empty query returns everything with no
 * hints, so callers can render one list either way.
 */
export function matchSections<T extends SectionLike>(
  items: T[],
  query: string,
): SectionHit<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.map((item) => ({ item }));
  const hits: SectionHit<T>[] = [];
  for (const item of items) {
    if (
      item.label.toLowerCase().includes(q) ||
      item.group.toLowerCase().includes(q)
    ) {
      hits.push({ item });
      continue;
    }
    const hint = SETTINGS_KEYWORD_LOOKUP.get(item.key)?.find((keyword) =>
      keyword.includes(q),
    );
    if (hint) hits.push({ item, hint });
  }
  return hits;
}

/**
 * The words that find a section of a project's settings page. The page is
 * one per project, so these are searched per project: "veto" offers
 * "acme-web · Incidents" for every project, and a project's name in the
 * query narrows it to that one.
 */
export const PROJECT_SECTION_KEYWORDS: Record<ProjectSectionId, string[]> = {
  where: [
    "sandbox",
    "previews",
    "portal",
    "this machine",
    "container",
    "daytona",
  ],
  models: ["models", "model", "investigator", "verifier"],
  production: ["production", "runner", "deploy", "rollback", "release"],
  access: [
    "access",
    "keychain",
    "credentials",
    "connectors",
    "websites",
    "web search",
    "allow agents",
  ],
  incidents: [
    "incidents",
    "signals",
    "veto",
    "budget",
    "autonomy",
    "maintenance",
    "pause all agents",
    "on-call",
  ],
};

export type ProjectSectionHit = {
  project: string;
  section: ProjectSectionId;
  /** "acme-web · Incidents" */
  label: string;
  hint?: string;
};

/**
 * Project page sections that match a query. Every word has to match the
 * project's name, the section's name or one of its keywords, and at least
 * one has to match the section: a project's name alone finds the project's
 * row, not each of its sections.
 */
export function matchProjectSections(
  projects: ReadonlyArray<{ id: string; label: string }>,
  query: string,
): ProjectSectionHit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: ProjectSectionHit[] = [];
  for (const project of projects) {
    const name = project.label.toLowerCase();
    for (const [section, title] of PROJECT_SECTIONS) {
      const keywords = PROJECT_SECTION_KEYWORDS[section];
      let hint: string | undefined;
      let matchesSection = false;
      const every = words.every((word) => {
        if (title.toLowerCase().includes(word)) {
          matchesSection = true;
          return true;
        }
        const keyword = keywords.find((k) => k.includes(word));
        if (keyword) {
          matchesSection = true;
          hint ??= keyword;
          return true;
        }
        return name.includes(word);
      });
      if (!every || !matchesSection) continue;
      const hit: ProjectSectionHit = {
        project: project.id,
        section,
        label: `${project.label} · ${title}`,
      };
      if (hint) hit.hint = hint;
      hits.push(hit);
    }
  }
  return hits;
}

/** Projects whose name matches the query; all of them when it is empty. */
export function matchProjects<T extends { label: string }>(
  projects: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => p.label.toLowerCase().includes(q));
}

/** Where Enter in the settings search goes when no section matched: the
 *  first matching project, else the first matching project section. */
export function firstProjectHit(
  projects: ReadonlyArray<{ id: string; label: string }>,
  query: string,
): { project: string; section?: ProjectSectionId } | null {
  if (!query.trim()) return null;
  const project = matchProjects(projects, query)[0];
  if (project) return { project: project.id };
  const hit = matchProjectSections(projects, query)[0];
  return hit ? { project: hit.project, section: hit.section } : null;
}
