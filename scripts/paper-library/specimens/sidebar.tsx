import * as React from "react";
import type { Section, Specimen } from "../entry";
import type {
  UnifiedSession,
  Workspace,
} from "../../../packages/core/opensession-server/src/frontend/lib/types";
import type { WsRow } from "../../../packages/core/opensession-server/src/frontend/lib/sidebar-types";
import { cn } from "../../../packages/core/opensession-server/src/frontend/ui/cn";
import {
  SIDEBAR_DENSITY_VARS,
  SIDEBAR_NAV_X,
  SIDEBAR_LIST,
  SIDEBAR_INDEPENDENT_SECTION,
  SIDEBAR_INDEPENDENT_SCROLL,
  SIDEBAR_GROUP,
} from "../../../packages/core/opensession-server/src/frontend/lib/sidebar-classes";
import { WorkspaceRow } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/WorkspaceRow";
import { SidebarChrome } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/SidebarChrome";
import { ProjectBands } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/ProjectBands";
import { createWorkspaceGroupingRenderers } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/sidebar-workspace-renderers";
import { createSidebarToolsModel } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/sidebar-tools-model";
import { DraftRow } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/DraftRow";
import { PersonalBand } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/PersonalBand";
import { SidebarAccountFooter } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/SidebarAccountFooter";
import { OrganizationSwitcher } from "../../../packages/core/opensession-server/src/frontend/components/OrganizationSwitcher";
import { UpdatePill } from "../../../packages/core/opensession-server/src/frontend/components/UpdatePill";
import {
  UsageMeter,
  UsageDetails,
} from "../../../packages/core/opensession-server/src/frontend/components/UsageMeter";
import { NextUnreadButton } from "../../../packages/core/opensession-server/src/frontend/components/NextUnreadButton";
import {
  RowCardPopup,
  PrRowCard,
  SupportRowCard,
} from "../../../packages/core/opensession-server/src/frontend/components/SidebarRowCards";
import { SessionCardBody } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/HoverCards";
import { TitleBar } from "../../../packages/core/opensession-server/src/frontend/components/TitleBar";
import { NavigationContext } from "../../../packages/core/opensession-server/src/frontend/hooks/useNavigation";
import { rememberOrganizationIcon } from "../../../packages/core/opensession-server/src/frontend/hooks/useOrganizationIcon";
import { getFilter } from "../../../packages/core/opensession-server/src/frontend/lib/sidebar-filter";
import { ASK_BAND } from "../../../packages/core/opensession-server/src/frontend/lib/sidebar-workspaces";
import type { NavigationActions } from "../../../packages/core/opensession-server/src/frontend/lib/navigation";
import type { SidebarProjectBand } from "../../../packages/core/opensession-server/src/frontend/lib/sidebar-derived";
import type { SidebarToolId } from "../../../packages/core/opensession-server/src/frontend/lib/sidebar-tools";
import type { TeamMember } from "../../../packages/core/opensession-server/src/frontend/components/TeamPresence";
import type { ReviewQueueItem } from "../../../packages/core/opensession-server/src/frontend/lib/review-queue";
import { Popover } from "../../../packages/core/opensession-server/src/frontend/ui/popover";
import { Tooltip } from "../../../packages/core/opensession-server/src/frontend/ui/tooltip";
import { IconSidebarLeft } from "../../../packages/core/opensession-server/src/frontend/components/icons";
import { SIDEBAR_CHROME_BTN } from "../../../packages/core/opensession-server/src/frontend/lib/sidebar-classes";
import {
  SWRConfig,
  unstable_serialize,
} from "../../../packages/core/opensession-server/node_modules/swr";
import { apiSWRKey } from "../../../packages/core/opensession-server/src/frontend/lib/api-swr";
import { RECENTLY_FIXED_MS } from "../../../packages/core/opensession-server/src/frontend/lib/incidents/sidebar";
import { SHORT_QUERY } from "../../../packages/core/opensession-server/src/frontend/lib/breakpoints";
import { rowTintHex } from "../../../packages/core/opensession-server/src/frontend/lib/row-colors";
import { IncidentsBand } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/IncidentsBand";
import { IncidentRow } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/IncidentRow";
import { HiddenEntry } from "../../../packages/core/opensession-server/src/frontend/components/sidebar/HiddenEntry";
import type { HiddenListEntry } from "../../../packages/core/opensession-server/src/frontend/lib/hidden-list";
import type { ActiveRowDrag } from "../../../packages/core/opensession-server/src/frontend/hooks/useActiveRowDrag";
import type {
  IncidentSummary,
  SignalView,
} from "../../../packages/core/opensession-server/src/shared/incidents";
// @ts-ignore png asset
import appIcon from "../../../mac-app-icon.png";

/* ── Fixture setup ───────────────────────────────────────────────────────── */

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ME = "Kacper";

try {
  localStorage.setItem("opensession-user", ME);
  // The one row that carries an unsent composer draft (the pencil).
  sessionStorage.setItem(
    "backstage-draft:session:s-draft-text",
    JSON.stringify({ text: "Also check the pass on iOS 18 lock screen" }),
  );
} catch {}
rememberOrganizationIcon({
  organizationName: "Acme",
  organizationIconUrl: appIcon,
  organizationIconRevision: null,
} as Parameters<typeof rememberOrganizationIcon>[0]);

const noop = () => {};

let seq = 0;
function sess(p: Partial<UnifiedSession> = {}): UnifiedSession {
  seq += 1;
  return {
    id: `s-${seq}`,
    source: "opensession",
    branch: "feat/wallet-pass",
    worktreeDir: null,
    createdBy: ME,
    startedBy: ME,
    title: "Session",
    lastActivity: ago(42),
    createdAt: ago(300),
    isRunning: false,
    repo: "habit",
    ran: true,
    ...p,
  } as UnifiedSession;
}

function wsRow(p: Partial<WsRow> & { name: string }): WsRow {
  const sessions = p.sessions ?? [sess({ title: p.name })];
  return {
    key: `row-${p.name}`,
    workspace: null,
    sessions,
    status: "pending",
    lastActivity: sessions[0]?.lastActivity ?? ago(42),
    createdAt: ago(300),
    unread: false,
    running: false,
    owner: ME.toLowerCase(),
    ...p,
  };
}

const PR = (
  n: number,
  extra: Partial<UnifiedSession> = {},
): Partial<UnifiedSession> => ({
  prNumber: n,
  prUrl: `https://github.com/acme/habit/pull/${n}`,
  prState: "OPEN",
  ...extra,
});

/* ── Rows ────────────────────────────────────────────────────────────────── */

type RowOpts = {
  active?: boolean;
  isPhone?: boolean;
  pinned?: boolean;
  inbox?: boolean;
  groupsByRepo?: boolean;
  timePreference?: "off" | "hover" | "always";
  snoozeIso?: string | null;
  isDraft?: boolean;
  hasSectionHeading?: boolean;
  shipsDirectlyToMain?: boolean;
  teamViewing?: Array<{ user: string; sessionId: string }>;
  /** A row color swatch key ("blue", "green"…), painted as a faint wash. */
  color?: string;
};

function Row({ row, o = {} }: { row: WsRow; o?: RowOpts }) {
  return (
    <WorkspaceRow
      row={row}
      presentation={{
        inbox: o.inbox ?? false,
        active: o.active ?? false,
        isPhone: o.isPhone ?? false,
        isDraft: o.isDraft ?? false,
        hasSectionHeading: o.hasSectionHeading ?? true,
        groupsByRepo: o.groupsByRepo ?? false,
        repoName: row.sessions[0]?.repo ?? "habit",
        runStartSeenMs: null,
        snoozed: !!o.snoozeIso,
        snoozeIso: o.snoozeIso ?? null,
        timePreference: o.timePreference ?? "off",
        shipsDirectlyToMain: o.shipsDirectlyToMain ?? false,
        pinned: o.pinned ?? false,
        tint: rowTintHex(o.color ?? null),
      }}
      context={{
        editing: null,
        currentUser: ME,
        mePersonKey: ME.toLowerCase(),
        teamViewing: o.teamViewing ?? [],
      }}
      swipe={{ offset: 0, action: null, dragging: false, dragSide: null }}
      shortcuts={{
        pinShortcutKeys: ["⌘", "P"],
        archiveShortcutKeys: ["⌘", "⌫"],
      }}
      events={{
        onActivate: noop,
        onMouseEnter: noop,
        onMouseLeave: noop,
        onMouseDown: noop,
        onTouchStart: noop,
        onTouchMove: noop,
        onTouchEnd: noop,
        onTouchCancel: noop,
        onContextMenu: noop,
      }}
      actions={{
        onCloseSwipe: noop,
        onTogglePin: noop,
        onToggleSnooze: noop,
        onArchive: noop,
        onDeleteDraft: noop,
        onConfirmDeleteDraft: noop,
        onOpenMention: noop,
        onStartWorkspaceRename: noop,
        onStartSessionRename: noop,
        onKeepInSidebar: noop,
      }}
    />
  );
}

/* ── Surfaces ────────────────────────────────────────────────────────────── */

/** The sidebar column: AppSidebar's container classes plus the scroll root's
 *  density and inset vars, so rows read every custom property they expect. */
const SIDEBAR_SURFACE = cn(
  "sidebar-container flex min-w-0 flex-col bg-sidebar [--sidebar-icon-left:16px]",
  "desktop:[background:linear-gradient(var(--sidebar-material),var(--sidebar-material)),var(--sidebar-bg)]",
  SIDEBAR_DENSITY_VARS,
  SIDEBAR_NAV_X,
);

/** Force interaction attributes onto descendants (the rows don't pass props to
 *  their buttons). */
function Surface({
  children,
  force,
  list = true,
  className,
}: {
  children: React.ReactNode;
  force?: Array<[string, string]>;
  list?: boolean;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    for (const [sel, attr] of force ?? [])
      ref.current
        ?.querySelectorAll(sel)
        .forEach((el) => el.setAttribute(attr, ""));
  });
  return (
    <div ref={ref} className={cn(SIDEBAR_SURFACE, "w-full py-1", className)}>
      {list ? (
        <div className={SIDEBAR_LIST} data-sidebar-list>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

const ROW_BTN = "button[data-sidebar-row]";
const HOVER: Array<[string, string]> = [[ROW_BTN, "data-force-hover"]];

type RowState = "default" | "hover" | "selected";
const STATES: RowState[] = ["default", "hover", "selected"];

function rowSpec(
  label: string,
  state: RowState,
  row: WsRow,
  o: RowOpts = {},
  extra: Partial<Specimen> = {},
): Specimen {
  return {
    name: `${label} · ${state}`,
    width: o.isPhone ? 390 : 280,
    viewport: o.isPhone ? 390 : undefined,
    node: (
      <Surface force={state === "hover" ? HOVER : undefined}>
        <Row row={row} o={{ ...o, active: state === "selected" || o.active }} />
      </Surface>
    ),
    ...extra,
  };
}

/* ── Session row fixtures ─────────────────────────────────────────────────── */

const ROWS: Array<[string, WsRow, RowOpts?]> = [
  [
    "running",
    wsRow({
      name: "Export worker memory spike",
      running: true,
      status: "inprogress",
      sessions: [
        sess({
          title: "Export worker memory spike",
          isRunning: true,
          runStartedAt: ago(18),
          branch: "fix/export-worker-memory",
          repo: "franking",
        }),
      ],
    }),
  ],
  [
    "needs input",
    wsRow({
      name: "Passkey sign-in",
      status: "needsinput",
      unread: true,
      sessions: [
        sess({
          title: "Passkey sign-in",
          waitingForInput: true,
          branch: "feat/passkey-sign-in",
        } as Partial<UnifiedSession>),
      ],
    }),
  ],
  [
    "unread",
    wsRow({
      name: "Reconcile September Stripe payouts",
      unread: true,
      status: "review",
      sessions: [
        sess({
          title: "Reconcile September Stripe payouts",
          branch: "fix/stripe-payouts-sept",
          repo: "franking",
          ...PR(482, {
            prChecks: { total: 9, passed: 9, failed: 0, pending: 0 },
          }),
        }),
      ],
    }),
  ],
  [
    "unread while running",
    wsRow({
      name: "Departure board offline cache",
      unread: true,
      running: true,
      status: "inprogress",
      sessions: [
        sess({
          title: "Departure board offline cache",
          isRunning: true,
          runStartedAt: ago(4),
          branch: "feat/offline-departures",
          repo: "betterbahn",
        }),
      ],
    }),
  ],
  [
    "merged",
    wsRow({
      name: "Wallet pass redesign",
      status: "merged",
      sessions: [
        sess({
          title: "Wallet pass redesign",
          ...PR(471, { prState: "MERGED" }),
        }),
      ],
    }),
  ],
  [
    "failed",
    wsRow({
      name: "Nightly invoice export",
      sessions: [
        sess({
          title: "Nightly invoice export",
          branch: "fix/invoice-export",
          repo: "franking",
          lastRunError: { message: "Usage limit reached", at: ago(12) },
        } as Partial<UnifiedSession>),
      ],
    }),
  ],
  [
    "draft",
    wsRow({
      name: "Streak freeze tokens",
      sessions: [],
      workspace: {
        id: "w-draft",
        name: "Streak freeze tokens",
        createdBy: ME,
        createdAt: ago(20),
        draft: {
          text: "Let people bank a streak freeze each week",
          updatedAt: ago(20),
        },
      } as Workspace,
    }),
    { isDraft: true },
  ],
  [
    "pr open",
    wsRow({
      name: "Habit reminders on Apple Watch",
      status: "review",
      sessions: [
        sess({
          title: "Habit reminders on Apple Watch",
          branch: "feat/watch-reminders",
          ...PR(488, {
            prChecks: { total: 9, passed: 9, failed: 0, pending: 0 },
          }),
        }),
      ],
    }),
  ],
  [
    "pr checks running",
    wsRow({
      name: "Deploy previews per branch",
      sessions: [
        sess({
          title: "Deploy previews per branch",
          branch: "feat/branch-previews",
          repo: "stacked",
          ...PR(212, {
            prChecks: { total: 6, passed: 4, failed: 0, pending: 2 },
          }),
        }),
      ],
    }),
  ],
  [
    "pr changes requested",
    wsRow({
      name: "Delay alerts for connecting trains",
      sessions: [
        sess({
          title: "Delay alerts for connecting trains",
          branch: "feat/connection-alerts",
          repo: "betterbahn",
          ...PR(97, { prReviewDecision: "CHANGES_REQUESTED" }),
        }),
      ],
    }),
  ],
  [
    "draft pr",
    wsRow({
      name: "Postage label batch print",
      sessions: [
        sess({
          title: "Postage label batch print",
          branch: "feat/batch-labels",
          repo: "franking",
          ...PR(503, { prIsDraft: true }),
        }),
      ],
    }),
  ],
  [
    "no pr",
    wsRow({
      name: "Onboarding copy pass",
      sessions: [
        sess({
          title: "Onboarding copy pass",
          branch: "chore/onboarding-copy",
        }),
      ],
    }),
  ],
  [
    "ships to main",
    wsRow({
      name: "Bump Caddy to 2.9",
      sessions: [
        sess({ title: "Bump Caddy to 2.9", branch: "main", repo: "stacked" }),
      ],
    }),
    { shipsDirectlyToMain: true },
  ],
  [
    "snoozed",
    wsRow({
      name: "Dark mode for widgets",
      sessions: [
        sess({ title: "Dark mode for widgets", branch: "feat/widget-dark" }),
      ],
    }),
    { snoozeIso: new Date(NOW + 3 * 3600_000 + 120_000).toISOString() },
  ],
];

const MARK_ROWS: Array<[string, WsRow, RowOpts?]> = [
  [
    "time · always",
    wsRow({
      name: "Habit reminders on Apple Watch",
      sessions: [
        sess({
          title: "Habit reminders on Apple Watch",
          lastActivity: ago(42),
          ...PR(488),
        }),
      ],
    }),
    { groupsByRepo: true, timePreference: "always" },
  ],
  [
    "inbox · repo tile",
    wsRow({
      name: "Departure board offline cache",
      sessions: [
        sess({
          title: "Departure board offline cache",
          repo: "betterbahn",
          lastActivity: ago(180),
          ...PR(96),
        }),
      ],
    }),
    { inbox: true, timePreference: "always" },
  ],
  [
    "mention",
    wsRow({
      name: "Passkey sign-in",
      unread: true,
      mention: "Maya",
      mentionSessionId: "s-mention",
      sessions: [
        sess({ id: "s-mention", title: "Passkey sign-in", ...PR(490) }),
      ],
    }),
  ],
  [
    "viewers",
    wsRow({
      name: "Wallet pass redesign",
      sessions: [
        sess({ id: "s-viewed", title: "Wallet pass redesign", ...PR(471) }),
      ],
    }),
    {
      teamViewing: [
        { user: "Maya", sessionId: "s-viewed" },
        { user: "Tom", sessionId: "s-viewed" },
      ],
    },
  ],
  [
    "agent started",
    wsRow({
      name: "Weekly dependency bumps",
      sessions: [
        sess({
          title: "Weekly dependency bumps",
          agentStarted: true,
          repo: "stacked",
          ...PR(214),
        }),
      ],
    }),
  ],
  [
    "from slack",
    wsRow({
      name: "Refund for double charge",
      sessions: [
        sess({
          title: "Refund for double charge",
          source: "slack",
          repo: "franking",
          branch: "fix/double-charge",
        } as Partial<UnifiedSession>),
      ],
    }),
  ],
  [
    "unsent draft",
    wsRow({
      name: "Wallet pass on lock screen",
      sessions: [
        sess({
          id: "s-draft-text",
          title: "Wallet pass on lock screen",
          ...PR(492),
        }),
      ],
    }),
  ],
  [
    "running · with draft",
    wsRow({
      name: "Export worker memory spike",
      running: true,
      status: "inprogress",
      sessions: [
        sess({
          id: "s-draft-text",
          title: "Export worker memory spike",
          isRunning: true,
          runStartedAt: ago(18),
          repo: "franking",
        }),
      ],
    }),
  ],
];

const LONG = wsRow({
  name: "Reconcile September Stripe payouts against the ledger export and flag mismatches",
  sessions: [
    sess({
      title:
        "Reconcile September Stripe payouts against the ledger export and flag mismatches",
      repo: "franking",
      ...PR(482),
    }),
  ],
});
const LONG_RUNNING = wsRow({
  name: "Reconcile September Stripe payouts against the ledger export and flag mismatches",
  running: true,
  status: "inprogress",
  sessions: [
    sess({
      title: "Reconcile September Stripe payouts against the ledger export",
      isRunning: true,
      runStartedAt: ago(18),
      repo: "franking",
    }),
  ],
});

/* ── Sections ─────────────────────────────────────────────────────────────── */

const rowSections: Section[] = [
  {
    group: "Session row",
    title: "Status × state",
    specimens: ROWS.flatMap(([label, row, o]) =>
      STATES.map((st) => rowSpec(label, st, row, o)),
    ),
  },
  {
    group: "Session row",
    title: "Marks and meta",
    specimens: MARK_ROWS.flatMap(([label, row, o]) =>
      (["default", "hover"] as const).map((st) => rowSpec(label, st, row, o)),
    ),
  },
  {
    group: "Session row",
    title: "Row action chips",
    specimens: [
      rowSpec("chips · unpinned", "hover", ROWS[7][1]),
      {
        name: "chips · unpinned · archive hover",
        width: 280,
        node: (
          <Surface
            force={[
              ...HOVER,
              [
                "[data-ws-actions] > [role=button]:last-child",
                "data-force-hover",
              ],
            ]}
          >
            <Row row={ROWS[7][1]} />
          </Surface>
        ),
      },
      rowSpec("chips · pinned", "hover", ROWS[7][1], { pinned: true }),
      rowSpec("chips · pinned", "selected", ROWS[7][1], { pinned: true }),
      rowSpec(
        "chips · keep in sidebar",
        "hover",
        wsRow({
          name: "Seat map for ICE coaches",
          owner: "maya",
          sessions: [
            sess({
              title: "Seat map for ICE coaches",
              startedBy: "Maya",
              createdBy: "Maya",
              repo: "betterbahn",
              ...PR(99),
            }),
          ],
        }),
      ),
      rowSpec("chips · draft delete", "hover", ROWS[6][1], ROWS[6][2]),
    ],
  },
  {
    group: "Session row",
    title: "Row colors",
    specimens: [
      ...STATES.map((st) =>
        rowSpec("color · blue", st, ROWS[7][1], { color: "blue" }),
      ),
      ...STATES.map((st) =>
        rowSpec("color · green, running", st, ROWS[0][1], {
          color: "green",
        }),
      ),
      ...(["red", "orange", "yellow", "purple", "pink"] as const).map((c) =>
        rowSpec(`color · ${c}`, "default", ROWS[11][1], { color: c }),
      ),
      rowSpec("phone · color · blue", "default", ROWS[7][1], {
        color: "blue",
        isPhone: true,
      }),
    ],
  },
  {
    group: "Session row",
    title: "Long title",
    specimens: [
      ...STATES.map((st) => rowSpec("long title", st, LONG)),
      rowSpec("long title · running", "default", LONG_RUNNING),
    ],
  },
  {
    group: "Session row",
    title: "Phone",
    specimens: [
      ...ROWS.slice(0, 6).map(([label, row, o]) =>
        rowSpec(`phone · ${label}`, "default", row, { ...o, isPhone: true }),
      ),
      rowSpec("phone · pr open", "selected", ROWS[7][1], { isPhone: true }),
      rowSpec("phone · long title", "default", LONG, { isPhone: true }),
    ],
  },
];

/* ── Shared fakes for the sidebar's chrome ───────────────────────────────── */

const NAV = new Proxy(
  { unreadChats: [], allChatsRead: false } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : noop) },
) as unknown as NavigationActions;

function NavProvider({
  value,
  children,
}: {
  value?: Partial<NavigationActions>;
  children: React.ReactNode;
}) {
  const nav = React.useMemo(
    () =>
      new Proxy(
        { unreadChats: [], allChatsRead: false, ...value } as Record<
          string,
          unknown
        >,
        {
          get: (t, k: string) => (k in t ? t[k] : noop),
        },
      ) as unknown as NavigationActions,
    [value],
  );
  return <NavigationContext value={nav}>{children}</NavigationContext>;
}

const REPOS = ["habit", "franking", "betterbahn", "stacked"];

const TEAM: TeamMember[] = [
  {
    key: "maya",
    person: { name: "Maya", fullName: "Maya Lindqvist" },
    online: true,
    working: true,
    isYou: false,
  },
  {
    key: "tom",
    person: { name: "Tom", fullName: "Tom Becker" },
    online: true,
    working: false,
    isYou: false,
  },
  {
    key: "jonas",
    person: { name: "Jonas", fullName: "Jonas Weber" },
    online: false,
    working: false,
    isYou: false,
  },
];

const ALL_TOOLS: SidebarToolId[] = [
  "feed",
  "prs",
  "incidents",
  "issues",
  "tasks",
  "plain",
  "catchup",
  "supporttinder",
  "reports",
  "databases",
  "analytics",
];

/** The tool rows exactly as Sidebar derives them. */
function toolsModel({
  active = null,
  isPhone = false,
  // The shipped default strip (DEFAULT_VISIBLE_TOOLS); Catch up is phone-only.
  shown = ["feed", "prs", "incidents", "plain", "catchup"],
  taskCount = 3,
  catchUpCount = 2,
  archivedActive = false,
}: {
  active?: SidebarToolId | null;
  isPhone?: boolean;
  shown?: SidebarToolId[];
  taskCount?: number;
  catchUpCount?: number;
  archivedActive?: boolean;
} = {}) {
  return createSidebarToolsModel({
    navigation: NAV,
    feedActive: active === "feed",
    prsActive: active === "prs",
    incidentsActive: active === "incidents",
    issuesActive: active === "issues",
    tasksActive: active === "tasks",
    taskCount,
    plainActive: active === "plain",
    catchUpActive: active === "catchup",
    catchUpCount,
    supportTinderActive: false,
    reportsActive: active === "reports",
    databasesActive: false,
    analyticsActive: false,
    isPhone,
    toolOrder: ALL_TOOLS,
    hiddenTools: new Set(ALL_TOOLS.filter((id) => !shown.includes(id))),
    hiddenFeeds: new Set(),
    borrowedLens: false,
    productEmpty: false,
    feeds: [],
    emailSupport: true,
    archivedActive,
  });
}

/* ── Incidents ─────────────────────────────────────────────────────────────────────────── */

const inMin = (min: number) => new Date(NOW + min * 60_000).toISOString();

function incident(p: Partial<IncidentSummary>): IncidentSummary {
  return {
    id: "inc-1",
    project: "betterbahn",
    title: "Departure search",
    state: "investigating",
    severity: "major",
    owner: "Kacper",
    openedBy: { kind: "rule" },
    signalIds: ["sig-search"],
    primarySignalId: "sig-search",
    openedAt: ago(38),
    updatedAt: ago(6),
    lastProblemAt: ago(6),
    findings: [],
    droppedEvents: 0,
    eventCount: 4,
    ...p,
  } as IncidentSummary;
}

const INC = {
  needsYou: incident({
    id: "inc-search",
    title: "Departure search",
    state: "needs-you",
  }),
  veto: incident({
    id: "inc-export",
    project: "franking",
    title: "Invoice export",
    state: "veto",
    signalIds: ["sig-export"],
    primarySignalId: "sig-export",
    openedAt: ago(52),
    response: { round: 1, veto: { deadline: inMin(14) } } as never,
  }),
  investigating: incident({
    id: "inc-previews",
    project: "stacked",
    title: "Branch previews",
    state: "investigating",
    signalIds: ["sig-previews"],
    primarySignalId: "sig-previews",
    openedAt: ago(20),
    response: { round: 2 } as never,
  }),
  fixed: incident({
    id: "inc-push",
    project: "habit",
    title: "Push reminders",
    state: "resolved",
    signalIds: ["sig-push"],
    primarySignalId: "sig-push",
    openedAt: ago(180),
    closedAt: ago(95),
    updatedAt: ago(95),
  }),
};

function signal(
  id: string,
  name: string,
  project: string,
  state: "ok" | "failing" | "slow",
): SignalView {
  return {
    id,
    name,
    project,
    enabled: true,
    severity: "major",
    source: { kind: "http", url: `https://${project}.example.test/health` },
    intervalMs: 120_000,
    rule: { kind: "consecutive", failures: 3 },
    createdBy: ME,
    createdAt: ago(60 * 24 * 9),
    updatedAt: ago(60 * 24 * 9),
    evaluation: {
      signalId: id,
      state,
      reason: "",
      since: ago(38),
      at: ago(1),
      inMaintenance: false,
    },
  } as SignalView;
}

const SIGNALS_FAILING = [
  signal("sig-search", "Departure search", "betterbahn", "failing"),
  signal("sig-export", "Invoice export", "franking", "slow"),
  signal("sig-previews", "Branch previews", "stacked", "ok"),
  signal("sig-push", "Push reminders", "habit", "ok"),
];
const SIGNALS_OK = SIGNALS_FAILING.map((s) =>
  signal(s.id, s.name, s.project, "ok"),
);

const INCIDENTS_KEY = unstable_serialize(
  apiSWRKey.incidents("all", undefined, RECENTLY_FIXED_MS),
);
const SIGNALS_KEY = unstable_serialize(apiSWRKey.incidentSignals());

const ALL_INCIDENTS = [INC.needsYou, INC.veto, INC.investigating, INC.fixed];

/** Seeds the incident list and the signal list both the Incidents tool's dot
 *  and the incidents band read, and keeps SWR off the network. */
function IncidentData({
  incidents = ALL_INCIDENTS,
  signals = SIGNALS_FAILING,
  children,
}: {
  incidents?: IncidentSummary[];
  signals?: SignalView[];
  children: React.ReactNode;
}) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: { [INCIDENTS_KEY]: incidents, [SIGNALS_KEY]: signals },
        isPaused: () => true,
        revalidateOnMount: false,
        revalidateIfStale: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}

function Incidents({
  open = true,
  activeId = null,
}: {
  open?: boolean;
  activeId?: string | null;
}) {
  return (
    <IncidentsBand
      open={open}
      onToggleBand={noop}
      activeId={activeId}
      onOpenIncident={noop}
      onOpenAll={noop}
    />
  );
}

/** The tool strip folds behind a More row below a 640px-tall window. The
 *  harness renders taller, so this answers that one query as matched. */
let forceShort = false;
if (typeof window !== "undefined") {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((q: string) =>
    forceShort && q === SHORT_QUERY
      ? ({
          matches: true,
          media: q,
          onchange: null,
          addEventListener: noop,
          removeEventListener: noop,
          addListener: noop,
          removeListener: noop,
          dispatchEvent: () => false,
        } as unknown as MediaQueryList)
      : real(q)) as typeof window.matchMedia;
}
function ShortWindow({ children }: { children: React.ReactNode }) {
  forceShort = true;
  return <>{children}</>;
}

/* ── Hidden list ───────────────────────────────────────────────────────────────────────── */

const HIDDEN: HiddenListEntry[] = [
  {
    kind: "row",
    key: "ws:w-onboarding",
    title: "Onboarding copy pass",
    repo: "habit",
    sessionId: "s-onboarding",
    hiddenAt: ago(25),
  },
  {
    kind: "repo",
    key: "repo:stacked",
    repo: "stacked",
    hiddenAt: ago(60 * 5),
  },
  {
    kind: "row",
    key: "ws:w-seatmap",
    title: "Seat map for ICE coaches",
    repo: "betterbahn",
    sessionId: "s-seatmap",
    hiddenAt: ago(60 * 26),
  },
];

function Hidden({
  entries = HIDDEN,
  isPhone = false,
}: {
  entries?: HiddenListEntry[];
  isPhone?: boolean;
}) {
  return (
    <HiddenEntry
      entries={entries}
      isPhone={isPhone}
      onOpenEntry={noop}
      onRestore={noop}
    />
  );
}

/** Sidebar's footer: Archived, then Hidden while anything is hidden. */
function Footer({
  archivedActive = false,
  hidden = HIDDEN,
  isPhone = false,
}: {
  archivedActive?: boolean;
  hidden?: HiddenListEntry[];
  isPhone?: boolean;
}) {
  return (
    <div
      className={cn(SIDEBAR_INDEPENDENT_SECTION, SIDEBAR_GROUP, "mt-1")}
      style={{ order: 99 }}
    >
      {toolsModel({ archivedActive, isPhone }).archivedLink}
      <Hidden entries={hidden} isPhone={isPhone} />
    </div>
  );
}

function Chrome({
  isPhone = false,
  workspacesOpen = true,
  filterOpen = false,
  active = null,
  team = TEAM,
  shown,
  afterTools,
}: {
  isPhone?: boolean;
  workspacesOpen?: boolean;
  filterOpen?: boolean;
  active?: SidebarToolId | null;
  team?: TeamMember[];
  shown?: SidebarToolId[];
  afterTools?: React.ReactNode;
}) {
  const headRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLElement>(null);
  const actionsRef = React.useRef<HTMLDivElement>(null);
  const probeRef = React.useRef<HTMLSpanElement>(null);
  const model = toolsModel({ active, isPhone, shown });
  return (
    <SidebarChrome
      state={{
        density: "default",
        connected: true,
        isPhone,
        borrowedLens: false,
        workspacesOpen,
        repoInline: false,
        filterOpen,
        newSessionKeys: ["⌘", "S"],
      }}
      tools={{
        tools: model.visibleTools,
        menuTools: model.sidebarMenuTools,
        team,
        onSetToolVisible: noop,
        afterTools,
      }}
      identity={{
        filter: getFilter(),
        currentUser: ME,
        personLensName: ME,
        repos: REPOS,
      }}
      refs={{ headRef, titleRef, actionsRef, probeRef, setFilterButton: noop }}
      actions={{
        navigation: NAV,
        setFilterOpen: noop,
        onToggleWorkspaces: noop,
      }}
    />
  );
}

/** Generic forcer for non-row parts. */
function Force({
  children,
  force,
  className,
}: {
  children: React.ReactNode;
  force?: Array<[string, string]>;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    for (const [sel, attr] of force ?? [])
      ref.current
        ?.querySelectorAll(sel)
        .forEach((el) => el.setAttribute(attr, ""));
  });
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** Opens a Base UI trigger after mount by replaying the gesture it listens to. */
function OpenOnMount({
  sel,
  children,
  event = "click",
  className,
}: {
  sel: string;
  children: React.ReactNode;
  className?: string;
  /** click: a menu's mousedown; press: a real click (popovers, toggles). */
  event?: "click" | "contextmenu" | "press";
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const t = setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>(sel);
      if (!el) return;
      if (event === "press") {
        el.click();
        // Drop the focus the popup's initialFocus hands its first row, so the
        // capture shows it at rest rather than keyboard-highlighted.
        setTimeout(
          () => (document.activeElement as HTMLElement | null)?.blur(),
          120,
        );
        return;
      }
      el.dispatchEvent(
        event === "contextmenu"
          ? new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              // Where a right-click on the trigger would land, so the menu
              // opens beside it rather than at the page's corner.
              clientX: el.getBoundingClientRect().left + 24,
              clientY: el.getBoundingClientRect().top + 12,
            })
          : new MouseEvent("mousedown", {
              bubbles: true,
              cancelable: true,
              button: 0,
            }),
      );
    }, 120);
    return () => clearTimeout(t);
  }, [sel, event]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/* ── Project bands ───────────────────────────────────────────────────────── */

const isDraftRow = (row: WsRow) =>
  !!row.workspace?.draft && row.sessions.length === 0;

/** Active-section drag at rest: no manual order, nothing lifted. */
const DRAG: ActiveRowDrag = {
  order: [],
  draft: null,
  dragKey: null,
  pointerDrag: true,
  onReorder: noop,
  onDragStart: noop,
  onDragEnd: noop,
  onClickCapture: noop,
  registerLift: () => noop,
};

function band(
  repo: string,
  rows: WsRow[],
  urgent = 0,
  snoozedRows: WsRow[] = [],
): SidebarProjectBand {
  return {
    repo,
    rows,
    snoozedRows,
    needsReviewRows: [],
    approvedRows: [],
    awaitingReviewRows: [],
    prs: [],
    requestedPrs: [],
    urgent,
  };
}

function Bands({
  bands,
  closed = [],
  selectedKey = null,
  groupBy = "inbox",
  isPhone = false,
  hiddenRepos = [],
}: {
  bands: SidebarProjectBand[];
  closed?: string[];
  selectedKey?: string | null;
  groupBy?: "inbox" | "activity" | "status";
  isPhone?: boolean;
  hiddenRepos?: string[];
}) {
  const isOpen = (key: string) => !closed.includes(key);
  const renderRow = (row: WsRow, inbox = false) => (
    <Row
      key={row.key}
      row={row}
      o={{
        active: row.key === selectedKey,
        isDraft: isDraftRow(row),
        inbox,
        isPhone,
      }}
    />
  );
  const r = createWorkspaceGroupingRenderers({
    groupBy,
    pinDragMeta: null,
    laneDropHover: null,
    activeDrag: DRAG,
    isOpen,
    onToggleGroup: noop,
    ownsSelection: (row) => row.key === selectedKey,
    prRowSelected: () => false,
    prItemLane: () => "pending",
    isDraft: isDraftRow,
    renderWorkspaceRow: (row) => renderRow(row),
    renderWorkspaceRowImpl: (row, inbox) => renderRow(row, inbox),
    renderPrRow: () => null,
  });
  const order = bands.map((b) => b.repo);
  return (
    <ProjectBands
      projects={{
        scratchRows: [],
        scratchSnoozedRows: [],
        bands,
        order,
        fullOrder: order,
        canReorder: false,
      }}
      askBand={ASK_BAND}
      borrowedLens={false}
      isOpen={isOpen}
      onToggleGroup={noop}
      onOpenNewSessionInRepo={noop}
      hiddenRepos={new Set(hiddenRepos)}
      onSetRepoHidden={noop}
      renderers={{
        workspaceGrouping: r.renderWorkspaceGrouping,
        labeledLane: r.renderLabeledLane,
        workspaceRow: (row) => renderRow(row),
        reviewWorkspaceRow: (row) => renderRow(row),
        prRow: () => null,
      }}
      selection={{
        workspaceRow: (row) => row.key === selectedKey,
        prRow: () => false,
      }}
      drag={{
        repoKey: null,
        move: noop,
        start: noop,
        finish: noop,
        swallowClick: noop,
      }}
    />
  );
}

function Lanes({
  rows,
  groupBy,
  closed = [],
  snoozed = [],
}: {
  rows: WsRow[];
  groupBy: "inbox" | "activity" | "status";
  closed?: string[];
  snoozed?: WsRow[];
}) {
  const isOpen = (key: string) => !closed.includes(key);
  const renderRow = (row: WsRow, inbox = false) => (
    <Row
      key={row.key}
      row={row}
      o={{ isDraft: isDraftRow(row), inbox, timePreference: "always" }}
    />
  );
  const r = createWorkspaceGroupingRenderers({
    groupBy,
    pinDragMeta: null,
    laneDropHover: null,
    activeDrag: DRAG,
    isOpen,
    onToggleGroup: noop,
    ownsSelection: () => false,
    prRowSelected: () => false,
    prItemLane: () => "pending",
    isDraft: isDraftRow,
    renderWorkspaceRow: (row) => renderRow(row),
    renderWorkspaceRowImpl: (row, inbox) => renderRow(row, inbox),
    renderPrRow: () => null,
  });
  return <>{r.renderWorkspaceGrouping(rows, "", snoozed)}</>;
}

/* Fixture rows for the composition. Numbers add up: habit 4, franking 3,
   betterbahn 2 collapsed, stacked 2 collapsed with 1 waiting; 2 unread rows
   feed Catch up. */
const R = {
  passkey: wsRow({
    name: "Passkey sign-in",
    status: "needsinput",
    unread: true,
    createdAt: ago(200),
    sessions: [
      sess({
        title: "Passkey sign-in",
        waitingForInput: true,
        branch: "feat/passkey-sign-in",
        createdAt: ago(200),
      } as Partial<UnifiedSession>),
    ],
  }),
  wallet: wsRow({
    name: "Wallet pass redesign",
    status: "review",
    createdAt: ago(190),
    sessions: [
      sess({
        title: "Wallet pass redesign",
        createdAt: ago(190),
        ...PR(471, {
          prChecks: { total: 9, passed: 9, failed: 0, pending: 0 },
        }),
      }),
    ],
  }),
  watch: wsRow({
    name: "Habit reminders on Apple Watch",
    running: true,
    status: "inprogress",
    createdAt: ago(60),
    sessions: [
      sess({
        title: "Habit reminders on Apple Watch",
        isRunning: true,
        runStartedAt: ago(18),
        branch: "feat/watch-reminders",
        createdAt: ago(60),
      }),
    ],
  }),
  streak: { ...ROWS[6][1], createdAt: ago(20) },
  payouts: wsRow({
    name: "Reconcile September Stripe payouts",
    unread: true,
    status: "review",
    createdAt: ago(400),
    sessions: [
      sess({
        title: "Reconcile September Stripe payouts",
        repo: "franking",
        branch: "fix/stripe-payouts-sept",
        createdAt: ago(400),
        ...PR(482, {
          prChecks: { total: 9, passed: 9, failed: 0, pending: 0 },
        }),
      }),
    ],
  }),
  export: wsRow({
    name: "Export worker memory spike",
    createdAt: ago(300),
    sessions: [
      sess({
        title: "Export worker memory spike",
        repo: "franking",
        branch: "fix/export-worker-memory",
        createdAt: ago(300),
        lastRunError: { message: "Usage limit reached", at: ago(12) },
      } as Partial<UnifiedSession>),
    ],
  }),
  labels: wsRow({
    name: "Postage label batch print",
    createdAt: ago(100),
    sessions: [
      sess({
        title: "Postage label batch print",
        repo: "franking",
        branch: "feat/batch-labels",
        createdAt: ago(100),
        ...PR(503, { prIsDraft: true }),
      }),
    ],
  }),
  departures: wsRow({
    name: "Departure board offline cache",
    status: "merged",
    sessions: [
      sess({
        title: "Departure board offline cache",
        repo: "betterbahn",
        ...PR(96, { prState: "MERGED" }),
      }),
    ],
  }),
  delays: wsRow({
    name: "Delay alerts for connecting trains",
    sessions: [
      sess({
        title: "Delay alerts for connecting trains",
        repo: "betterbahn",
        ...PR(97, { prReviewDecision: "CHANGES_REQUESTED" }),
      }),
    ],
  }),
  previews: wsRow({
    name: "Deploy previews per branch",
    status: "needsinput",
    sessions: [
      sess({
        title: "Deploy previews per branch",
        repo: "stacked",
        waitingForInput: true,
      } as Partial<UnifiedSession>),
    ],
  }),
  caddy: wsRow({
    name: "Bump Caddy to 2.9",
    sessions: [
      sess({ title: "Bump Caddy to 2.9", repo: "stacked", branch: "main" }),
    ],
  }),
};

const BANDS: SidebarProjectBand[] = [
  band("habit", [R.passkey, R.wallet, R.watch, R.streak]),
  band("franking", [R.payouts, R.export, R.labels]),
  band("betterbahn", [R.departures, R.delays]),
  band("stacked", [R.previews, R.caddy], 1),
];
const CLOSED = ["repo:betterbahn", "repo:stacked"];

/* ── Footer, update, usage, unread ───────────────────────────────────────── */

const fakeSocket = (by: string | null) => (handler: (msg: never) => void) => {
  handler({ type: "frontend_updated", ...(by ? { by } : {}) } as never);
  return noop;
};

/** UpdatePill's entrance keyframe is paused by the harness at frame 0; the
 *  specimen shows its settled state. */
const SETTLED = "[&_*]:animate-none";

function usage(ctx: number, window = 200_000, cost = 4.82, turns = 14) {
  return {
    costUsd: cost,
    contextWindow: window,
    contextTokens: ctx,
    inputTokens: 18_400,
    outputTokens: 42_900,
    cacheReadTokens: 1_240_000,
    cacheCreationTokens: 96_300,
    turns,
  } as unknown as Parameters<typeof UsageMeter>[0]["usage"];
}

const UNREAD = [
  {
    id: "s-u1",
    title: "Wire up the WebAuthn ceremony",
    workspace: "Passkey sign-in",
    repo: "habit",
  },
  {
    id: "s-u2",
    title: "Reconcile September Stripe payouts",
    workspace: "Reconcile September Stripe payouts",
    repo: "franking",
  },
];

/* ── Hover cards ─────────────────────────────────────────────────────────── */

const PR_ITEM: ReviewQueueItem = {
  pr: {
    repo: "habit",
    branch: "feat/wallet-pass",
    url: "https://github.com/acme/habit/pull/471",
    number: 471,
    title: "Wallet pass redesign",
    isDraft: false,
    reviewDecision: "APPROVED",
    author: "kacper",
    person: "kacper",
    createdAt: ago(60 * 26),
    updatedAt: ago(35),
    checks: { total: 9, passed: 9, failed: 0, pending: 0 },
    reviewRequested: ["maya"],
  },
  sessionId: "s-wallet",
  source: "mine",
  bucket: "ready",
  status: "Approved",
};

const PR_ITEM_FAILING: ReviewQueueItem = {
  ...PR_ITEM,
  pr: {
    ...PR_ITEM.pr,
    number: 97,
    repo: "betterbahn",
    branch: "feat/connection-alerts",
    title: "Delay alerts for connecting trains",
    reviewDecision: "CHANGES_REQUESTED",
    checks: { total: 6, passed: 4, failed: 2, pending: 0 },
    url: "https://github.com/acme/betterbahn/pull/97",
  },
  bucket: "attention",
  status: "2 checks failing",
};

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: 340, height: 360 }}>
      <Popover.Root open modal={false}>
        <Popover.Trigger
          render={<span style={{ display: "block", width: 1, height: 1 }} />}
        />
        <RowCardPopup>
          <div className="spec-card">{children}</div>
        </RowCardPopup>
      </Popover.Root>
    </div>
  );
}
const CARD_SEL = ".spec-card";

/* ── Full sidebar ────────────────────────────────────────────────────────── */

const PINNED_ROW = wsRow({
  name: "Streak analytics dashboard",
  status: "review",
  sessions: [
    sess({
      title: "Streak analytics dashboard",
      branch: "feat/streak-dashboard",
      ...PR(486),
    }),
  ],
});

function Pinned({ isPhone = false }: { isPhone?: boolean }) {
  return (
    <PersonalBand
      needsReview={null}
      approved={null}
      awaitingReview={null}
      pinned={{
        entries: [
          {
            key: PINNED_ROW.key,
            pinKeys: [PINNED_ROW.key],
            repo: "habit",
            sessions: PINNED_ROW.sessions,
            node: (
              <Row
                row={PINNED_ROW}
                o={{ pinned: true, isPhone, inbox: true }}
              />
            ),
          },
        ],
        open: true,
        canDrag: false,
        dragKey: null,
        onToggle: noop,
        onReorder: noop,
        onEntryDragStart: noop,
        onEntryDrag: noop,
        onEntryDragEnd: noop,
        onEntryClickCapture: noop,
      }}
      projects={
        <Bands
          bands={BANDS}
          closed={CLOSED}
          selectedKey={R.wallet.key}
          isPhone={isPhone}
        />
      }
      autoCreatedRows={0}
      autoCreatedHidden={false}
      onToggleAutoCreated={noop}
    />
  );
}

/** AppSidebar's column and Sidebar's two halves: the fixed chrome (org row,
 *  tools, Workspaces heading) above the scroll that holds the bands. */
function FullSidebar({
  isPhone = false,
  height,
}: {
  isPhone?: boolean;
  height?: number;
}) {
  return (
    <IncidentData>
      <div
        className={cn(
          "sidebar-container flex min-h-0 shrink-0 flex-col bg-sidebar [--sidebar-icon-left:16px]",
          "desktop:[background:linear-gradient(var(--sidebar-material),var(--sidebar-material)),var(--sidebar-bg)]",
          isPhone ? "w-full" : "relative w-[var(--sidebar-w,280px)]",
        )}
        style={{ "--sidebar-w": "280px", height } as React.CSSProperties}
      >
        <div
          className={cn(
            "sidebar-brand wco-chrome h-[var(--desktop-header-h)] min-w-0 shrink-0 items-center justify-start gap-2 py-0 pr-3 pl-[calc(var(--sidebar-icon-left)-8px)]",
            isPhone ? "hidden" : "flex",
          )}
        >
          <div className="sidebar-brand-actions flex shrink-0 items-center gap-2">
            <Tooltip label="Hide sidebar" side="bottom">
              <button
                className={cn(
                  SIDEBAR_CHROME_BTN,
                  "inline-flex px-[5px] py-[3px]",
                )}
                aria-label="Hide sidebar"
              >
                <IconSidebarLeft size={24} />
              </button>
            </Tooltip>
          </div>
          <div className="@container/server-health flex min-w-0 flex-1 items-center justify-center" />
          <TitleBar onSearch={noop} />
        </div>
        {!isPhone && <Chrome afterTools={<Incidents />} />}
        <div
          data-density="default"
          className={cn(
            "flex w-full min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            SIDEBAR_DENSITY_VARS,
            SIDEBAR_NAV_X,
            "desktop:scroll-pt-[var(--sidebar-cap-h)]",
            isPhone &&
              "pt-[var(--header-h)] pb-[max(24px,env(safe-area-inset-bottom,0px))] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_var(--header-h))] [mask-image:linear-gradient(to_bottom,transparent_0,#000_var(--header-h))]",
          )}
        >
          {isPhone && <Chrome isPhone afterTools={<Incidents />} />}
          <div className="block max-w-full min-w-0 flex-none">
            <div
              className={cn(SIDEBAR_LIST, "desktop:[--sidebar-band-slot:0px]")}
              data-sidebar-list
            >
              <Pinned isPhone={isPhone} />
            </div>
          </div>
          <Footer isPhone={isPhone} />
        </div>
        {!isPhone && (
          <SidebarAccountFooter
            onOpenSettings={noop}
            accessory={
              <span className={SETTLED}>
                <UpdatePill
                  variant="footer"
                  addHandler={fakeSocket("Kacper") as never}
                />
              </span>
            }
          />
        )}
      </div>
    </IncidentData>
  );
}

/* ── Sections ─────────────────────────────────────────────────────────────── */

const TOOL_IDS: Array<[SidebarToolId, string]> = [
  ["feed", "feed"],
  ["prs", "pull requests"],
  ["incidents", "incidents · failing"],
  ["plain", "support"],
];

type IncidentFixture = { incidents: IncidentSummary[]; signals: SignalView[] };
const DOT: Record<string, IncidentFixture> = {
  failing: { incidents: ALL_INCIDENTS, signals: SIGNALS_FAILING },
  "needs you": { incidents: [INC.needsYou], signals: SIGNALS_OK },
  "all ok": { incidents: [], signals: SIGNALS_OK },
};

/** One tool row out of the real strip. Child 1 is the organization row. */
function toolRowSpec(
  i: number,
  id: SidebarToolId,
  label: string,
  state: RowState,
  isPhone = false,
  data: IncidentFixture = DOT.failing!,
): Specimen {
  const nth = `nav > :nth-child(${i + 2})`;
  return {
    name: `${isPhone ? "phone · " : ""}${label} · ${state}`,
    width: isPhone ? 390 : 280,
    viewport: isPhone ? 390 : undefined,
    select: `[data-spec] ${nth}`,
    node: (
      <IncidentData incidents={data.incidents} signals={data.signals}>
        <Surface
          list={false}
          force={state === "hover" ? [[nth, "data-force-hover"]] : undefined}
        >
          <Chrome
            team={[]}
            active={state === "selected" ? id : null}
            isPhone={isPhone}
          />
        </Surface>
      </IncidentData>
    ),
  };
}

/** The More row a short window folds the strip behind. Five tools, so two
 *  fold (Tasks with its count, and Support). */
const FOLD_TOOLS: SidebarToolId[] = [
  "feed",
  "prs",
  "incidents",
  "tasks",
  "plain",
];
const MORE = "nav > button[aria-expanded]";
function moreSpec(state: "default" | "hover" | "unfolded"): Specimen {
  const chrome = (
    <ShortWindow>
      <IncidentData>
        <Surface
          list={false}
          force={state === "hover" ? [[MORE, "data-force-hover"]] : undefined}
        >
          <Chrome team={[]} shown={FOLD_TOOLS} />
        </Surface>
      </IncidentData>
    </ShortWindow>
  );
  return {
    name: state === "unfolded" ? "less · unfolded" : `more · folded · ${state}`,
    width: 280,
    select: state === "unfolded" ? "[data-spec] nav" : `[data-spec] ${MORE}`,
    node:
      state === "unfolded" ? (
        <OpenOnMount sel={MORE} event="press" className="w-full">
          {chrome}
        </OpenOnMount>
      ) : (
        chrome
      ),
  };
}

const chromeSections: Section[] = [
  {
    group: "Sidebar",
    title: "Desktop",
    specimens: [
      {
        name: "sidebar · desktop · session selected",
        width: 280,
        node: <FullSidebar height={960} />,
      },
    ],
  },
  {
    group: "Sidebar",
    title: "Phone",
    specimens: [
      {
        name: "sidebar · phone · root page",
        width: 390,
        viewport: 390,
        node: <FullSidebar isPhone height={844} />,
      },
    ],
  },
  {
    group: "Sidebar header",
    title: "Desktop",
    specimens: [
      {
        name: "header · default",
        width: 280,
        node: (
          <Surface list={false}>
            <Chrome />
          </Surface>
        ),
      },
      {
        name: "header · feed selected",
        width: 280,
        node: (
          <Surface list={false}>
            <Chrome active="feed" />
          </Surface>
        ),
      },
      {
        name: "header · with incidents band",
        width: 280,
        node: (
          <IncidentData>
            <Surface list={false}>
              <Chrome afterTools={<Incidents />} />
            </Surface>
          </IncidentData>
        ),
      },
      {
        name: "header · workspace options hover",
        width: 280,
        node: (
          <Surface
            list={false}
            force={[['[aria-label="Workspace options"]', "data-force-hover"]]}
          >
            <Chrome />
          </Surface>
        ),
      },
      {
        name: "header · workspaces collapsed",
        width: 280,
        node: (
          <Surface list={false}>
            <Chrome workspacesOpen={false} />
          </Surface>
        ),
      },
      {
        name: "header · filter open",
        width: 280,
        node: (
          <Surface list={false}>
            <Chrome filterOpen />
          </Surface>
        ),
      },
      {
        name: "header · heading hover",
        width: 280,
        node: (
          <Surface
            list={false}
            force={[
              [".group\\/wshead", "data-force-hover"],
              [".group\\/wstoggle", "data-force-hover"],
            ]}
          >
            <Chrome />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Sidebar header",
    title: "Phone",
    specimens: [
      {
        name: "phone · default",
        width: 390,
        viewport: 390,
        node: (
          <Surface list={false}>
            <Chrome isPhone />
          </Surface>
        ),
      },
      {
        name: "phone · with incidents band",
        width: 390,
        viewport: 390,
        node: (
          <IncidentData>
            <Surface list={false}>
              <Chrome isPhone afterTools={<Incidents />} />
            </Surface>
          </IncidentData>
        ),
      },
    ],
  },
  {
    group: "Sidebar tool row",
    title: "States",
    specimens: TOOL_IDS.flatMap(([id, label], i) =>
      STATES.map((st) => toolRowSpec(i, id, label, st)),
    ),
  },
  {
    group: "Sidebar tool row",
    title: "Incidents status",
    specimens: Object.entries(DOT).flatMap(([label, data]) =>
      (["default", "hover"] as RowState[]).map((st) =>
        toolRowSpec(2, "incidents", `incidents · ${label}`, st, false, data),
      ),
    ),
  },
  {
    group: "Sidebar tool row",
    title: "Short window",
    specimens: [moreSpec("default"), moreSpec("hover"), moreSpec("unfolded")],
  },
  {
    group: "Sidebar tool row",
    title: "Phone",
    specimens: [
      toolRowSpec(0, "feed", "feed", "default", true),
      toolRowSpec(0, "feed", "feed", "selected", true),
      toolRowSpec(1, "incidents", "incidents · failing", "default", true),
      toolRowSpec(3, "catchup", "catch up · count", "default", true),
      toolRowSpec(3, "catchup", "catch up · count", "selected", true),
    ],
  },
  {
    group: "Sidebar tool row",
    title: "Feed with team",
    specimens: [
      {
        name: "feed · team faces · default",
        width: 280,
        select: "[data-spec] nav > :nth-child(2)",
        node: (
          <Surface list={false}>
            <Chrome />
          </Surface>
        ),
      },
      {
        name: "feed · team faces · hover",
        width: 280,
        select: "[data-spec] nav > :nth-child(2)",
        node: (
          <Surface
            list={false}
            force={[
              ["nav > :nth-child(2)", "data-force-hover"],
              ["nav > :nth-child(2) > button", "data-force-hover"],
            ]}
          >
            <Chrome />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Organization switcher",
    title: "Sidebar row",
    specimens: [
      {
        name: "row · connected · default",
        width: 280,
        node: (
          <Surface list={false}>
            <div className="px-[var(--sidebar-nav-x)]">
              <OrganizationSwitcher connected onOpenSettings={noop} />
            </div>
          </Surface>
        ),
      },
      {
        name: "row · connected · hover",
        width: 280,
        node: (
          <Surface list={false} force={[["button", "data-force-hover"]]}>
            <div className="px-[var(--sidebar-nav-x)]">
              <OrganizationSwitcher connected onOpenSettings={noop} />
            </div>
          </Surface>
        ),
      },
      {
        name: "row · reconnecting · default",
        width: 280,
        node: (
          <Surface list={false}>
            <div className="px-[var(--sidebar-nav-x)]">
              <OrganizationSwitcher connected={false} onOpenSettings={noop} />
            </div>
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Organization switcher",
    title: "Menu",
    specimens: [
      {
        name: "menu · open",
        select: '[role="menu"]',
        node: (
          <div style={{ width: 320, height: 420 }}>
            <OpenOnMount sel="button">
              <Surface list={false}>
                <div className="px-[var(--sidebar-nav-x)]">
                  <OrganizationSwitcher connected onOpenSettings={noop} />
                </div>
              </Surface>
            </OpenOnMount>
          </div>
        ),
      },
    ],
  },
  {
    group: "Organization switcher",
    title: "Phone top bar",
    specimens: [
      {
        name: "topbar · connected",
        viewport: 390,
        node: (
          <div className="p-1">
            <OrganizationSwitcher
              variant="topbar"
              connected
              onOpenSettings={noop}
            />
          </div>
        ),
      },
      {
        name: "topbar · reconnecting",
        viewport: 390,
        node: (
          <div className="p-1">
            <OrganizationSwitcher
              variant="topbar"
              connected={false}
              onOpenSettings={noop}
            />
          </div>
        ),
      },
    ],
  },
  {
    group: "Project band",
    title: "Header",
    specimens: [
      {
        name: "header · collapsed · default",
        width: 280,
        node: (
          <Surface>
            <Bands
              bands={[band("habit", [R.passkey, R.wallet, R.watch, R.streak])]}
              closed={["repo:habit"]}
            />
          </Surface>
        ),
      },
      {
        name: "header · collapsed · hover",
        width: 280,
        node: (
          <Surface force={[["[data-sticky-head]", "data-force-hover"]]}>
            <Bands
              bands={[band("habit", [R.passkey, R.wallet, R.watch, R.streak])]}
              closed={["repo:habit"]}
            />
          </Surface>
        ),
      },
      {
        name: "header · collapsed · waiting on you",
        width: 280,
        node: (
          <Surface>
            <Bands
              bands={[band("stacked", [R.previews, R.caddy], 1)]}
              closed={["repo:stacked"]}
            />
          </Surface>
        ),
      },
      {
        name: "header · collapsed · selected row kept",
        width: 280,
        node: (
          <Surface>
            <Bands
              bands={[band("franking", [R.payouts, R.export, R.labels])]}
              closed={["repo:franking"]}
              selectedKey={R.payouts.key}
            />
          </Surface>
        ),
      },
      {
        name: "header · ask band · collapsed",
        width: 280,
        node: (
          <Surface>
            <Bands
              bands={[
                band(ASK_BAND, [
                  wsRow({
                    name: "How does the export worker batch?",
                    sessions: [
                      sess({
                        title: "How does the export worker batch?",
                        repo: undefined,
                        branch: null,
                        repoLess: true,
                      }),
                    ],
                  }),
                ]),
              ]}
              closed={[`repo:${ASK_BAND}`]}
            />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Project band",
    title: "Expanded",
    specimens: [
      {
        name: "band · expanded · inbox",
        width: 280,
        node: (
          <Surface>
            <Bands
              bands={[band("habit", [R.passkey, R.wallet, R.watch, R.streak])]}
              selectedKey={R.wallet.key}
            />
          </Surface>
        ),
      },
      {
        name: "band · expanded · with snoozed",
        width: 280,
        node: (
          <Surface>
            <Bands
              bands={[
                band("franking", [R.payouts, R.export, R.labels], 0, [
                  wsRow({
                    name: "VAT report for Q3",
                    sessions: [
                      sess({
                        title: "VAT report for Q3",
                        repo: "franking",
                        branch: "feat/vat-q3",
                      }),
                    ],
                  }),
                ]),
              ]}
            />
          </Surface>
        ),
      },
      {
        name: "band · phone · expanded",
        width: 390,
        viewport: 390,
        node: (
          <Surface>
            <Bands
              bands={[band("habit", [R.passkey, R.wallet, R.watch, R.streak])]}
              selectedKey={R.wallet.key}
              isPhone
            />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Project band",
    title: "Header menu",
    specimens: [
      {
        name: "menu · hide repository",
        select: '[role="menu"]',
        node: (
          <div style={{ width: 320, height: 160 }}>
            <OpenOnMount sel="[data-sticky-head]" event="contextmenu">
              <Surface>
                <Bands
                  bands={[band("habit", [R.passkey, R.wallet])]}
                  closed={["repo:habit"]}
                />
              </Surface>
            </OpenOnMount>
          </div>
        ),
      },
      {
        name: "menu · restore repository",
        select: '[role="menu"]',
        node: (
          <div style={{ width: 320, height: 160 }}>
            <OpenOnMount sel="[data-sticky-head]" event="contextmenu">
              <Surface>
                <Bands
                  bands={[band("stacked", [R.previews], 1)]}
                  closed={["repo:stacked"]}
                  hiddenRepos={["stacked"]}
                />
              </Surface>
            </OpenOnMount>
          </div>
        ),
      },
    ],
  },
  {
    group: "Incidents band",
    title: "States",
    specimens: [
      {
        name: "band · open incidents · expanded",
        width: 280,
        node: (
          <IncidentData>
            <Surface list={false}>
              <Incidents />
            </Surface>
          </IncidentData>
        ),
      },
      {
        name: "band · open incidents · incident selected",
        width: 280,
        node: (
          <IncidentData>
            <Surface list={false}>
              <Incidents activeId={INC.veto.id} />
            </Surface>
          </IncidentData>
        ),
      },
      {
        name: "band · open incidents · collapsed",
        width: 280,
        node: (
          <IncidentData>
            <Surface list={false}>
              <Incidents open={false} />
            </Surface>
          </IncidentData>
        ),
      },
      {
        name: "band · open incidents · heading hover",
        width: 280,
        node: (
          <IncidentData>
            <Surface
              list={false}
              force={[
                [".group\\/band", "data-force-hover"],
                [".group\\/band > button:first-child", "data-force-hover"],
              ]}
            >
              <Incidents />
            </Surface>
          </IncidentData>
        ),
      },
      {
        name: "band · recently fixed · expanded",
        width: 280,
        node: (
          <IncidentData incidents={[INC.fixed]} signals={SIGNALS_OK}>
            <Surface list={false}>
              <Incidents />
            </Surface>
          </IncidentData>
        ),
      },
      {
        name: "band · phone · expanded",
        width: 390,
        viewport: 390,
        node: (
          <IncidentData>
            <Surface list={false}>
              <Incidents />
            </Surface>
          </IncidentData>
        ),
      },
    ],
  },
  {
    group: "Incident row",
    title: "States",
    specimens: [
      ...STATES.map((st) => incidentSpec("needs you", st, INC.needsYou)),
      ...STATES.map((st) => incidentSpec("veto", st, INC.veto)),
      incidentSpec("investigating", "default", INC.investigating),
      incidentSpec("fixed", "default", INC.fixed),
      incidentSpec("fixed", "hover", INC.fixed),
      incidentSpec(
        "long title",
        "default",
        incident({
          id: "inc-long",
          title: "Departure search returns no trains for every station",
          state: "needs-you",
        }),
      ),
      incidentSpec("phone · needs you", "default", INC.needsYou, true),
    ],
  },
  {
    group: "Hidden row",
    title: "Row",
    specimens: [
      ...(["default", "hover"] as RowState[]).map((st) => ({
        name: `hidden · three items · ${st}`,
        width: 280,
        node: (
          <Surface
            list={false}
            force={
              st === "hover"
                ? [['[aria-label^="Hidden"]', "data-force-hover"]]
                : undefined
            }
          >
            <Footer />
          </Surface>
        ),
      })),
      {
        name: "hidden · one item · default",
        width: 280,
        node: (
          <Surface list={false}>
            <Footer hidden={HIDDEN.slice(0, 1)} />
          </Surface>
        ),
      },
      {
        name: "hidden · phone · default",
        width: 390,
        viewport: 390,
        node: (
          <Surface list={false}>
            <Footer isPhone />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Hidden row",
    title: "List",
    specimens: [
      {
        name: "list · popover · open",
        select: '[role="dialog"]',
        node: (
          <div style={{ width: 720, height: 360 }}>
            <OpenOnMount sel='[aria-label^="Hidden"]' event="press">
              <div style={{ width: 280, paddingTop: 260 }}>
                <Surface list={false}>
                  <Footer />
                </Surface>
              </div>
            </OpenOnMount>
          </div>
        ),
      },
      {
        name: "list · phone sheet · open",
        viewport: 390,
        // The sheet itself, not the scrim behind it.
        select: '[role="dialog"] > div:last-child',
        node: (
          <OpenOnMount sel='[aria-label^="Hidden"]' event="press">
            <div style={{ width: 390 }}>
              <Surface list={false}>
                <Footer isPhone />
              </Surface>
            </div>
          </OpenOnMount>
        ),
      },
    ],
  },
  {
    group: "Lane header",
    title: "Activity",
    specimens: [
      {
        name: "lanes · activity · expanded",
        width: 280,
        node: (
          <Surface>
            <Lanes
              groupBy="activity"
              rows={[
                R.watch,
                R.passkey,
                { ...R.wallet, lastActivity: ago(42) },
                { ...R.payouts, lastActivity: ago(60 * 26) },
              ]}
            />
          </Surface>
        ),
      },
      {
        name: "lanes · activity · collapsed",
        width: 280,
        node: (
          <Surface>
            <Lanes
              groupBy="activity"
              rows={[R.watch, R.passkey]}
              closed={["inbox:inprogress", "inbox:needsaction"]}
            />
          </Surface>
        ),
      },
      {
        name: "lanes · activity · hover",
        width: 280,
        node: (
          <Surface force={[["[data-sticky-head]", "data-force-hover"]]}>
            <Lanes groupBy="activity" rows={[R.watch]} />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Lane header",
    title: "Status",
    specimens: [
      {
        name: "lanes · status · expanded",
        width: 280,
        node: (
          <Surface>
            <Lanes
              groupBy="status"
              rows={[R.passkey, R.watch, R.wallet, R.labels, R.departures]}
              snoozed={[ROWS[13][1]]}
            />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Draft row",
    title: "States",
    specimens: [
      {
        name: "draft · default",
        width: 280,
        node: (
          <Surface>
            <ClearDraft />
            <DraftRow active={false} onClick={noop} />
          </Surface>
        ),
      },
      {
        name: "draft · hover",
        width: 280,
        node: (
          <Surface force={HOVER}>
            <ClearDraft />
            <DraftRow active={false} onClick={noop} />
          </Surface>
        ),
      },
      {
        name: "draft · selected",
        width: 280,
        node: (
          <Surface>
            <ClearDraft />
            <DraftRow active onClick={noop} />
          </Surface>
        ),
      },
      {
        name: "draft · with unsent text",
        width: 280,
        node: (
          <Surface>
            <SetDraft />
            <DraftRow active onClick={noop} />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Archived row",
    title: "States",
    specimens: (["default", "hover", "selected"] as RowState[]).map((st) => ({
      name: `archived · ${st}`,
      width: 280,
      node: (
        <Surface
          list={false}
          force={st === "hover" ? [["button", "data-force-hover"]] : undefined}
        >
          <div
            className={cn(SIDEBAR_INDEPENDENT_SECTION, SIDEBAR_GROUP, "mt-1")}
          >
            {toolsModel({ archivedActive: st === "selected" }).archivedLink}
          </div>
        </Surface>
      ),
    })),
  },
  {
    group: "Account footer",
    title: "States",
    specimens: [
      {
        name: "footer · default",
        width: 280,
        node: (
          <Surface list={false} className="py-0">
            <SidebarAccountFooter onOpenSettings={noop} />
          </Surface>
        ),
      },
      {
        name: "footer · with update",
        width: 280,
        node: (
          <Surface list={false} className="py-0">
            <SidebarAccountFooter
              onOpenSettings={noop}
              accessory={
                <span className={SETTLED}>
                  <UpdatePill
                    variant="footer"
                    addHandler={fakeSocket("Kacper") as never}
                  />
                </span>
              }
            />
          </Surface>
        ),
      },
      {
        name: "footer · settings hover",
        width: 280,
        node: (
          <Surface
            list={false}
            className="py-0"
            force={[['[aria-label="Settings"]', "data-force-hover"]]}
          >
            <SidebarAccountFooter onOpenSettings={noop} />
          </Surface>
        ),
      },
    ],
  },
  {
    group: "Update pill",
    title: "Variants",
    specimens: [
      {
        name: "footer · default",
        node: (
          <div className={cn(SETTLED, "p-1")}>
            <UpdatePill
              variant="footer"
              addHandler={fakeSocket("Kacper") as never}
            />
          </div>
        ),
      },
      {
        name: "footer · hover",
        node: (
          <Force
            className={cn(SETTLED, "p-1")}
            force={[["button", "data-force-hover"]]}
          >
            <UpdatePill
              variant="footer"
              addHandler={fakeSocket("Kacper") as never}
            />
          </Force>
        ),
      },
      {
        name: "pill · default",
        viewport: 390,
        node: (
          <div className={cn(SETTLED, "p-1")}>
            <UpdatePill
              variant="pill"
              addHandler={fakeSocket("Kacper") as never}
            />
          </div>
        ),
      },
      {
        name: "card · new update",
        width: 360,
        node: (
          <div className={cn(SETTLED, "w-full")}>
            <UpdatePill
              variant="card"
              addHandler={fakeSocket("Kacper") as never}
            />
          </div>
        ),
      },
      {
        name: "card · no author",
        width: 360,
        node: (
          <div className={cn(SETTLED, "w-full")}>
            <UpdatePill variant="card" addHandler={fakeSocket(null) as never} />
          </div>
        ),
      },
    ],
  },
  {
    group: "Usage meter",
    title: "States",
    specimens: [
      {
        name: "meter · default",
        node: (
          <div className="p-1">
            <UsageMeter usage={usage(86_000)} />
          </div>
        ),
      },
      {
        name: "meter · hover",
        node: (
          <Force className="p-1" force={[["button", "data-force-hover"]]}>
            <UsageMeter usage={usage(86_000)} />
          </Force>
        ),
      },
      {
        name: "meter · nearly full",
        node: (
          <div className="p-1">
            <UsageMeter usage={usage(178_000, 200_000, 12.4, 41)} />
          </div>
        ),
      },
      {
        name: "meter · with cache rate",
        node: (
          <div className="p-1">
            <UsageMeter usage={usage(86_000)} showCacheRate />
          </div>
        ),
      },
      {
        name: "details · open",
        select: ".spec-pop",
        node: (
          <div
            style={{
              width: 300,
              height: 260,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "flex-end",
            }}
          >
            <Popover.Root open modal={false}>
              <Popover.Trigger
                render={
                  <span style={{ display: "block", width: 1, height: 1 }} />
                }
              />
              <Popover.Popup
                side="top"
                align="end"
                className="spec-pop w-64 p-3 text-xs"
              >
                <UsageDetails usage={usage(86_000)} />
              </Popover.Popup>
            </Popover.Root>
          </div>
        ),
      },
    ],
  },
  {
    group: "Next unread button",
    title: "States",
    specimens: [
      {
        name: "next · two unread",
        width: 520,
        node: (
          <NavProvider value={{ unreadChats: UNREAD }}>
            <div className="flex w-full justify-center">
              <NextUnreadButton />
            </div>
          </NavProvider>
        ),
      },
      {
        name: "next · hover",
        width: 520,
        node: (
          <NavProvider value={{ unreadChats: UNREAD }}>
            <Force
              className="flex w-full justify-center"
              force={[["button", "data-force-hover"]]}
            >
              <NextUnreadButton />
            </Force>
          </NavProvider>
        ),
      },
      {
        name: "next · all read",
        width: 520,
        node: (
          <NavProvider value={{ unreadChats: [], allChatsRead: true }}>
            <div className="flex w-full justify-center">
              <NextUnreadButton />
            </div>
          </NavProvider>
        ),
      },
      {
        name: "next · chooser open",
        select: '[aria-label="Unread sessions"]',
        node: (
          <NavProvider value={{ unreadChats: UNREAD }}>
            <div
              style={{
                width: 520,
                height: 260,
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
              }}
            >
              <OpenOnMount sel="button" event="contextmenu">
                <NextUnreadButton />
              </OpenOnMount>
            </div>
          </NavProvider>
        ),
      },
      {
        name: "next · phone",
        width: 390,
        viewport: 390,
        node: (
          <NavProvider value={{ unreadChats: UNREAD }}>
            <div className="flex w-full justify-center">
              <NextUnreadButton phone />
            </div>
          </NavProvider>
        ),
      },
    ],
  },
  {
    group: "Row hover card",
    title: "Cards",
    specimens: [
      {
        name: "card · pull request · ready",
        select: `:has(> ${CARD_SEL})`,
        node: (
          <Card>
            <PrRowCard item={PR_ITEM} />
          </Card>
        ),
      },
      {
        name: "card · pull request · failing",
        select: `:has(> ${CARD_SEL})`,
        node: (
          <Card>
            <PrRowCard item={PR_ITEM_FAILING} />
          </Card>
        ),
      },
      {
        name: "card · session · running",
        select: `:has(> ${CARD_SEL})`,
        node: (
          <Card>
            <SessionCardBody
              session={sess({
                title: "Habit reminders on Apple Watch",
                isRunning: true,
                runStartedAt: ago(18),
                startedBy: ME,
                prAdditions: 86,
                prDeletions: 12,
                ...PR(488, {
                  prChecks: { total: 9, passed: 7, failed: 0, pending: 2 },
                }),
              })}
            />
          </Card>
        ),
      },
      {
        name: "card · session · needs input",
        select: `:has(> ${CARD_SEL})`,
        node: (
          <Card>
            <SessionCardBody
              session={sess({
                title: "Passkey sign-in",
                waitingForInput: true,
                startedBy: ME,
              } as Partial<UnifiedSession>)}
            />
          </Card>
        ),
      },
      {
        name: "card · session · loop",
        select: `:has(> ${CARD_SEL})`,
        node: (
          <Card>
            <SessionCardBody
              session={sess({
                title: "Watch the export queue",
                isRunning: true,
                runStartedAt: ago(3),
                startedBy: ME,
                repo: "franking",
                loop: {
                  prompt: "Check the export queue depth and report changes",
                  intervalMinutes: 10,
                  until: new Date(NOW + 2 * 3600_000).toISOString(),
                },
              })}
            />
          </Card>
        ),
      },
      {
        name: "card · support ticket",
        select: `:has(> ${CARD_SEL})`,
        node: (
          <Card>
            <SupportRowCard
              thread={{
                id: "th_01",
                title: "Charged twice for the yearly plan",
                previewText:
                  "Hi, I see two charges of 49 euros on my card from the 3rd. Can you refund one of them?",
                status: "todo",
                statusChangedAt: ago(25),
                createdAt: ago(90),
                priority: 1,
                labels: [
                  { id: "l_1", typeId: "lt_1", name: "Billing", icon: null },
                ],
                customer: { name: "Lena Hoffmann", email: "lena@example.test" },
                assignee: { id: "u_1", name: "Maya Lindqvist", isBot: false },
              }}
              session={null}
            />
          </Card>
        ),
      },
    ],
  },
];

function incidentSpec(
  label: string,
  state: RowState,
  inc: IncidentSummary,
  isPhone = false,
): Specimen {
  return {
    name: `${label} · ${state}`,
    width: isPhone ? 390 : 280,
    viewport: isPhone ? 390 : undefined,
    node: (
      <Surface list={false} force={state === "hover" ? HOVER : undefined}>
        <div className={SIDEBAR_INDEPENDENT_SECTION}>
          <div className={SIDEBAR_INDEPENDENT_SCROLL}>
            <IncidentRow
              incident={inc}
              headline={inc.title}
              facts={[]}
              active={state === "selected"}
              onOpen={noop}
            />
          </div>
        </div>
      </Surface>
    ),
  };
}

function ClearDraft() {
  try {
    sessionStorage.removeItem("backstage-draft:new-session");
  } catch {}
  return null;
}
function SetDraft() {
  try {
    sessionStorage.setItem(
      "backstage-draft:new-session",
      JSON.stringify({ text: "Add a weekly summary email" }),
    );
  } catch {}
  return null;
}

export const sections: Section[] = [...chromeSections, ...rowSections];

export const descriptions: Record<string, string> = {
  Sidebar:
    "components/AppSidebar.tsx + Sidebar.tsx · the left column on desktop and the root page on phones",
  "Sidebar header":
    "components/sidebar/SidebarChrome.tsx · the fixed top of the sidebar: organization, tools, the incidents band and the Workspaces heading",
  "Incidents band":
    "components/sidebar/IncidentsBand.tsx · open incidents by urgency, then recent fixes, first under the tools",
  "Incident row":
    "components/sidebar/IncidentRow.tsx · one incident in the band: project tile, title and its state in words",
  "Hidden row":
    "components/sidebar/HiddenEntry.tsx · the quiet Hidden row under Archived and the list of what you hid, each with Restore",
  "Sidebar tool row":
    "components/sidebar/SidebarToolsNav.tsx · a destination above the work lists, like Feed or Incidents, and the More row a short window folds the rest behind",
  "Organization switcher":
    "components/OrganizationSwitcher.tsx · the active organization and its menu, first row of the sidebar",
  "Project band":
    "components/sidebar/ProjectBands.tsx · one repository's workspaces, collapsible under its tile and count, hidden from its right-click menu",
  "Lane header":
    "components/sidebar/sidebar-workspace-renderers.tsx · the caption over a run of rows grouped by activity or status",
  "Session row":
    "components/sidebar/WorkspaceRow.tsx · one workspace in the sidebar list, its status in the rail, its live meta at the right edge and its optional color wash",
  "Draft row":
    "components/sidebar/DraftRow.tsx · the not-yet-started session that stands in for an empty list",
  "Archived row":
    "components/sidebar/sidebar-tools-model.tsx · the last row of the sidebar, opening archived sessions",
  "Account footer":
    "components/sidebar/SidebarAccountFooter.tsx · who you are and Settings, pinned to the bottom of the desktop sidebar",
  "Update pill":
    "components/UpdatePill.tsx · the nudge to refresh after a new build, in the footer, the phone top bar or as a card",
  "Usage meter":
    "components/UsageMeter.tsx · the session's spend and context fill, with a breakdown on hover",
  "Next unread button":
    "components/NextUnreadButton.tsx · the flap above the composer that jumps to the next unread session",
  "Row hover card":
    "components/SidebarRowCards.tsx · the detail card a sidebar row raises after a short hover",
};
