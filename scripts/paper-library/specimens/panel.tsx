import * as React from "react";
import {
  SWRConfig,
  unstable_serialize,
} from "../../../packages/core/opensession-server/node_modules/swr";
import { PrStatusBar } from "../../../packages/core/opensession-server/src/frontend/components/PrStatusBar";
import { PrSeriesRows } from "../../../packages/core/opensession-server/src/frontend/components/PrSeriesRows";
import { PrChecksPopover } from "../../../packages/core/opensession-server/src/frontend/components/PrChecksPopover";
import { CheckStatusIcon } from "../../../packages/core/opensession-server/src/frontend/components/CheckStatusIcon";
import { PlainStatusBadge } from "../../../packages/core/opensession-server/src/frontend/components/PlainStatusBadge";
import { SandboxBadge } from "../../../packages/core/opensession-server/src/frontend/components/SandboxBadge";
import { SessionRelations } from "../../../packages/core/opensession-server/src/frontend/components/SessionRelations";
import { PrRow } from "../../../packages/core/opensession-server/src/frontend/components/PrRow";
import {
  WorkspaceSummary,
  WorkspaceSummaryBody,
} from "../../../packages/core/opensession-server/src/frontend/components/WorkspaceSummary";
import { SidePanelHost } from "../../../packages/core/opensession-server/src/frontend/components/session/SidePanelHost";
import { SessionSearch } from "../../../packages/core/opensession-server/src/frontend/components/SessionSearch";
import { buildAppCommandActions } from "../../../packages/core/opensession-server/src/frontend/components/app-command-actions";
import { ReviewRail } from "../../../packages/core/opensession-server/src/frontend/components/pr/ReviewRail";
import {
  ReviewerRow,
  FileRow,
} from "../../../packages/core/opensession-server/src/frontend/components/pr/PrRows";
import { CheckRow } from "../../../packages/core/opensession-server/src/frontend/components/pr/CheckRow";
import { GitStatusRows } from "../../../packages/core/opensession-server/src/frontend/components/pr/GitStatus";
import { PrStateIcon } from "../../../packages/core/opensession-server/src/frontend/components/pr/PrStateIcon";
import { PrCard } from "../../../packages/core/opensession-server/src/frontend/components/pr/PrCard";
import { NotificationBell } from "../../../packages/core/opensession-server/src/frontend/components/notifications/NotificationBell";
import { NotificationRow } from "../../../packages/core/opensession-server/src/frontend/components/notifications/NotificationRow";
import { NotificationList } from "../../../packages/core/opensession-server/src/frontend/components/notifications/NotificationList";
import { InboxPage } from "../../../packages/core/opensession-server/src/frontend/components/notifications/InboxPage";
import { InboxBarButton } from "../../../packages/core/opensession-server/src/frontend/components/notifications/InboxBarButton";
import { UpdatePill } from "../../../packages/core/opensession-server/src/frontend/components/UpdatePill";
import { apiSWRKey } from "../../../packages/core/opensession-server/src/frontend/lib/api-swr";
import { providerFromUrl } from "../../../packages/core/opensession-server/src/frontend/lib/provider";
import {
  checkClass,
  isDeployment,
  summarize,
} from "../../../packages/core/opensession-server/src/frontend/lib/pr-status-derive";
import { startNotifications } from "../../../packages/core/opensession-server/src/frontend/lib/notifications";
import { INBOX_LIST } from "../../../packages/core/opensession-server/src/frontend/lib/inbox-classes";
import {
  INFO_CONTENT,
  INFO_SUMMARY_CARD,
} from "../../../packages/core/opensession-server/src/frontend/lib/session-viewer-classes";
import type {
  GitStatusInfo,
  PrCheck,
  PrDetails,
  SessionPrRef,
} from "../../../packages/core/opensession-server/src/frontend/lib/types";
import type { OpenPr } from "../../../packages/core/opensession-server/src/frontend/lib/api";
import type { Section } from "../entry";

const noop = () => {};
const REPO = "acme/habit";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/* ── API stubs ────────────────────────────────────────────────────────
   The people roster, notification inbox, open PRs, transcript search and
   sandbox status are module-level fetches. Answer only those paths so the
   real components hydrate without a server; everything else passes through. */

const PEOPLE = [
  { name: "Kacper", fullName: "Kacper Kwapisz" },
  { name: "Mila", fullName: "Mila Novak" },
  { name: "Jonas", fullName: "Jonas Weber" },
  { name: "Priya", fullName: "Priya Raman" },
];

const minAgo = (m: number) => Date.now() - m * 60_000;
const THREADS = [
  {
    id: "n1",
    kind: "review_requested",
    unread: true,
    done: false,
    updatedAt: minAgo(4),
    subject: {
      type: "pr",
      id: "482",
      title: "Wallet pass redesign",
      context: "habit #482",
    },
    reason: "Mila asked you to review",
    body: "",
    url: "/s/s-wallet",
    actor: "Mila",
  },
  {
    id: "n2",
    kind: "mention",
    unread: true,
    done: false,
    updatedAt: minAgo(26),
    subject: {
      type: "session",
      id: "s-export",
      title: "Export worker memory spike",
      context: "stacked",
    },
    reason: "Jonas mentioned you",
    body: "can you check the heap snapshot before we ship?",
    url: "/s/s-export",
    actor: "Jonas",
  },
  {
    id: "n3",
    kind: "review_done",
    unread: false,
    done: false,
    updatedAt: minAgo(95),
    subject: {
      type: "pr",
      id: "1207",
      title: "Passkey sign-in",
      context: "betterbahn #1207",
    },
    reason: "Priya approved your pull request",
    body: "",
    url: "/s/s-passkey",
    actor: "Priya",
  },
  {
    id: "n4",
    kind: "collaborator",
    unread: false,
    done: false,
    updatedAt: minAgo(60 * 5),
    subject: {
      type: "workspace",
      id: "w-payouts",
      title: "Reconcile September Stripe payouts",
      context: "franking",
    },
    reason: "Mila added you to a workspace",
    body: "",
    url: "/w/w-payouts",
    actor: "Mila",
  },
  {
    id: "n5",
    kind: "reminder",
    unread: false,
    done: false,
    updatedAt: minAgo(60 * 26),
    subject: {
      type: "reminder",
      id: "r1",
      title: "Follow up on the Stripe dispute",
      context: "Reminder",
    },
    reason: "Reminder",
    body: "",
    url: "/s/s-payouts",
  },
  {
    id: "n6",
    kind: "incident_needs_you",
    unread: true,
    done: false,
    updatedAt: minAgo(2),
    subject: {
      type: "incident",
      id: "inc-search",
      title: "Departure search",
      context: "betterbahn",
    },
    reason: "Departure search is down",
    body: "The agent needs you to approve rolling back the 12:04 deploy before it can continue",
    url: "/incidents/inc-search",
  },
  {
    id: "n7",
    kind: "team_review_requested",
    unread: false,
    done: false,
    updatedAt: minAgo(70),
    subject: {
      type: "pr",
      id: "318",
      title: "Cap export worker batch size",
      context: "stacked #318",
    },
    reason: "Jonas asked Payments to review",
    body: "",
    url: "/s/s-export",
    actor: "Jonas",
  },
  {
    id: "n8",
    kind: "comment",
    unread: true,
    done: false,
    updatedAt: minAgo(12),
    subject: {
      type: "pr",
      id: "482",
      title: "Wallet pass redesign",
      context: "habit #482",
    },
    reason: "Mila commented",
    body: "the dark pass needs more contrast on the barcode",
    url: "/s/s-wallet",
    actor: "Mila",
  },
  {
    id: "n9",
    kind: "incident_resolved",
    unread: false,
    done: false,
    updatedAt: minAgo(95),
    subject: {
      type: "incident",
      id: "inc-push",
      title: "Push reminders",
      context: "habit",
    },
    reason: "Push reminders works again",
    body: "Fixed by the agent, down for 1 h 25 min",
    url: "/incidents/inc-push",
  },
  {
    id: "n10",
    kind: "support_needs_you",
    unread: true,
    done: false,
    updatedAt: minAgo(8),
    subject: {
      type: "support",
      id: "th_01",
      title: "A support reply is ready",
      context: "Lena Hoffmann",
    },
    reason: "Refunds over 40 euros wait for you",
    body: "",
    url: "/support/th_01",
  },
];

const OPEN_PRS: OpenPr[] = [
  {
    repo: "acme/habit",
    branch: "feat/wallet-pass",
    url: "https://github.com/acme/habit/pull/482",
    number: 482,
    title: "Wallet pass redesign",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    author: "kacper",
    person: "kacper",
    createdAt: ago(60 * 20),
    updatedAt: ago(12),
    checks: { total: 4, passed: 4, failed: 0, pending: 0 },
    mergeable: "MERGEABLE",
  },
  {
    repo: "acme/betterbahn",
    branch: "feat/passkeys",
    url: "https://github.com/acme/betterbahn/pull/1207",
    number: 1207,
    title: "Passkey sign-in",
    isDraft: false,
    reviewDecision: "APPROVED",
    author: "priya",
    person: "priya",
    createdAt: ago(60 * 48),
    updatedAt: ago(40),
    checks: { total: 6, passed: 6, failed: 0, pending: 0 },
    mergeable: "MERGEABLE",
  },
  {
    repo: "acme/stacked",
    branch: "fix/export-worker-heap",
    url: "https://github.com/acme/stacked/pull/318",
    number: 318,
    title: "Cap export worker batch size",
    isDraft: false,
    reviewDecision: "",
    author: "jonas",
    person: "jonas",
    createdAt: ago(60 * 3),
    updatedAt: ago(9),
    checks: { total: 5, passed: 3, failed: 0, pending: 2 },
    mergeable: "MERGEABLE",
  },
];

const SANDBOX_STATUS: Record<string, unknown> = {
  "sb-awake": {
    enabled: true,
    provider: "daytona",
    sandboxId: "dt-81f2",
    status: "running",
    lifecycle: "awake",
    cwd: "/workspace/habit",
    canPause: true,
    canDesktop: true,
    agentConnected: true,
    sleepsAt: new Date(Date.now() + 12 * 60_000).toISOString(),
    checkpoint: {
      at: ago(14),
      commit: "9c4e1a7b2d3f",
      branch: "feat/wallet-pass",
    },
  },
  "sb-sleeping": {
    enabled: true,
    provider: "daytona",
    sandboxId: "dt-81f2",
    status: "stopped",
    lifecycle: "sleeping",
    cwd: "/workspace/habit",
    canResume: true,
    checkpoint: {
      at: ago(60 * 3),
      commit: "9c4e1a7b2d3f",
      branch: "feat/wallet-pass",
    },
  },
  "sb-preparing": {
    enabled: true,
    provider: "daytona",
    status: "starting",
    lifecycle: "preparing",
    lifecycleNote: "Cloning acme/habit and installing dependencies",
  },
  "sb-error": {
    enabled: true,
    provider: "daytona",
    sandboxId: "dt-81f2",
    status: "gone",
    lifecycle: "needs_attention",
    canResume: true,
    lastLifecycleError: "The sandbox stopped responding during setup.",
  },
};

const json = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
if (typeof window !== "undefined" && !(window as any).__panelFetchStub) {
  (window as any).__panelFetchStub = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (/\/api\/people(\?|$)/.test(url))
      return json({
        people: PEOPLE,
        reviewTeams: [
          {
            name: "Payments",
            github: "acme/payments",
            members: ["Mila", "Jonas"],
          },
        ],
      });
    if (/\/api\/notifications\?/.test(url))
      return json({
        threads: THREADS,
        alerts: {
          reviews: true,
          mentions: true,
          collaborators: true,
          reminders: true,
        },
      });
    if (/\/api\/open-prs(\?|$)/.test(url)) return json({ prs: OPEN_PRS });
    if (/\/api\/sessions\/search\?/.test(url))
      return json({
        matches: /heap/.test(decodeURIComponent(url))
          ? [
              {
                id: "p3",
                snippet:
                  "…can you check the heap snapshot before we ship? It grows by 40 MB per batch…",
              },
              {
                id: "p1",
                snippet:
                  "…the pass renderer keeps every image in the heap until the page closes…",
              },
            ]
          : [],
      });
    const sb = url.match(/\/api\/sessions\/([^/]+)\/sandbox$/);
    if (sb)
      return json(
        SANDBOX_STATUS[decodeURIComponent(sb[1]!)] ??
          SANDBOX_STATUS["sb-awake"],
      );
    return realFetch(input as any, init);
  }) as typeof fetch;
}

/** Hydrates the inbox store through its real loader. It loads for the signed-in
 *  person, so name one for the duration of the call and put the key back. */
let notificationsBooted = false;
function bootNotifications() {
  if (notificationsBooted) return;
  notificationsBooted = true;
  const KEY = "opensession-user";
  const prev = localStorage.getItem(KEY);
  localStorage.setItem(KEY, "Kacper");
  startNotifications(noop);
  if (prev === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, prev);
}
const Inbox = ({ children }: { children: React.ReactNode }) => {
  React.useState(bootNotifications);
  return <>{children}</>;
};

/* ── PR mock data ─────────────────────────────────────────────────────── */

const check = (
  name: string,
  conclusion: "SUCCESS" | "FAILURE" | "PENDING" | "SKIPPED",
  workflowName: string | undefined = "CI",
  mins = 3,
): PrCheck => ({
  name,
  workflowName,
  status: conclusion === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
  conclusion: conclusion === "PENDING" ? "" : conclusion,
  url: "https://github.com/acme/habit/actions/runs/9821",
  startedAt: ago(mins + 2),
  completedAt: conclusion === "PENDING" ? undefined : ago(2),
});

const CHECKS_PASS = [
  check("typecheck", "SUCCESS", "CI", 1),
  check("unit tests", "SUCCESS"),
  check("e2e", "SUCCESS", "CI", 6),
  check("Vercel – habit-web", "SUCCESS", undefined, 2),
];
const CHECKS_RUNNING = [
  check("typecheck", "SUCCESS", "CI", 1),
  check("unit tests", "SUCCESS"),
  check("e2e", "PENDING"),
  check("Vercel – habit-web", "PENDING", undefined),
];
const CHECKS_FAILED = [
  check("typecheck", "SUCCESS", "CI", 1),
  check("unit tests", "FAILURE"),
  check("e2e", "SUCCESS", "CI", 6),
  check("Vercel – habit-web", "SUCCESS", undefined, 2),
];

const FILES = [
  { path: "apps/web/src/wallet/PassCard.tsx", additions: 54, deletions: 8 },
  { path: "apps/web/src/wallet/pass-theme.ts", additions: 24, deletions: 4 },
  { path: "apps/web/src/wallet/PassCard.test.tsx", additions: 8, deletions: 0 },
];

function pr(over: Partial<PrDetails> = {}): PrDetails {
  return {
    number: 482,
    title: "Wallet pass redesign",
    url: "https://github.com/acme/habit/pull/482",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/wallet-pass",
    headRefOid: "a1b2c3d4e5f6",
    additions: 86,
    deletions: 12,
    changedFiles: 3,
    reviewDecision: "REVIEW_REQUIRED",
    author: "kacper",
    body: "",
    checks: CHECKS_PASS,
    mergeable: "MERGEABLE",
    files: FILES,
    reviewers: [],
    commits: [
      {
        oid: "9c4e1a7b2d3f",
        messageHeadline: "Redraw the pass card for dark wallets",
        author: "Kacper",
        authoredDate: ago(80),
      },
      {
        oid: "3f8d0e21ab47",
        messageHeadline: "Add pass theme tokens",
        author: "Kacper",
        authoredDate: ago(60),
      },
      {
        oid: "b71c55e09a2e",
        messageHeadline: "Cover the pass card with snapshot tests",
        author: "Kacper",
        authoredDate: ago(30),
      },
    ],
    ...over,
  };
}

const STACK = {
  number: 12,
  baseRefName: "main",
  size: 3,
  position: 2,
  layers: [
    {
      number: 480,
      title: "Wallet pass data model",
      url: "https://github.com/acme/habit/pull/480",
      state: "MERGED" as const,
      isDraft: false,
      headRefName: "feat/wallet-model",
      baseRefName: "main",
      position: 1,
    },
    {
      number: 482,
      title: "Wallet pass redesign",
      url: "https://github.com/acme/habit/pull/482",
      state: "OPEN" as const,
      isDraft: false,
      headRefName: "feat/wallet-pass",
      baseRefName: "feat/wallet-model",
      position: 2,
      current: true,
    },
    {
      number: 485,
      title: "Wallet pass share sheet",
      url: "https://github.com/acme/habit/pull/485",
      state: "OPEN" as const,
      isDraft: true,
      headRefName: "feat/wallet-share",
      baseRefName: "feat/wallet-pass",
      position: 3,
    },
  ],
};

const GIT_CLEAN: GitStatusInfo = {
  branch: "feat/wallet-pass",
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  behindBase: 0,
  baseBranch: "main",
  uncommittedFiles: 0,
};

/* ── SWR seeding ──────────────────────────────────────────────────────── */

type Data = {
  pr: PrDetails | null;
  git?: GitStatusInfo;
  assets?: { path: string; size: number; mtime: string }[];
  commits?: {
    repo: string;
    sha: string;
    title: string;
    committedAt: string;
    filesChanged: number;
    additions: number;
    deletions: number;
  }[];
  diff?: { files: { path: string; additions: number; deletions: number }[] };
};

/** Pre-seeds the SWR cache every PR/workspace hook reads, and pauses
 *  revalidation so nothing reaches for the network. */
function Seed({
  id,
  data,
  children,
}: {
  id: string;
  data: Data;
  children: React.ReactNode;
}) {
  const fallback: Record<string, unknown> = {
    [unstable_serialize(apiSWRKey.sessionPr(id, REPO, undefined))]: data.pr,
    [unstable_serialize(apiSWRKey.sessionGit(id, REPO))]: data.git ?? GIT_CLEAN,
    [unstable_serialize(apiSWRKey.sessionAssets(id))]: data.assets ?? [],
    [unstable_serialize(apiSWRKey.workspaceOverview(`sessions:${id}`))]: {
      prompt: null,
      media: [],
      commits: data.commits ?? [],
    },
  };
  if (data.diff) {
    const files = data.diff.files;
    fallback[unstable_serialize(apiSWRKey.sessionDiff(id))] = {
      repos: [
        {
          repo: REPO,
          diff: {
            files,
            totalAdditions: files.reduce((n, f) => n + f.additions, 0),
            totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
            rawPatch: "",
          },
        },
      ],
    };
  }
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback,
        isPaused: () => true,
        revalidateOnMount: false,
        revalidateIfStale: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}

const primaryRef = (p: PrDetails | null): SessionPrRef[] =>
  p
    ? [
        {
          repo: REPO,
          branch: p.headRefName,
          source: "primary",
          number: p.number,
          url: p.url,
          state: p.state,
          title: p.title,
        },
      ]
    : [];

let seq = 0;
const useId = () => React.useMemo(() => `s-${++seq}`, []);

/** WorkspaceSummaryBody lays its desktop groups out with `display: contents`,
 *  which the Paper serializer cannot see through (zero-size boxes are dropped).
 *  The groups sit in a flex column either way, so making them flex columns
 *  themselves paints the same boxes and gives the serializer something to walk. */
const FLATTEN = (
  <style>
    {
      ".ws-flatten .contents, [role=dialog] .contents { display: flex; flex-direction: column; }"
    }
  </style>
);

/** Clicks or types into the real component once it has mounted. */
function After({
  run,
  delay = 30,
  className = "flex w-full flex-col",
  children,
}: {
  run: (root: HTMLElement) => void;
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const t = setTimeout(() => ref.current && run(ref.current), delay);
    return () => clearTimeout(t);
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
const click =
  (sel: string, n = 0) =>
  (root: HTMLElement) =>
    root.querySelectorAll<HTMLElement>(sel)[n]?.click();
/** Open a popup, then drop the focus its `initialFocus` hands the first row, so
 *  the capture shows the popup at rest rather than keyboard-highlighted. */
const openAtRest = (sel: string) => (root: HTMLElement) => {
  root.querySelector<HTMLElement>(sel)?.click();
  setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 120);
};

/* ── PR status bar ────────────────────────────────────────────────────── */

function Bar({
  data,
  variant,
  refs,
  send = true,
}: {
  data: Data;
  variant: "header" | "summary";
  refs?: SessionPrRef[];
  send?: boolean;
}) {
  const id = useId();
  return (
    <Seed id={id} data={data}>
      <PrStatusBar
        sessionId={id}
        repo={REPO}
        prs={refs ?? primaryRef(data.pr)}
        variant={variant}
        send={send ? noop : undefined}
        onOpenPrTab={noop}
        onOpenChecksTab={noop}
        onOpenStackPr={noop}
        onArchive={noop}
      />
    </Seed>
  );
}

const SERIES: SessionPrRef[] = [
  {
    repo: "acme/habit-api",
    branch: "feat/wallet-pass",
    source: "attached",
    number: 91,
    url: "https://github.com/acme/habit-api/pull/91",
    state: "OPEN",
    title: "Pass signing endpoint",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    checks: { total: 3, passed: 3, failed: 0, pending: 0 },
  },
  {
    repo: "acme/habit-ios",
    branch: "feat/wallet-pass",
    source: "attached",
    number: 2204,
    url: "https://github.com/acme/habit-ios/pull/2204",
    state: "OPEN",
    title: "Add to Apple Wallet button",
    mergeable: "MERGEABLE",
    checks: { total: 5, passed: 4, failed: 1, pending: 0 },
  },
];

const BAR_STATES: [string, Data][] = [
  ["ready to merge", { pr: pr() }],
  ["approved", { pr: pr({ reviewDecision: "APPROVED" }) }],
  ["checks running", { pr: pr({ checks: CHECKS_RUNNING }) }],
  ["checks failed", { pr: pr({ checks: CHECKS_FAILED }) }],
  ["changes requested", { pr: pr({ reviewDecision: "CHANGES_REQUESTED" }) }],
  ["conflicts", { pr: pr({ mergeable: "CONFLICTING" }) }],
  ["draft", { pr: pr({ isDraft: true }) }],
  ["merged", { pr: pr({ state: "MERGED" }) }],
  ["ahead of remote", { pr: pr(), git: { ...GIT_CLEAN, ahead: 2 } }],
  ["no PR", { pr: null, git: { ...GIT_CLEAN, ahead: 3, uncommittedFiles: 2 } }],
];

/** The session header's actions row, which the chip and action ride in. */
const Header = ({ children }: { children: React.ReactNode }) => (
  <div className="viewer-header-actions flex items-center gap-1">
    {children}
  </div>
);

/** The workspace panel's column, which the summary band sits at the top of. */
const PanelColumn = ({ children }: { children: React.ReactNode }) => (
  <div className="viewer-panel flex w-full flex-col bg-panel-surface [--bg-panel:var(--panel-plate)] py-2">
    {children}
  </div>
);

/* ── Workspace summary ────────────────────────────────────────────────── */

type Scenario = {
  data: Data;
  refs?: SessionPrRef[];
  setupFailure?: {
    reason: "timed_out" | "failed" | "stopped";
    message: string;
    at: string;
  };
  prReviewRequested?: string[];
  reviewRequest?: { to: string; by: string; at: string };
};

const REVIEWERS = [
  { login: "mila-novak", state: "APPROVED" as const },
  { login: "jonas-weber", state: "COMMENTED" as const },
];

const SCENARIOS: Record<string, Scenario> = {
  "ready to merge": {
    data: {
      pr: pr({
        reviewDecision: "APPROVED",
        reviewers: REVIEWERS,
        osReview: {
          verdict: "approve",
          confidence: 4,
          risk: "low",
          findings: 0,
          blocking: 0,
          stale: false,
          at: ago(20),
        },
      }),
    },
  },
  "checks failed": {
    data: {
      pr: pr({
        checks: CHECKS_FAILED,
        reviewers: [
          { login: "mila-novak", state: "PENDING" },
          { login: "payments", state: "PENDING", isTeam: true },
        ],
        osReview: {
          verdict: "request_changes",
          confidence: 2,
          risk: "medium",
          findings: 3,
          blocking: 1,
          stale: false,
          at: ago(15),
        },
      }),
    },
    reviewRequest: { to: "Mila", by: "Kacper", at: ago(30) },
  },
  "changes requested": {
    data: {
      pr: pr({
        reviewDecision: "CHANGES_REQUESTED",
        reviewers: [{ login: "priya-raman", state: "CHANGES_REQUESTED" }],
        osReview: {
          verdict: "comment",
          confidence: 3,
          findings: 2,
          blocking: 0,
          stale: true,
          at: ago(90),
        },
      }),
    },
  },
  "checks running": {
    data: {
      pr: pr({ checks: CHECKS_RUNNING, reviewActive: true }),
      git: { ...GIT_CLEAN, uncommittedFiles: 2 },
    },
  },
  merged: {
    data: {
      pr: pr({
        state: "MERGED",
        reviewDecision: "APPROVED",
        reviewers: REVIEWERS,
      }),
    },
  },
  "no PR · uncommitted": {
    data: {
      pr: null,
      git: {
        ...GIT_CLEAN,
        branch: "feat/export-heap",
        ahead: 2,
        uncommittedFiles: 3,
      },
      commits: [
        {
          repo: REPO,
          sha: "4e2a9f10c3d7",
          title: "Stream export rows instead of buffering",
          committedAt: ago(40),
          filesChanged: 2,
          additions: 61,
          deletions: 23,
        },
        {
          repo: REPO,
          sha: "71bd3c08e5a2",
          title: "Cap export batch size at 500",
          committedAt: ago(18),
          filesChanged: 1,
          additions: 9,
          deletions: 2,
        },
      ],
      diff: {
        files: [
          { path: "workers/export/stream.ts", additions: 61, deletions: 23 },
          { path: "workers/export/config.ts", additions: 9, deletions: 2 },
        ],
      },
      assets: [
        { path: "reports/heap-before.md", size: 4200, mtime: ago(35) },
        { path: "reports/heap-after.md", size: 3900, mtime: ago(12) },
        { path: "data/export-timings.csv", size: 18000, mtime: ago(12) },
      ],
    },
  },
  "series of PRs": {
    data: { pr: pr({ reviewDecision: "APPROVED" }) },
    refs: [...primaryRef(pr()), ...SERIES],
  },
  "setup failed": {
    data: { pr: null, git: { ...GIT_CLEAN, ahead: 1 } },
    setupFailure: {
      reason: "timed_out",
      message: "Setup timed out after 10 minutes. Dependencies may be missing.",
      at: ago(4),
    },
  },
};

function sessionFor(id: string, s: Scenario, title = "Wallet pass redesign") {
  const p = s.data.pr;
  return {
    id,
    title,
    repo: REPO,
    branch: p?.headRefName ?? s.data.git?.branch ?? "feat/wallet-pass",
    prs: s.refs ?? primaryRef(p),
    createdAt: ago(60 * 3),
    lastActivity: ago(5),
    archived: false,
    setupFailure: s.setupFailure,
  } as any;
}

function Summary({
  scenario,
  embedded,
  expandChanges,
  title,
}: {
  scenario: keyof typeof SCENARIOS;
  embedded?: boolean;
  expandChanges?: boolean;
  title?: string;
}) {
  const id = useId();
  const s = SCENARIOS[scenario]!;
  const body = (
    <WorkspaceSummaryBody
      session={sessionFor(id, s, title)}
      embedded={embedded}
      onOpenPanelTab={noop}
      onOpenPr={noop}
      onOpenChecks={noop}
      onOpenAsset={noop}
      onOpenAssets={noop}
      onArchive={noop}
      reviewRequest={s.reviewRequest ?? null}
      prReviewRequested={s.prReviewRequested}
      send={noop}
      close={noop}
    />
  );
  return (
    <Seed id={id} data={s.data}>
      {body}
    </Seed>
  );
}

function SidePanel({
  scenario,
  expandChanges,
  title,
}: {
  scenario: keyof typeof SCENARIOS;
  expandChanges?: boolean;
  title?: string;
}) {
  return (
    <After
      className="ws-flatten flex w-full"
      run={
        expandChanges
          ? (root) =>
              [...root.querySelectorAll<HTMLElement>("section button")]
                .find((b) => /files? changed/.test(b.textContent || ""))
                ?.click()
          : noop
      }
    >
      {FLATTEN}
      <SidePanelHost
        hidden={false}
        isPhone={false}
        available
        open
        onOpenChange={noop}
        style={{ "--panel-w": "320px", height: 640 } as React.CSSProperties}
        resizeHandle={null}
        hasWorkspace
        page="changes"
        onPageChange={noop}
        livePortals={1}
        runningAgents={0}
        terminalMounted={false}
        onTerminalMount={noop}
        sessionId="s-panel"
        changes={
          <section
            aria-label="Workspace summary"
            className="flex flex-col border-b border-divider py-2"
          >
            <Summary
              scenario={scenario}
              expandChanges={expandChanges}
              title={title}
            />
          </section>
        }
        portals={null}
        agents={null}
      />
    </After>
  );
}

function SummaryCard({ scenario }: { scenario: keyof typeof SCENARIOS }) {
  const id = useId();
  const s = SCENARIOS[scenario]!;
  return (
    <div className="flex w-[340px] justify-end">
      {FLATTEN}
      <Seed id={id} data={s.data}>
        <WorkspaceSummary
          session={sessionFor(id, s)}
          onOpenPanelTab={noop}
          onOpenPr={noop}
          onOpenChecks={noop}
          onArchive={noop}
          reviewRequest={s.reviewRequest ?? null}
          send={noop}
          hasRoom
        />
      </Seed>
    </div>
  );
}

function PhoneSummary({
  scenario,
  sandbox,
}: {
  scenario: keyof typeof SCENARIOS;
  sandbox?: boolean;
}) {
  return (
    <div className={`w-full bg-surface ${INFO_CONTENT}`}>
      <div className={INFO_SUMMARY_CARD}>
        {sandbox && (
          <div className="flex min-h-11 items-center rounded-2xl bg-panel px-5 py-2">
            <SandboxBadge
              sessionId="sb-awake"
              sandbox={{
                provider: "daytona",
                sandboxId: "dt-81f2",
                lifecycle: "awake",
              }}
            />
          </div>
        )}
        <Summary scenario={scenario} embedded />
      </div>
    </div>
  );
}

/* ── Review rail (the PR panel's metadata column) ─────────────────────── */

function railSummary(checks: PrCheck[]) {
  const rank = (c: PrCheck) => {
    const cls = checkClass(c.status, c.conclusion);
    return cls === "check-failure"
      ? 0
      : cls === "check-pending"
        ? 1
        : cls === "check-success"
          ? 3
          : 2;
  };
  const sorted = [...checks].sort((a, b) => rank(a) - rank(b));
  return {
    ...summarize(checks),
    deployments: sorted.filter(isDeployment),
    checks: sorted.filter((c) => !isDeployment(c)),
  };
}

type Merge = NonNullable<Parameters<typeof GitStatusRows>[0]["merge"]>;
const MERGE_NOW: Merge = {
  primary: "merge",
  all: ["merge", "auto", "force"],
  onChoose: noop,
};
const MERGE_AUTO_ON: Merge = {
  primary: null,
  all: ["cancel-auto", "force"],
  onChoose: noop,
};
const AUTO_MERGE = { method: "squash" as const, enabledBy: "Kacper" };

function Rail({
  p,
  git = GIT_CLEAN,
  open,
  merging,
  merge,
  className = "w-[264px] shrink-0",
}: {
  p: PrDetails;
  git?: GitStatusInfo | null;
  open?: "checks" | "commits";
  merging?: boolean;
  merge?: Merge;
  className?: string;
}) {
  const rail = (
    <ReviewRail
      className={className}
      pr={p}
      git={git}
      sessionId="s-rail"
      repo={REPO}
      provider={providerFromUrl(p.url)}
      caps={{ checks: true, reviewers: true, commitNotes: false }}
      checkSummary={railSummary(p.checks)}
      send={noop}
      onRefresh={noop}
      onMerge={noop}
      merging={merging}
      merge={merge}
      onMarkReady={noop}
      onOpenFile={noop}
      onOpenFiles={noop}
      onStartSession={noop}
    />
  );
  if (!open) return rail;
  const label = open === "checks" ? "Checks" : "Commits";
  return (
    <After
      run={(root) => {
        const btns = [
          ...root.querySelectorAll<HTMLElement>("button[aria-expanded]"),
        ];
        btns
          .find(
            (b) =>
              b.closest("section")?.querySelector("h3")?.textContent === label,
          )
          ?.click();
      }}
    >
      {rail}
    </After>
  );
}

/* ── PR row (sidebar) ─────────────────────────────────────────────────── */

function prItem(
  over: Partial<OpenPr> = {},
  source: "mine" | "requested" | "automation" | "other" = "other",
) {
  const p = { ...OPEN_PRS[2]!, ...over };
  return {
    pr: p,
    sessionId: null,
    source,
    bucket: "waiting" as const,
    status: "",
  };
}

/* ── Command palette ──────────────────────────────────────────────────── */

const ACTIONS = buildAppCommandActions({
  currentSession: null,
  currentTheme: "light",
  copyLinkPath: null,
  isPhone: false,
  nextChatAvailable: false,
  openNextChat: noop,
  restorableArchived: [],
  sidebarCollapsed: false,
  navigate: noop,
  openPalette: noop,
  handleNewSession: noop,
  closeSession: noop,
  unarchiveSession: noop,
  reopenLastArchived: noop,
  setDeskOverlay: noop,
  toggleSidebarCollapsed: noop,
  showToast: noop,
} as any);

const PALETTE_SESSIONS = [
  {
    id: "p1",
    title: "Wallet pass redesign",
    repo: "acme/habit",
    branch: "feat/wallet-pass",
    startedBy: "Kacper",
    prState: "OPEN",
    lastActivity: ago(6),
    workspaceId: "w1",
    workspaceName: "Wallet pass redesign",
  },
  {
    id: "p2",
    title: "Passkey sign-in",
    repo: "acme/betterbahn",
    branch: "feat/passkeys",
    startedBy: "Priya",
    isRunning: true,
    lastActivity: ago(2),
    workspaceId: "w2",
    workspaceName: "Passkey sign-in",
  },
  {
    id: "p3",
    title: "Export worker memory spike",
    repo: "acme/stacked",
    branch: "fix/export-worker-heap",
    startedBy: "Jonas",
    waitingForInput: true,
    lastActivity: ago(14),
    workspaceId: "w3",
    workspaceName: "Export worker memory spike",
  },
  {
    id: "p4",
    title: "Reconcile September Stripe payouts",
    repo: "acme/franking",
    startedBy: "Mila",
    automation: "Monthly close",
    lastActivity: ago(60 * 3),
    workspaceId: "w4",
    workspaceName: "Reconcile September Stripe payouts",
  },
  {
    id: "p5",
    title: "Wallet pass share sheet",
    repo: "acme/habit",
    branch: "feat/wallet-share",
    startedBy: "Kacper",
    prState: "MERGED",
    lastActivity: ago(60 * 26),
    workspaceId: "w5",
    workspaceName: "Wallet pass share sheet",
  },
] as any[];

function setInput(root: HTMLElement, value: string) {
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input[role="combobox"]',
  );
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function arrowDown(times: number) {
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input[role="combobox"]',
  );
  for (let i = 0; i < times; i++)
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
}

/** The same actions with a session open, and the project list for the
 *  per-project settings rows. */
const SESSION_ACTIONS = buildAppCommandActions({
  currentSession: PALETTE_SESSIONS[0],
  currentTheme: "light",
  copyLinkPath: "/s/p1",
  isPhone: false,
  nextChatAvailable: false,
  openNextChat: noop,
  restorableArchived: [],
  sidebarCollapsed: false,
  navigate: noop,
  openPalette: noop,
  handleNewSession: noop,
  closeSession: noop,
  unarchiveSession: noop,
  reopenLastArchived: noop,
  setDeskOverlay: noop,
  toggleSidebarCollapsed: noop,
  showToast: noop,
  projects: [
    { id: "acme/habit", label: "habit" },
    { id: "acme/franking", label: "franking" },
  ],
} as any);

function Palette({
  query,
  down = 0,
  delay = 60,
  inSession = false,
}: {
  query?: string;
  down?: number;
  delay?: number;
  inSession?: boolean;
}) {
  return (
    <After
      delay={delay}
      run={(root) => {
        if (query) setInput(root, query);
        if (down) setTimeout(() => arrowDown(down), 40);
      }}
    >
      <SessionSearch
        sessions={PALETTE_SESSIONS}
        actions={inSession ? SESSION_ACTIONS : ACTIONS}
        onSelectSession={noop}
        onSelectPr={noop}
        onClose={noop}
      />
    </After>
  );
}

/* ── Notifications ────────────────────────────────────────────────────── */

const thread = (i: number, over: Record<string, unknown> = {}) =>
  ({ ...THREADS[i]!, ...over }) as any;

const InboxRows = ({ rows }: { rows: any[] }) => (
  <ul className={INBOX_LIST} aria-label="Notifications">
    {rows.map((t) => (
      <NotificationRow key={t.id} thread={t} />
    ))}
  </ul>
);

const MODELS = [
  {
    id: "claude-opus-4-5",
    provider: "claude",
    label: "Opus 4.5",
    aliases: [],
    efforts: [],
  },
  {
    id: "claude-sonnet-4-5",
    provider: "claude",
    label: "Sonnet 4.5",
    aliases: [],
    efforts: [],
  },
] as any[];

const WORKERS = [
  {
    id: "w1",
    title: "Trace export worker allocations",
    model: "claude-opus-4-5",
    isRunning: true,
  },
  { id: "w2", title: "Write heap regression test", model: "claude-sonnet-4-5" },
  { id: "w3", title: "Draft the incident summary", model: "claude-sonnet-4-5" },
];

/* ── Sections ─────────────────────────────────────────────────────────── */

const W = 320;

export const sections: Section[] = [
  {
    group: "PR status",
    title: "Session header (panel closed)",
    specimens: [
      ...BAR_STATES.filter(([state]) => state !== "no PR").map(
        ([state, data]) => ({
          name: `header · ${state}`,
          node: (
            <Header>
              <Bar data={data} variant="header" />
            </Header>
          ),
        }),
      ),
      {
        name: "header · stack · ready to merge",
        node: (
          <Header>
            <Bar data={{ pr: pr({ stack: STACK }) }} variant="header" />
          </Header>
        ),
      },
      {
        name: "header · series · ready to merge",
        node: (
          <Header>
            <Bar
              data={{ pr: pr() }}
              variant="header"
              refs={[...primaryRef(pr()), ...SERIES]}
            />
          </Header>
        ),
      },
    ],
  },
  {
    group: "PR status",
    title: "Summary band (side panel, workspace card)",
    specimens: [
      ...BAR_STATES.map(([state, data]) => ({
        name: `summary · ${state}`,
        width: W,
        node: (
          <PanelColumn>
            <Bar data={data} variant="summary" />
          </PanelColumn>
        ),
      })),
      {
        name: "summary · series · ready to merge",
        width: W,
        node: (
          <PanelColumn>
            <Bar
              data={{ pr: pr() }}
              variant="summary"
              refs={[...primaryRef(pr()), ...SERIES]}
            />
          </PanelColumn>
        ),
      },
    ],
  },
  {
    group: "Session side panel",
    title: "Changes page",
    specimens: [
      {
        select: ".viewer-panel",
        name: "panel · PR · ready to merge",
        width: W,
        node: <SidePanel scenario="ready to merge" />,
      },
      {
        select: ".viewer-panel",
        name: "panel · PR · checks failed",
        width: W,
        node: <SidePanel scenario="checks failed" />,
      },
      {
        select: ".viewer-panel",
        name: "panel · PR · changes requested",
        width: W,
        node: <SidePanel scenario="changes requested" />,
      },
      {
        select: ".viewer-panel",
        name: "panel · PR · checks running",
        width: W,
        node: <SidePanel scenario="checks running" />,
      },
      {
        select: ".viewer-panel",
        name: "panel · PR · merged",
        width: W,
        node: <SidePanel scenario="merged" />,
      },
      {
        select: ".viewer-panel",
        name: "panel · PR · series",
        width: W,
        node: <SidePanel scenario="series of PRs" />,
      },
      {
        select: ".viewer-panel",
        name: "panel · PR · files expanded",
        width: W,
        node: <SidePanel scenario="ready to merge" expandChanges />,
      },
      {
        select: ".viewer-panel",
        name: "panel · no PR · setup failed",
        width: W,
        node: (
          <SidePanel scenario="setup failed" title="Streak freeze tokens" />
        ),
      },
      {
        select: ".viewer-panel",
        name: "panel · no PR · uncommitted",
        width: W,
        node: (
          <SidePanel
            scenario="no PR · uncommitted"
            title="Export worker memory spike"
          />
        ),
      },
    ],
  },
  {
    group: "Workspace summary",
    title: "Header card",
    specimens: [
      {
        name: "card · ready to merge",
        select: '[role="dialog"]',
        node: <SummaryCard scenario="ready to merge" />,
      },
      {
        name: "card · checks failed",
        select: '[role="dialog"]',
        node: <SummaryCard scenario="checks failed" />,
      },
      {
        name: "card · no PR · uncommitted",
        select: '[role="dialog"]',
        node: <SummaryCard scenario="no PR · uncommitted" />,
      },
    ],
  },
  {
    group: "Workspace summary",
    title: "Phone workspace page",
    specimens: [
      {
        name: "phone · ready to merge",
        viewport: 390,
        width: 390,
        node: <PhoneSummary scenario="ready to merge" sandbox />,
      },
      {
        name: "phone · checks failed",
        viewport: 390,
        width: 390,
        node: <PhoneSummary scenario="checks failed" />,
      },
      {
        name: "phone · no PR · uncommitted",
        viewport: 390,
        width: 390,
        node: <PhoneSummary scenario="no PR · uncommitted" />,
      },
    ],
  },
  {
    group: "PR series rows",
    title: "Variants",
    specimens: [
      {
        name: "bar · two PRs",
        width: W,
        node: (
          <div className="viewer-panel flex w-full flex-col">
            <PrSeriesRows refs={SERIES} primaryRepo={REPO} onOpen={noop} />
          </div>
        ),
      },
      {
        name: "summary · two PRs",
        width: W,
        node: (
          <PanelColumn>
            <PrSeriesRows
              refs={SERIES}
              primaryRepo={REPO}
              onOpen={noop}
              variant="summary"
            />
          </PanelColumn>
        ),
      },
      {
        name: "summary · draft and merged",
        width: W,
        node: (
          <PanelColumn>
            <PrSeriesRows
              primaryRepo={REPO}
              onOpen={noop}
              variant="summary"
              refs={[
                {
                  repo: "acme/habit",
                  branch: "feat/wallet-model",
                  source: "discovered",
                  number: 480,
                  url: "https://github.com/acme/habit/pull/480",
                  state: "MERGED",
                  title: "Wallet pass data model",
                },
                {
                  repo: "acme/habit",
                  branch: "feat/wallet-share",
                  source: "linked",
                  number: 485,
                  url: "https://github.com/acme/habit/pull/485",
                  state: "OPEN",
                  isDraft: true,
                  title: "Wallet pass share sheet",
                },
                {
                  repo: "acme/habit-ios",
                  branch: "feat/wallet-pass",
                  source: "attached",
                  number: 2204,
                  url: "https://github.com/acme/habit-ios/pull/2204",
                  state: "OPEN",
                  mergeable: "CONFLICTING",
                  title: "Add to Apple Wallet button",
                },
              ]}
            />
          </PanelColumn>
        ),
      },
    ],
  },
  {
    group: "Checks popover",
    title: "Open",
    specimens: [
      {
        name: "popover · failed",
        select: '[role="dialog"]',
        node: (
          <After run={click("button")}>
            <PrChecksPopover
              checks={CHECKS_FAILED}
              trigger={
                <button type="button" className="text-label">
                  4 checks
                </button>
              }
            />
          </After>
        ),
      },
      {
        name: "popover · running",
        select: '[role="dialog"]',
        node: (
          <After run={click("button")}>
            <PrChecksPopover
              checks={CHECKS_RUNNING}
              trigger={
                <button type="button" className="text-label">
                  4 checks
                </button>
              }
            />
          </After>
        ),
      },
      {
        name: "popover · all passed",
        select: '[role="dialog"]',
        node: (
          <After run={click("button")}>
            <PrChecksPopover
              checks={[...CHECKS_PASS, check("lint", "SKIPPED")]}
              trigger={
                <button type="button" className="text-label">
                  5 checks
                </button>
              }
            />
          </After>
        ),
      },
    ],
  },
  {
    group: "Check status icon",
    title: "Kinds",
    specimens: (
      ["success", "failure", "pending", "skipped", "neutral"] as const
    ).map((k) => ({
      name: `icon · ${k}`,
      node: (
        <span
          className={`inline-flex size-4 ${k === "success" ? "text-green" : k === "failure" ? "text-red" : k === "pending" ? "text-yellow" : "text-dim"}`}
        >
          <CheckStatusIcon kind={k} />
        </span>
      ),
    })),
  },
  {
    group: "PR review rail",
    title: "Overview metadata column",
    specimens: [
      {
        name: "rail · ready to merge",
        node: (
          <Rail p={pr({ reviewDecision: "APPROVED", reviewers: REVIEWERS })} />
        ),
      },
      {
        name: "rail · ready to merge · merge options",
        node: (
          <Rail
            p={pr({ reviewDecision: "APPROVED", reviewers: REVIEWERS })}
            merge={MERGE_NOW}
          />
        ),
      },
      {
        name: "rail · auto-merge on",
        node: (
          <Rail
            p={pr({ checks: CHECKS_RUNNING, autoMerge: AUTO_MERGE })}
            merge={MERGE_AUTO_ON}
          />
        ),
      },
      {
        name: "rail · checks failed · expanded",
        node: (
          <Rail
            p={pr({
              checks: CHECKS_FAILED,
              reviewers: [{ login: "mila-novak", state: "PENDING" }],
            })}
            open="checks"
          />
        ),
      },
      {
        name: "rail · checks running · expanded",
        node: <Rail p={pr({ checks: CHECKS_RUNNING })} open="checks" />,
      },
      {
        name: "rail · changes requested",
        node: (
          <Rail
            p={pr({
              reviewDecision: "CHANGES_REQUESTED",
              reviewers: [{ login: "priya-raman", state: "CHANGES_REQUESTED" }],
            })}
          />
        ),
      },
      {
        name: "rail · conflicts · uncommitted",
        node: (
          <Rail
            p={pr({ mergeable: "CONFLICTING" })}
            git={{ ...GIT_CLEAN, behindBase: 4, uncommittedFiles: 2 }}
          />
        ),
      },
      {
        name: "rail · draft · commits expanded",
        node: <Rail p={pr({ isDraft: true })} open="commits" />,
      },
      {
        name: "rail · merged",
        node: (
          <Rail
            p={pr({
              state: "MERGED",
              reviewDecision: "APPROVED",
              reviewers: REVIEWERS,
            })}
          />
        ),
      },
    ],
  },
  {
    group: "PR review rail",
    title: "Phone",
    specimens: [
      {
        name: "phone · ready to merge",
        viewport: 390,
        width: 390,
        node: (
          <div className="w-full bg-surface p-4">
            <Rail
              className="w-full"
              p={pr({ reviewDecision: "APPROVED", reviewers: REVIEWERS })}
              merge={MERGE_NOW}
            />
          </div>
        ),
      },
      {
        name: "phone · checks failed",
        viewport: 390,
        width: 390,
        node: (
          <div className="w-full bg-surface p-4">
            <Rail
              className="w-full"
              p={pr({
                checks: CHECKS_FAILED,
                reviewers: [{ login: "mila-novak", state: "PENDING" }],
              })}
            />
          </div>
        ),
      },
    ],
  },
  {
    group: "PR review rows",
    title: "Rows",
    specimens: [
      {
        name: "reviewer · approved",
        width: 264,
        node: (
          <div className="w-full">
            <ReviewerRow
              reviewer={{ login: "mila-novak", state: "APPROVED" }}
              provider={providerFromUrl(pr().url)}
            />
          </div>
        ),
      },
      {
        name: "reviewer · changes requested",
        width: 264,
        node: (
          <div className="w-full">
            <ReviewerRow
              reviewer={{ login: "priya-raman", state: "CHANGES_REQUESTED" }}
              provider={providerFromUrl(pr().url)}
            />
          </div>
        ),
      },
      {
        name: "reviewer · commented",
        width: 264,
        node: (
          <div className="w-full">
            <ReviewerRow
              reviewer={{ login: "jonas-weber", state: "COMMENTED" }}
              provider={providerFromUrl(pr().url)}
            />
          </div>
        ),
      },
      {
        name: "reviewer · team · awaiting",
        width: 264,
        node: (
          <div className="w-full">
            <ReviewerRow
              reviewer={{ login: "payments", state: "PENDING", isTeam: true }}
              provider={providerFromUrl(pr().url)}
            />
          </div>
        ),
      },
      {
        name: "reviewer · approved · hover",
        width: 264,
        node: (
          <div className="w-full" data-force-hover-in="">
            <ReviewerRow
              reviewer={{ login: "mila-novak", state: "APPROVED" }}
              provider={providerFromUrl(pr().url)}
            />
          </div>
        ),
      },
      {
        name: "file · idle",
        width: 264,
        node: (
          <div className="w-full">
            <FileRow file={FILES[0]!} onClick={noop} />
          </div>
        ),
      },
      {
        name: "file · hover",
        width: 264,
        node: (
          <div className="w-full" data-force-hover-in="">
            <FileRow file={FILES[1]!} onClick={noop} />
          </div>
        ),
      },
      {
        name: "file · additions only",
        width: 264,
        node: (
          <div className="w-full">
            <FileRow file={FILES[2]!} onClick={noop} />
          </div>
        ),
      },
      {
        name: "check · passed",
        width: 264,
        node: (
          <div className="w-full">
            <CheckRow check={CHECKS_PASS[1]!} />
          </div>
        ),
      },
      {
        name: "check · failed",
        width: 264,
        node: (
          <div className="w-full">
            <CheckRow check={CHECKS_FAILED[1]!} />
          </div>
        ),
      },
      {
        name: "check · running",
        width: 264,
        node: (
          <div className="w-full">
            <CheckRow check={CHECKS_RUNNING[2]!} />
          </div>
        ),
      },
      {
        name: "status · ready to merge",
        width: 264,
        node: (
          <div className="w-full">
            <GitStatusRows
              git={GIT_CLEAN}
              pr={pr({ reviewDecision: "APPROVED" })}
              sessionId="s-git"
              send={noop}
              onRefresh={noop}
              onMerge={noop}
            />
          </div>
        ),
      },
      {
        name: "status · conflicts, behind, uncommitted",
        width: 264,
        node: (
          <div className="w-full">
            <GitStatusRows
              git={{
                ...GIT_CLEAN,
                behindBase: 4,
                ahead: 1,
                uncommittedFiles: 2,
              }}
              pr={pr({ mergeable: "CONFLICTING" })}
              sessionId="s-git"
              send={noop}
              onRefresh={noop}
              onMerge={noop}
            />
          </div>
        ),
      },
      {
        name: "status · merge options",
        width: 264,
        node: (
          <div className="w-full">
            <GitStatusRows
              git={GIT_CLEAN}
              pr={pr({ reviewDecision: "APPROVED" })}
              sessionId="s-git"
              send={noop}
              onRefresh={noop}
              onMerge={noop}
              merge={MERGE_NOW}
            />
          </div>
        ),
      },
      {
        name: "status · merge options · menu open",
        select: '[role="menu"]',
        node: (
          <div style={{ width: 320, height: 220 }}>
            <After run={openAtRest('[aria-label="Merge options"]')}>
              <GitStatusRows
                git={GIT_CLEAN}
                pr={pr({ reviewDecision: "APPROVED" })}
                sessionId="s-git"
                send={noop}
                onRefresh={noop}
                onMerge={noop}
                merge={MERGE_NOW}
              />
            </After>
          </div>
        ),
      },
      {
        name: "status · auto-merge on",
        width: 264,
        node: (
          <div className="w-full">
            <GitStatusRows
              git={GIT_CLEAN}
              pr={pr({ checks: CHECKS_RUNNING, autoMerge: AUTO_MERGE })}
              sessionId="s-git"
              send={noop}
              onRefresh={noop}
              onMerge={noop}
              merge={MERGE_AUTO_ON}
            />
          </div>
        ),
      },
      {
        name: "status · no PR",
        width: 264,
        node: (
          <div className="w-full">
            <GitStatusRows
              git={{ ...GIT_CLEAN, ahead: 3, uncommittedFiles: 2 }}
              pr={null}
              sessionId="s-git"
              send={noop}
              onRefresh={noop}
            />
          </div>
        ),
      },
      {
        name: "card · reviewers",
        width: 560,
        node: (
          <div className="w-full bg-surface p-4">
            <PrCard title="Reviewers">
              <ReviewerRow
                reviewer={{ login: "mila-novak", state: "APPROVED" }}
                provider={providerFromUrl(pr().url)}
              />
              <ReviewerRow
                reviewer={{ login: "jonas-weber", state: "COMMENTED" }}
                provider={providerFromUrl(pr().url)}
              />
            </PrCard>
          </div>
        ),
      },
    ],
  },
  {
    group: "PR state icon",
    title: "States",
    specimens: [
      {
        name: "icon · open",
        node: (
          <span className="inline-flex text-green">
            <PrStateIcon state="OPEN" />
          </span>
        ),
      },
      {
        name: "icon · draft",
        node: (
          <span className="inline-flex text-faint">
            <PrStateIcon state="OPEN" isDraft />
          </span>
        ),
      },
      {
        name: "icon · merged",
        node: (
          <span className="inline-flex text-purple">
            <PrStateIcon state="MERGED" />
          </span>
        ),
      },
      {
        name: "icon · closed",
        node: (
          <span className="inline-flex text-red">
            <PrStateIcon state="CLOSED" />
          </span>
        ),
      },
    ],
  },
  {
    group: "PR row",
    title: "Sidebar",
    specimens: [
      {
        name: "row · checks running · idle",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem()}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · checks running · hover",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full" data-force-hover-in="">
            <PrRow
              item={prItem()}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · checks running · selected",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem()}
              selected
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · pinned · hover",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full" data-force-hover-in="">
            <PrRow
              item={prItem()}
              selected={false}
              pinned
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · needs your review",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem(
                {
                  title: "Passkey sign-in",
                  author: "priya",
                  person: "Priya",
                  checks: { total: 6, passed: 6, failed: 0, pending: 0 },
                },
                "requested",
              )}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · checks failed",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem({
                checks: { total: 5, passed: 4, failed: 1, pending: 0 },
              })}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · ready",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem({
                checks: { total: 5, passed: 5, failed: 0, pending: 0 },
                reviewDecision: "APPROVED",
              })}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · draft",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem({
                isDraft: true,
                checks: { total: 0, passed: 0, failed: 0, pending: 0 },
              })}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "row · long title",
        width: 280,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem({
                title:
                  "Reconcile September Stripe payouts against the ledger and flag every mismatch",
                checks: { total: 5, passed: 5, failed: 0, pending: 0 },
              })}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
      {
        name: "phone · checks running",
        viewport: 390,
        width: 390,
        on: "--bg-sidebar",
        node: (
          <div className="w-full">
            <PrRow
              item={prItem()}
              selected={false}
              pinned={false}
              onTogglePin={noop}
              onOpen={noop}
              onClose={noop}
              closing={false}
            />
          </div>
        ),
      },
    ],
  },
  {
    group: "Plain status badge",
    title: "States",
    specimens: ["TODO", "SNOOZED", "DONE"].map((s) => ({
      name: `badge · ${s.toLowerCase()}`,
      node: <PlainStatusBadge status={s} />,
    })),
  },
  {
    group: "Sandbox badge",
    title: "Trigger",
    specimens: [
      {
        name: "badge · awake",
        node: (
          <SandboxBadge
            sessionId="sb-awake"
            sandbox={{
              provider: "daytona",
              sandboxId: "dt-81f2",
              lifecycle: "awake",
            }}
          />
        ),
      },
      {
        name: "badge · sleeping",
        node: (
          <SandboxBadge
            sessionId="sb-sleeping"
            sandbox={{
              provider: "daytona",
              sandboxId: "dt-81f2",
              lifecycle: "sleeping",
            }}
          />
        ),
      },
      {
        name: "badge · preparing",
        node: (
          <SandboxBadge
            sessionId="sb-awake"
            sandbox={{ provider: "daytona", lifecycle: "preparing" }}
          />
        ),
      },
      {
        name: "badge · awake · hover",
        node: (
          <div data-force-hover-in="">
            <SandboxBadge
              sessionId="sb-awake"
              sandbox={{
                provider: "daytona",
                sandboxId: "dt-81f2",
                lifecycle: "awake",
              }}
            />
          </div>
        ),
      },
      {
        name: "badge · runner · ready",
        node: (
          <SandboxBadge
            sessionId="sb-runner"
            runner={{
              id: "r1",
              name: "Studio Mac",
              workspacePath: "/Users/kacper/work/habit",
              lifecycle: "awake",
            }}
          />
        ),
      },
      {
        name: "badge · runner · offline",
        node: (
          <SandboxBadge
            sessionId="sb-runner"
            runner={{
              id: "r1",
              name: "Studio Mac",
              workspacePath: "/Users/kacper/work/habit",
              lifecycle: "offline",
            }}
          />
        ),
      },
    ],
  },
  {
    group: "Sandbox badge",
    title: "Popover",
    specimens: [
      {
        name: "popover · awake",
        select: '[role="dialog"]',
        node: (
          <After run={openAtRest("button")}>
            <SandboxBadge
              sessionId="sb-awake"
              sandbox={{
                provider: "daytona",
                sandboxId: "dt-81f2",
                lifecycle: "awake",
              }}
            />
          </After>
        ),
      },
      {
        name: "popover · sleeping",
        select: '[role="dialog"]',
        node: (
          <After run={openAtRest("button")}>
            <SandboxBadge
              sessionId="sb-sleeping"
              sandbox={{
                provider: "daytona",
                sandboxId: "dt-81f2",
                lifecycle: "sleeping",
              }}
            />
          </After>
        ),
      },
      {
        name: "popover · preparing",
        select: '[role="dialog"]',
        node: (
          <After run={openAtRest("button")}>
            <SandboxBadge
              sessionId="sb-preparing"
              sandbox={{ provider: "daytona", lifecycle: "preparing" }}
            />
          </After>
        ),
      },
      {
        name: "popover · needs attention",
        select: '[role="dialog"]',
        node: (
          <After run={openAtRest("button")}>
            <SandboxBadge
              sessionId="sb-error"
              sandbox={{
                provider: "daytona",
                sandboxId: "dt-81f2",
                lifecycle: "needs_attention",
              }}
            />
          </After>
        ),
      },
      {
        name: "popover · runner",
        select: '[role="dialog"]',
        node: (
          <After run={openAtRest("button")}>
            <SandboxBadge
              sessionId="sb-runner"
              runner={{
                id: "r1",
                name: "Studio Mac",
                workspacePath: "/Users/kacper/work/habit",
                lifecycle: "awake",
              }}
            />
          </After>
        ),
      },
    ],
  },
  {
    group: "Session relations",
    title: "Delegated workers",
    specimens: [
      {
        name: "chip · two workers",
        node: (
          <SessionRelations
            workers={WORKERS.slice(0, 2)}
            models={MODELS}
            onOpen={noop}
          />
        ),
      },
      {
        name: "chip · two workers · hover",
        node: (
          <div data-force-hover-in="">
            <SessionRelations
              workers={WORKERS.slice(0, 2)}
              models={MODELS}
              onOpen={noop}
            />
          </div>
        ),
      },
      {
        name: "menu · three workers · open",
        select: '[role="menu"]',
        node: (
          <After run={click("button")}>
            <SessionRelations workers={WORKERS} models={MODELS} onOpen={noop} />
          </After>
        ),
      },
    ],
  },
  {
    group: "Command palette",
    title: "Open",
    specimens: [
      {
        name: "palette · resting · first row",
        select: '[role="dialog"]',
        node: <Palette />,
      },
      {
        name: "palette · query · highlighted row",
        select: '[role="dialog"]',
        node: <Palette query="wallet" down={2} />,
      },
      {
        name: "palette · query · workspace and PR",
        select: '[role="dialog"]',
        node: <Palette query="export" />,
      },
      {
        name: "palette · query · in conversations",
        select: '[role="dialog"]',
        node: <Palette query="heap" delay={10} />,
      },
      {
        name: "palette · in a session · find",
        select: '[role="dialog"]',
        node: <Palette query="find" inSession />,
      },
      {
        name: "palette · query · project settings",
        select: '[role="dialog"]',
        node: <Palette query="habit settings" inSession />,
      },
      {
        name: "palette · empty result",
        select: '[role="dialog"]',
        node: <Palette query="quarterly forecast" />,
      },
      {
        name: "phone · resting",
        viewport: 390,
        select: '[role="dialog"]',
        node: <Palette />,
      },
      {
        name: "phone · query",
        viewport: 390,
        select: '[role="dialog"]',
        node: <Palette query="wallet" />,
      },
    ],
  },
  {
    group: "Notifications",
    title: "Bell",
    specimens: [
      {
        name: "bell · unread",
        on: "--bg-sidebar",
        node: (
          <Inbox>
            <NotificationBell />
          </Inbox>
        ),
      },
      {
        name: "bell · unread · hover",
        on: "--bg-sidebar",
        node: (
          <div data-force-hover-in="">
            <Inbox>
              <NotificationBell />
            </Inbox>
          </div>
        ),
      },
      {
        name: "popover · unread",
        select: '[role="dialog"]',
        node: (
          <After run={openAtRest("button")}>
            <Inbox>
              <NotificationBell />
            </Inbox>
          </After>
        ),
      },
      {
        name: "phone · top bar button",
        viewport: 390,
        node: (
          <Inbox>
            <InboxBarButton onOpen={noop} />
          </Inbox>
        ),
      },
    ],
  },
  {
    group: "Notifications",
    title: "Rows",
    specimens: [
      {
        name: "row · review requested · unread",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(0)]} />
          </div>
        ),
      },
      {
        name: "row · mention · unread",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(1)]} />
          </div>
        ),
      },
      {
        name: "row · review done · read",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(2)]} />
          </div>
        ),
      },
      {
        name: "row · collaborator · read",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(3)]} />
          </div>
        ),
      },
      {
        name: "row · reminder · read",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(4)]} />
          </div>
        ),
      },
      {
        name: "row · team review requested · read",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(6)]} />
          </div>
        ),
      },
      {
        name: "row · comment · unread",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(7)]} />
          </div>
        ),
      },
      {
        name: "row · incident needs you · unread",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(5)]} />
          </div>
        ),
      },
      {
        name: "row · incident resolved · read",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(8)]} />
          </div>
        ),
      },
      {
        name: "row · support needs you · unread",
        width: 380,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(9)]} />
          </div>
        ),
      },
      {
        name: "row · incident needs you · phone",
        viewport: 390,
        width: 390,
        node: (
          <div className="w-full">
            <InboxRows rows={[thread(5)]} />
          </div>
        ),
      },
      {
        name: "row · review requested · hover",
        width: 380,
        node: <HoverRow t={thread(0)} />,
      },
      {
        name: "row · done · hover",
        width: 380,
        node: <HoverRow t={thread(2, { done: true })} />,
      },
      {
        name: "list · empty · done",
        width: 380,
        node: (
          <div className="w-full">
            <Inbox>
              <NotificationList filter="done" />
            </Inbox>
          </div>
        ),
      },
      {
        name: "list · all",
        width: 380,
        node: (
          <div className="w-full">
            <Inbox>
              <NotificationList filter="all" />
            </Inbox>
          </div>
        ),
      },
    ],
  },
  {
    group: "Notifications",
    title: "Inbox page",
    specimens: [
      {
        name: "page · desktop",
        width: 900,
        node: (
          <div className="w-full">
            <Inbox>
              <InboxPage />
            </Inbox>
          </div>
        ),
      },
      {
        name: "page · phone",
        viewport: 390,
        width: 390,
        node: (
          <div className="w-full">
            <Inbox>
              <InboxPage />
            </Inbox>
          </div>
        ),
      },
    ],
  },
  {
    group: "Notifications",
    title: "Update card",
    specimens: [
      // The card enters on a keyframe animation, which the harness freezes at its
      // first frame; the resting state is the end of it.
      {
        name: "card · new update",
        width: 360,
        node: (
          <div className="w-full [&>*]:animate-none">
            <UpdatePill addHandler={updateHandler({ by: "Kacper" })} />
          </div>
        ),
      },
    ],
  },
];

function HoverRow({ t }: { t: any }) {
  return (
    <After
      run={(root) =>
        root.querySelector(".inbox-row")?.setAttribute("data-force-hover", "")
      }
    >
      <ul className={INBOX_LIST}>
        <NotificationRow thread={t} />
      </ul>
    </After>
  );
}

function updateHandler(msg: Record<string, unknown>) {
  return (h: (m: any) => void) => {
    setTimeout(() => h({ type: "frontend_updated", ...msg }), 0);
    return noop;
  };
}

export const descriptions: Record<string, string> = {
  "PR status":
    "components/PrStatusBar.tsx · the PR headline and its one action, in the session header and the workspace summary",
  "Session side panel":
    "components/session/SidePanelHost.tsx · the right-hand workspace panel on desktop, opened from the session header",
  "Workspace summary":
    "components/WorkspaceSummary.tsx · the header's floating summary card, and the phone Workspace page",
  "PR series rows":
    "components/PrSeriesRows.tsx · the other PRs a session owns, stacked under its PR status",
  "Checks popover":
    "components/PrChecksPopover.tsx · hovering a PR's checks count or headline",
  "Check status icon":
    "components/CheckStatusIcon.tsx · one CI check's result, in the checks popover",
  "PR review rail":
    "components/pr/ReviewRail.tsx · the PR review canvas's metadata column beside the conversation",
  "PR review rows":
    "components/pr/PrRows.tsx · reviewer, file, check and git status rows inside review cards, with the merge button and its options",
  "PR state icon":
    "components/pr/PrStateIcon.tsx · a PR's open, draft, merged or closed glyph",
  "PR row":
    "components/PrRow.tsx · a session-less open PR in the sidebar's project lanes",
  "Plain status badge":
    "components/PlainStatusBadge.tsx · a support thread's status, in the Support bar",
  "Sandbox badge":
    "components/SandboxBadge.tsx · where a session runs, in the session header",
  "Session relations":
    "components/SessionRelations.tsx · the workers a session delegated to, in the session header",
  "Command palette":
    "components/CommandMenuHost.tsx · the ⌘K menu for actions, PRs and sessions",
  Notifications:
    "components/notifications/NotificationBell.tsx · the inbox bell, its popover and the Inbox page, for reviews, mentions, incidents and support",
};
