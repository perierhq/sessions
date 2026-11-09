import * as React from "react";
import { Badge } from "../../../packages/core/opensession-server/src/frontend/ui/badge";
import {
  Card,
  CardList,
} from "../../../packages/core/opensession-server/src/frontend/ui/card";
import { Spinner } from "../../../packages/core/opensession-server/src/frontend/ui/spinner";
import {
  PulseDot,
  WorkingPill,
} from "../../../packages/core/opensession-server/src/frontend/ui/status";
import {
  EmptyState,
  LoadingState,
  Skeleton,
  SkeletonBar,
  ListSkeleton,
  TranscriptSkeleton,
  InlineAlert,
} from "../../../packages/core/opensession-server/src/frontend/ui/state";
import { TextShimmer } from "../../../packages/core/opensession-server/src/frontend/ui/text-shimmer";
import { CopyCheck } from "../../../packages/core/opensession-server/src/frontend/ui/copy";
import { DeviceCode } from "../../../packages/core/opensession-server/src/frontend/ui/device-code";
import { DataGrid } from "../../../packages/core/opensession-server/src/frontend/ui/data-grid";
import { OverflowFadeText } from "../../../packages/core/opensession-server/src/frontend/ui/overflow-fade-text";
import { Fold } from "../../../packages/core/opensession-server/src/frontend/ui/fold";
import { Disclosure } from "../../../packages/core/opensession-server/src/frontend/ui/disclosure";
import {
  SwipeCard,
  DeckDone,
} from "../../../packages/core/opensession-server/src/frontend/ui/swipe-deck";
import { PageLoader } from "../../../packages/core/opensession-server/src/frontend/ui/page-loader";
import { Button } from "../../../packages/core/opensession-server/src/frontend/ui/button";
import {
  BarStrip,
  type BarSpec,
  type BarTone,
} from "../../../packages/core/opensession-server/src/frontend/ui/bar-strip";
import { ChartTooltip } from "../../../packages/core/opensession-server/src/frontend/ui/chart-tooltip";
import { CountdownDigits } from "../../../packages/core/opensession-server/src/frontend/ui/countdown";
import { DetailKey } from "../../../packages/core/opensession-server/src/frontend/ui/detail-key";
import {
  Meter,
  MeterGroup,
  MeterTrack,
} from "../../../packages/core/opensession-server/src/frontend/ui/meter";
import { MotionConfig } from "motion/react";
import {
  IconCopy,
  IconLink,
  IconInbox,
  IconSearch,
  IconArrowUpRight,
  IconChevronRight,
  IconUndo,
} from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type { Section } from "../entry";

const noop = () => {};
// Waits the longer (popup) settle time so motion-driven entrances finish
// before capture; with ?only=<id> there is exactly one wrapper on the page.
const SETTLE = "[data-spec] > *";
// Skeletons hold back 180ms with a paused CSS fade; show the settled ghost.
const settled = { style: { animation: "none" } } as const;

const TONES = [
  "neutral",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
] as const;
const toneLabel: Record<(typeof TONES)[number], string> = {
  neutral: "Draft",
  accent: "New",
  success: "Merged",
  warning: "Needs review",
  danger: "Failed",
  info: "Queued",
};

// Base UI triggers and DeviceCode don't forward props, so force the state on
// the real interactive element after mount.
function Force({
  attrs,
  target = "button",
  children,
}: {
  attrs: Record<string, string>;
  target?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex w-full"
      ref={(el) => {
        const t = el?.querySelector(target);
        if (t) for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v);
      }}
    >
      {children}
    </div>
  );
}

const forceState = (s: string) =>
  s === "hover"
    ? { "data-force-hover": "" }
    : s === "pressed"
      ? { "data-force-active": "", "data-force-hover": "" }
      : s === "focus"
        ? { "data-force-focus": "" }
        : {};

const sessionRow = (title: string, meta: string) => (
  <div className="flex items-center gap-3 px-4 py-3">
    <div className="min-w-0 flex-1">
      <div className="truncate text-label font-medium text-fg">{title}</div>
      <div className="text-meta text-dim">{meta}</div>
    </div>
  </div>
);

const GRID_COLUMNS = [
  "id",
  "workspace",
  "title",
  "runs",
  "cost_usd",
  "archived_at",
];
const GRID_ROWS: (string | number | null)[][] = [
  [1042, "wallet", "Wallet pass redesign", 14, 3.82, null],
  [1043, "finance", "Reconcile September Stripe payouts", 6, 1.2, "2025-10-02"],
  [1044, "habit", "Streak reminders at local midnight", 9, 2.47, null],
  [
    1045,
    "web",
    "Migrate the settings page to the new settings rows and drop the legacy form styles from every tab",
    21,
    7.05,
    null,
  ],
];

// ── Bar strip data ─────────────────────────────────────────────────────
const bar = (i: number, tone: BarTone, height: number, label: string) =>
  ({ key: String(i), tone, height, label }) satisfies BarSpec;

// Thirty days of automation runs: mostly one run a day, a few busy days, two
// failures and some quiet days that keep a stub.
const RUNS = [
  1, 1, 0, 2, 1, 1, 0, 0, 1, 3, 1, 1, -1, 1, 0, 1, 2, 1, 1, 0, 0, 1, 1, -2, 1,
  4, 1, 1, 2, 1,
];
const historyBars: BarSpec[] = RUNS.map((n, i) =>
  n === 0
    ? bar(i, "empty", 0, "No runs")
    : n < 0
      ? bar(i, "fail", -n / 4, `${-n} failed run${n === -1 ? "" : "s"}`)
      : bar(i, "ok", n / 4, `${n} run${n === 1 ? "" : "s"}`),
);

// An error rate climbing past its threshold, then the slots not reached yet.
const ERROR_RATE = [
  0.12, 0.1, 0.14, 0.11, 0.16, 0.13, 0.12, 0.18, 0.22, 0.31, 0.45, 0.58, 0.72,
  0.86, 0.94, 0.9, 0.81, 0.77, -1, 0.68, 0.52, 0.4, 0.28, 0.19,
];
const signalBars = (future: number): BarSpec[] => [
  ...ERROR_RATE.map((v, i) =>
    v < 0
      ? bar(i, "missed", 1, "No sample")
      : bar(
          i,
          v >= 0.6 ? "fail" : v >= 0.4 ? "warn" : "neutral",
          v,
          `${Math.round(v * 10)}% errors`,
        ),
  ),
  ...Array.from({ length: future }, (_, i) =>
    bar(ERROR_RATE.length + i, "future", 1, "Not checked yet"),
  ),
];

const TONE_BARS: BarSpec[] = (
  [
    ["ok", 0.8],
    ["warn", 0.6],
    ["fail", 1],
    ["neutral", 0.4],
    ["empty", 0],
    ["missed", 1],
    ["future", 1],
  ] as const
).map(([tone, h], i) => bar(i, tone, h, tone));

// The countdown ticks once a second (it reads `s` for its first 0.9s); reduced motion swaps the digits without
// rolling, so a capture never lands mid-roll.
const inSeconds = (s: number) => Date.now() + s * 1000 - 100;

export const sections: Section[] = [
  // ── Badge ────────────────────────────────────────────────────────────
  {
    group: "Badge",
    title: "Tones",
    specimens: [
      ...TONES.map((t) => ({
        name: `soft · ${t}`,
        node: <Badge tone={t}>{toneLabel[t]}</Badge>,
      })),
      ...TONES.map((t) => ({
        name: `outline · ${t}`,
        node: (
          <Badge tone={t} variant="outline">
            {toneLabel[t]}
          </Badge>
        ),
      })),
    ],
  },
  {
    group: "Badge",
    title: "With dot",
    specimens: [
      ...TONES.map((t) => ({
        name: `soft dot · ${t}`,
        node: (
          <Badge tone={t} dot>
            {toneLabel[t]}
          </Badge>
        ),
      })),
      ...TONES.map((t) => ({
        name: `outline dot · ${t}`,
        node: (
          <Badge tone={t} variant="outline" dot>
            {toneLabel[t]}
          </Badge>
        ),
      })),
    ],
  },
  {
    group: "Badge",
    title: "Names",
    specimens: [
      {
        name: "outline · neutral · branch",
        node: <Badge variant="outline">feat/wallet-pass</Badge>,
      },
      {
        name: "outline · neutral · current",
        node: <Badge variant="outline">current</Badge>,
      },
      { name: "soft · neutral · count", node: <Badge>12 runs</Badge> },
    ],
  },

  // ── Card ─────────────────────────────────────────────────────────────
  {
    group: "Card",
    title: "Card",
    specimens: [
      {
        name: "card · on surface",
        width: 480,
        on: "--bg-surface",
        node: (
          <div className="flex w-full p-4">
            <Card className="w-full px-5 py-4">
              <div className="text-item-title font-semibold text-fg">
                Wallet pass redesign
              </div>
              <div className="mt-1 text-supporting text-dim">
                3 sessions in progress, last run 12 minutes ago.
              </div>
            </Card>
          </div>
        ),
      },
    ],
  },
  {
    group: "Card",
    title: "Card list",
    specimens: [
      {
        name: "card list · rows · on surface",
        width: 480,
        on: "--bg-surface",
        node: (
          <div className="flex w-full p-4">
            <CardList as="ul" className="w-full">
              <li>
                {sessionRow(
                  "Reconcile September Stripe payouts",
                  "finance · 2 runs",
                )}
              </li>
              <li>{sessionRow("Wallet pass redesign", "wallet · 14 runs")}</li>
              <li>
                {sessionRow(
                  "Streak reminders at local midnight",
                  "habit · 9 runs",
                )}
              </li>
            </CardList>
          </div>
        ),
      },
    ],
  },

  // ── Spinner ──────────────────────────────────────────────────────────
  {
    group: "Spinner",
    title: "Sizes",
    specimens: (["sm", "md", "lg"] as const).flatMap((s) => [
      { name: `${s} · dim`, node: <Spinner size={s} className="text-dim" /> },
      {
        name: `${s} · accent`,
        node: <Spinner size={s} className="text-accent" />,
      },
      { name: `${s} · fg`, node: <Spinner size={s} className="text-fg" /> },
    ]),
  },

  // ── Page loader ──────────────────────────────────────────────────────
  {
    group: "Page loader",
    title: "Default",
    specimens: [
      { name: "page loader · dim", node: <PageLoader className="text-dim" /> },
      {
        name: "page loader · faint",
        node: <PageLoader className="text-faint" />,
      },
    ],
  },

  // ── Pulse dot / Working pill ─────────────────────────────────────────
  {
    group: "Pulse dot",
    title: "Sizes",
    specimens: [
      { name: "size · 12", node: <PulseDot size={12} /> },
      { name: "size · 8", node: <PulseDot /> },
      { name: "size · 7", node: <PulseDot size={7} /> },
      {
        name: "inline · 7 · in text",
        node: (
          <span className="inline-flex items-center gap-1.5 text-supporting text-dim">
            <PulseDot size={7} />
            Running tests in wallet
          </span>
        ),
      },
      {
        name: "headline · 12 · beside a page title",
        node: (
          <h1 className="m-0 flex min-w-0 items-start gap-3 text-page-title font-title text-fg">
            <span aria-hidden className="flex h-[1lh] shrink-0 items-center">
              <PulseDot size={12} />
            </span>
            <span className="min-w-0">Checkout errors above 5%</span>
          </h1>
        ),
      },
    ],
  },
  {
    group: "Working pill",
    title: "Labels",
    specimens: [
      { name: "pill · default", node: <WorkingPill /> },
      {
        name: "pill · custom label",
        node: <WorkingPill>Reviewing</WorkingPill>,
      },
    ],
  },

  // ── Empty state ──────────────────────────────────────────────────────
  {
    group: "Empty state",
    title: "Block",
    specimens: [
      {
        name: "block · text only",
        width: 480,
        node: <EmptyState className="w-full">Workspace not found.</EmptyState>,
      },
      {
        name: "block · title",
        width: 480,
        node: (
          <EmptyState className="w-full" title="Session not found">
            It may have been deleted.
          </EmptyState>
        ),
      },
      {
        name: "block · icon + title + action",
        width: 480,
        node: (
          <EmptyState
            className="w-full"
            icon={<IconInbox size={22} />}
            title="No reviews waiting"
            action={<Button size="sm">Open sessions</Button>}
          >
            Pull requests that need your review show up here.
          </EmptyState>
        ),
      },
      {
        name: "block · error + retry",
        width: 480,
        node: (
          <EmptyState
            className="w-full"
            title="Couldn't load sessions"
            action={<Button size="sm">Try again</Button>}
          >
            Check the connection to this server.
          </EmptyState>
        ),
      },
    ],
  },
  {
    group: "Empty state",
    title: "Card and row",
    specimens: [
      {
        name: "card · title + action",
        width: 480,
        node: (
          <EmptyState
            className="w-full"
            placement="card"
            icon={<IconSearch size={22} />}
            title="No automations yet"
            action={<Button size="sm">New automation</Button>}
          >
            Automations run a prompt on a schedule or when a PR opens.
          </EmptyState>
        ),
      },
      {
        name: "card · text only",
        width: 480,
        node: (
          <EmptyState className="w-full" placement="card">
            Nothing archived yet.
          </EmptyState>
        ),
      },
      {
        name: "row · in card list",
        width: 480,
        on: "--bg-surface",
        node: (
          <div className="flex w-full p-4">
            <CardList className="w-full">
              <EmptyState placement="row">
                No runs for this automation yet.
              </EmptyState>
            </CardList>
          </div>
        ),
      },
    ],
  },

  // ── Loading state ────────────────────────────────────────────────────
  {
    group: "Loading state",
    title: "Placements",
    specimens: [
      {
        name: "block · spinner",
        width: 480,
        node: <LoadingState className="w-full">Loading session…</LoadingState>,
      },
      {
        name: "block · no spinner",
        width: 480,
        node: (
          <LoadingState className="w-full" spinner={false}>
            Checking GitHub…
          </LoadingState>
        ),
      },
      {
        name: "card · spinner",
        width: 480,
        node: (
          <LoadingState className="w-full" placement="card">
            Signing in to ChatGPT…
          </LoadingState>
        ),
      },
      {
        name: "row · spinner",
        width: 480,
        on: "--bg-surface",
        node: (
          <div className="flex w-full p-4">
            <CardList className="w-full">
              <LoadingState placement="row">
                Probing model providers…
              </LoadingState>
            </CardList>
          </div>
        ),
      },
      {
        name: "row · no spinner",
        width: 480,
        node: (
          <LoadingState className="w-full" placement="row" spinner={false}>
            Saving…
          </LoadingState>
        ),
      },
    ],
  },

  // ── Skeleton ─────────────────────────────────────────────────────────
  {
    group: "Skeleton",
    title: "Bars",
    specimens: [
      {
        name: "bar · title",
        width: 240,
        node: (
          <div className="w-full">
            <SkeletonBar className="w-full" />
          </div>
        ),
      },
      {
        name: "bar · supporting",
        width: 240,
        node: (
          <div className="w-full">
            <SkeletonBar className="h-2.5 w-[60%]" />
          </div>
        ),
      },
      {
        name: "skeleton · title + line",
        width: 360,
        node: (
          <div className="w-full">
            <Skeleton {...settled} className="rounded-xl bg-panel px-5 py-4">
              <SkeletonBar className="w-[58%]" />
              <SkeletonBar className="mt-2 h-2.5 w-[34%]" />
            </Skeleton>
          </div>
        ),
      },
    ],
  },

  // ── List skeleton ────────────────────────────────────────────────────
  {
    group: "List skeleton",
    title: "Variants",
    specimens: [
      {
        name: "cards · 4 rows",
        width: 480,
        node: (
          <div className="w-full">
            <ListSkeleton {...settled} rows={4} variant="cards" />
          </div>
        ),
      },
      {
        name: "rows · 4 rows · in card list",
        width: 480,
        on: "--bg-surface",
        node: (
          <div className="flex w-full p-4">
            <Card className="w-full overflow-hidden">
              <ListSkeleton {...settled} rows={4} variant="rows" />
            </Card>
          </div>
        ),
      },
      {
        name: "bare · 6 rows",
        width: 280,
        node: (
          <div className="w-full">
            <ListSkeleton {...settled} rows={6} variant="bare" />
          </div>
        ),
      },
    ],
  },

  // ── Transcript skeleton ──────────────────────────────────────────────
  {
    group: "Transcript skeleton",
    title: "Default",
    specimens: [
      {
        name: "transcript · default",
        width: 720,
        node: (
          <div className="w-full">
            <TranscriptSkeleton {...settled} />
          </div>
        ),
      },
    ],
  },

  // ── Inline alert ─────────────────────────────────────────────────────
  {
    group: "Inline alert",
    title: "Tones",
    specimens: [
      {
        name: "error · text",
        width: 480,
        node: (
          <InlineAlert className="w-full">
            Couldn't reach the server. Check your connection.
          </InlineAlert>
        ),
      },
      {
        name: "warn · text",
        width: 480,
        node: (
          <InlineAlert className="w-full" variant="warn">
            This worktree has uncommitted changes.
          </InlineAlert>
        ),
      },
      {
        name: "info · text",
        width: 480,
        node: (
          <InlineAlert className="w-full" variant="info">
            Runs pause while the workspace is archived.
          </InlineAlert>
        ),
      },
      {
        name: "error · title",
        width: 480,
        node: (
          <InlineAlert className="w-full" title="Run failed">
            The Stripe API key for the finance workspace has expired.
          </InlineAlert>
        ),
      },
      {
        name: "warn · title",
        width: 480,
        node: (
          <InlineAlert className="w-full" variant="warn" title="Review needed">
            2 files changed outside the session's worktree.
          </InlineAlert>
        ),
      },
      {
        name: "info · title",
        width: 480,
        node: (
          <InlineAlert
            className="w-full"
            variant="info"
            title="Automation scheduled"
          >
            Next run starts tomorrow at 09:00.
          </InlineAlert>
        ),
      },
    ],
  },
  {
    group: "Inline alert",
    title: "Actions",
    specimens: [
      {
        name: "error · retry",
        width: 480,
        node: (
          <InlineAlert className="w-full" onRetry={noop}>
            Couldn't load the review.
          </InlineAlert>
        ),
      },
      {
        name: "error · dismiss",
        width: 480,
        node: (
          <InlineAlert className="w-full" onDismiss={noop}>
            Session name can't be empty.
          </InlineAlert>
        ),
      },
      {
        name: "error · retry + dismiss",
        width: 480,
        node: (
          <InlineAlert
            className="w-full"
            title="Sync failed"
            onRetry={noop}
            onDismiss={noop}
          >
            GitHub returned 502 while fetching pull requests.
          </InlineAlert>
        ),
      },
      {
        name: "warn · retry + dismiss",
        width: 480,
        node: (
          <InlineAlert
            className="w-full"
            variant="warn"
            onRetry={noop}
            retryLabel="Reconnect"
            onDismiss={noop}
          >
            Slack disconnected an hour ago.
          </InlineAlert>
        ),
      },
      {
        name: "info · dismiss",
        width: 480,
        node: (
          <InlineAlert className="w-full" variant="info" onDismiss={noop}>
            New sessions now start in a fresh worktree.
          </InlineAlert>
        ),
      },
    ],
  },

  // ── Text shimmer ─────────────────────────────────────────────────────
  {
    group: "Text shimmer",
    title: "Sweep",
    specimens: [
      {
        name: "activity · resting",
        node: (
          <TextShimmer className="text-meta font-medium text-dim [--text-shimmer-highlight:var(--reasoning-shimmer-contrast)]">
            Thinking
          </TextShimmer>
        ),
      },
      {
        name: "activity · mid sweep",
        node: (
          <TextShimmer className="text-meta font-medium text-dim [--text-shimmer-highlight:var(--reasoning-shimmer-contrast)] [--text-shimmer-delay:-1s]">
            Thinking
          </TextShimmer>
        ),
      },
      {
        name: "reasoning · resting",
        node: (
          <TextShimmer className="text-body leading-6 text-dim [--text-shimmer-highlight:var(--reasoning-shimmer-contrast)]">
            Planning the payout reconciliation
          </TextShimmer>
        ),
      },
      {
        name: "reasoning · mid sweep",
        node: (
          <TextShimmer className="text-body leading-6 text-dim [--text-shimmer-highlight:var(--reasoning-shimmer-contrast)] [--text-shimmer-delay:-1s]">
            Planning the payout reconciliation
          </TextShimmer>
        ),
      },
    ],
  },

  // ── Copy check ───────────────────────────────────────────────────────
  {
    group: "Copy check",
    title: "States",
    specimens: [
      {
        name: "copy · idle",
        select: SETTLE,
        node: <CopyCheck copied={false} idle={<IconCopy size={20} />} />,
      },
      {
        name: "copy · copied",
        select: SETTLE,
        node: <CopyCheck copied idle={<IconCopy size={20} />} />,
      },
      {
        name: "link · idle",
        select: SETTLE,
        node: <CopyCheck copied={false} idle={<IconLink size={20} />} />,
      },
      {
        name: "link · copied",
        select: SETTLE,
        node: <CopyCheck copied idle={<IconLink size={20} />} />,
      },
      {
        name: "in button · idle",
        select: SETTLE,
        node: (
          <Button
            variant="ghost"
            aria-label="Copy link"
            icon={<CopyCheck copied={false} idle={<IconLink size={20} />} />}
          />
        ),
      },
      {
        name: "in button · copied",
        select: SETTLE,
        node: (
          <Button
            variant="ghost"
            aria-label="Copy link"
            icon={<CopyCheck copied idle={<IconLink size={20} />} />}
          />
        ),
      },
    ],
  },

  // ── Device code ──────────────────────────────────────────────────────
  {
    group: "Device code",
    title: "States",
    specimens: (["default", "hover", "pressed", "focus"] as const).map(
      (st) => ({
        name: `code · ${st}`,
        node: (
          <Force attrs={forceState(st) as Record<string, string>}>
            <DeviceCode code="4A56-C7AE" />
          </Force>
        ),
      }),
    ),
  },

  // ── Data grid ────────────────────────────────────────────────────────
  {
    group: "Data grid",
    title: "Grids",
    specimens: [
      {
        name: "grid · static",
        width: 720,
        node: <DataGrid columns={GRID_COLUMNS} rows={GRID_ROWS} />,
      },
      {
        name: "grid · sortable · asc",
        width: 720,
        node: (
          <DataGrid
            columns={GRID_COLUMNS}
            rows={GRID_ROWS}
            sort={{ column: "runs", dir: "asc" }}
            onSort={noop}
          />
        ),
      },
      {
        name: "grid · sortable · desc",
        width: 720,
        node: (
          <DataGrid
            columns={GRID_COLUMNS}
            rows={GRID_ROWS}
            sort={{ column: "title", dir: "desc" }}
            onSort={noop}
          />
        ),
      },
      {
        name: "grid · empty",
        width: 720,
        node: <DataGrid columns={GRID_COLUMNS} rows={[]} />,
      },
    ],
  },
  {
    group: "Data grid",
    title: "Rows",
    specimens: [
      {
        name: "row · hover",
        width: 720,
        node: (
          <Force
            target="tbody tr:nth-child(2)"
            attrs={{ "data-force-hover": "" }}
          >
            <DataGrid columns={GRID_COLUMNS} rows={GRID_ROWS} />
          </Force>
        ),
      },
    ],
  },

  // ── Overflow fade text ───────────────────────────────────────────────
  {
    group: "Overflow fade text",
    title: "Fit",
    specimens: [
      {
        name: "text · fits",
        width: 240,
        node: (
          <OverflowFadeText className="block text-label text-fg">
            Wallet pass redesign
          </OverflowFadeText>
        ),
      },
      {
        name: "text · overflows",
        width: 240,
        node: (
          <OverflowFadeText className="block text-label text-fg">
            Reconcile September Stripe payouts with the ledger
          </OverflowFadeText>
        ),
      },
      {
        name: "meta · overflows",
        width: 160,
        node: (
          <OverflowFadeText className="block text-meta text-dim">
            feat/wallet-pass-apple-and-google
          </OverflowFadeText>
        ),
      },
    ],
  },

  // ── Fold ─────────────────────────────────────────────────────────────
  {
    group: "Fold",
    title: "States",
    specimens: (["open", "closed"] as const).map((st) => ({
      name: `fold · ${st}`,
      width: 480,
      node: (
        <div className="flex w-full flex-col">
          <div className="flex items-center gap-1.5 py-1 text-label font-semibold text-fg">
            <IconChevronRight
              size={14}
              className={st === "open" ? "rotate-90 text-faint" : "text-faint"}
            />
            Ran 3 commands
            <span className="text-meta font-normal text-faint">· 12s</span>
          </div>
          <Fold open={st === "open"}>
            <div className="flex flex-col gap-1 pt-2 pl-5 font-mono text-meta text-dim">
              <div>bun test packages/wallet</div>
              <div>bun run typecheck</div>
              <div>git diff --stat</div>
            </div>
          </Fold>
        </div>
      ),
    })),
  },

  // ── Disclosure ───────────────────────────────────────────────────────
  {
    group: "Disclosure",
    title: "States",
    specimens: [
      {
        name: "disclosure · closed",
        width: 480,
        node: (
          <Disclosure className="w-full" title="Manifest JSON">
            <pre className="m-0 rounded-control bg-panel p-2.5 font-mono text-meta leading-relaxed text-dim">{`{ "name": "Open Session" }`}</pre>
          </Disclosure>
        ),
      },
      {
        name: "disclosure · closed · hover",
        width: 480,
        node: (
          <Force attrs={{ "data-force-hover": "" }}>
            <Disclosure className="w-full" title="Manifest JSON">
              <pre className="m-0">{"{}"}</pre>
            </Disclosure>
          </Force>
        ),
      },
      {
        name: "disclosure · closed · focus",
        width: 480,
        node: (
          <Force attrs={{ "data-force-focus": "" }}>
            <Disclosure className="w-full" title="Manifest JSON">
              <pre className="m-0">{"{}"}</pre>
            </Disclosure>
          </Force>
        ),
      },
      {
        name: "disclosure · open",
        width: 480,
        node: (
          <Disclosure className="w-full" title="Manifest JSON" defaultOpen>
            <pre className="m-0 rounded-control bg-panel p-2.5 font-mono text-meta leading-relaxed text-dim">{`{
  "display_information": { "name": "Open Session" },
  "features": { "bot_user": { "display_name": "sessions" } }
}`}</pre>
          </Disclosure>
        ),
      },
      {
        name: "disclosure · open · actions",
        width: 480,
        node: (
          <Disclosure
            className="w-full"
            title="Setup recipe"
            defaultOpen
            actions={
              <Button
                size="sm"
                variant="ghost"
                trailing={<IconArrowUpRight size={20} />}
              >
                Docs
              </Button>
            }
          >
            <div className="text-supporting text-dim">
              Create an API key in the provider dashboard, then paste it under
              Model providers.
            </div>
          </Disclosure>
        ),
      },
      {
        name: "disclosure · closed · long title",
        width: 280,
        node: (
          <Disclosure
            className="w-full"
            title="Instructions for reconciling September Stripe payouts"
          >
            <div />
          </Disclosure>
        ),
      },
    ],
  },

  // ── Swipe card / Deck done ───────────────────────────────────────────
  {
    group: "Swipe card",
    title: "Card",
    specimens: [
      {
        name: "card · ticket",
        width: 480,
        on: "--bg-surface",
        select: SETTLE,
        node: (
          <div className="relative flex w-full p-4">
            <SwipeCard
              className="relative z-10 w-full"
              custom={null}
              exitFor={() => "left"}
              exitDistance={640}
              stampLeft="Spam"
              stampRight="Skip"
              onSwipeLeft={noop}
              onSwipeRight={noop}
            >
              <div className="shrink-0 border-b border-divider px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
                  <span className="font-semibold text-dim">Maya Chen</span>
                  <span className="truncate">maya@northwind.dev</span>
                  <span>·</span>
                  <span>2d old</span>
                </div>
                <div className="mt-1 text-item-title font-semibold leading-snug text-fg">
                  Wallet pass doesn't update after a refund
                </div>
              </div>
              <div className="flex flex-col gap-3 px-5 py-4">
                <div className="text-label leading-relaxed text-dim">
                  We refunded an order yesterday but the pass in Apple Wallet
                  still shows the old balance.
                </div>
              </div>
            </SwipeCard>
          </div>
        ),
      },
    ],
  },
  {
    group: "Deck done",
    title: "Variants",
    specimens: [
      {
        name: "done · default",
        width: 480,
        node: (
          <div className="flex w-full py-6">
            <DeckDone
              emoji="🎉"
              title="Queue clear"
              message="You went through 14 tickets."
              onExit={noop}
            />
          </div>
        ),
      },
      {
        name: "done · secondary",
        width: 480,
        node: (
          <div className="flex w-full py-6">
            <DeckDone
              emoji="✅"
              title="All caught up"
              message="You reviewed 9 sessions and kept 3 pull requests."
              secondary={{ label: "Deal 3 kept PRs", onClick: noop }}
              onExit={noop}
            />
          </div>
        ),
      },
    ],
  },

  // ── Bar strip ────────────────────────────────────────────────────────
  {
    group: "Bar strip",
    title: "Trigger history",
    specimens: [
      {
        name: "history · 30 days · baseline",
        node: (
          <div className="flex items-end gap-2">
            <BarStrip
              bars={historyBars}
              width={30 * 9}
              height={26}
              gap={2}
              radius={3}
              baseline
              ariaLabel="Trigger history: 31 runs in the last 30 days"
              className="-mr-0.5 shrink-0"
            />
            <span className="pb-px text-meta leading-none text-faint">
              31 runs · last 30d
            </span>
          </div>
        ),
      },
      {
        name: "history · 30 days · compact",
        node: (
          <BarStrip
            bars={historyBars}
            width={30 * 9}
            height={26}
            gap={2}
            radius={3}
            baseline
            ariaLabel="Trigger history: 31 runs in the last 30 days"
          />
        ),
      },
    ],
  },
  {
    group: "Bar strip",
    title: "Signal",
    specimens: [
      {
        name: "signal · threshold · default",
        node: (
          <BarStrip
            bars={signalBars(6)}
            width={480}
            height={36}
            gap={2}
            radius={2}
            threshold={0.6}
            ariaLabel="Checkout error rate"
          />
        ),
      },
      {
        name: "signal · threshold · active bar",
        node: (
          <BarStrip
            bars={signalBars(6)}
            width={480}
            height={36}
            gap={2}
            radius={2}
            threshold={0.6}
            activeIndex={14}
            ariaLabel="Checkout error rate"
          />
        ),
      },
      {
        name: "signal · mini · default",
        node: (
          <BarStrip
            bars={signalBars(0)}
            width={120}
            height={20}
            gap={1.5}
            radius={1}
            ariaLabel="Checkout error rate, recent observations"
          />
        ),
      },
    ],
  },
  {
    group: "Bar strip",
    title: "Tones",
    specimens: [
      {
        name: "tones · all",
        node: (
          <BarStrip
            bars={TONE_BARS}
            width={7 * 16}
            height={36}
            gap={4}
            radius={3}
            baseline
            ariaLabel="Bar tones"
          />
        ),
      },
    ],
  },

  // ── Chart tooltip ────────────────────────────────────────────────────
  {
    group: "Chart tooltip",
    title: "Readouts",
    specimens: [
      {
        name: "tooltip · series",
        node: (
          // Padded so the popup's ring shadow is inside the capture.
          <div className="flex p-3">
            <ChartTooltip className="relative">
              <div className="mb-1 text-meta font-semibold text-fg">Oct 21</div>
              {(
                [
                  ["var(--accent)", "Sessions", "42"],
                  ["var(--green)", "Merged PRs", "17"],
                  ["var(--text-faint)", "Automation runs", "128"],
                ] as const
              ).map(([color, label, value]) => (
                <div
                  key={label}
                  className="flex items-center gap-1.5 whitespace-nowrap text-meta leading-4.5"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: color }}
                  />
                  <span className="text-dim">{label}</span>
                  <span className="ml-auto pl-3 font-medium tabular-nums text-fg">
                    {value}
                  </span>
                </div>
              ))}
            </ChartTooltip>
          </div>
        ),
      },
      {
        name: "tooltip · signal sample",
        node: (
          // Padded so the popup's ring shadow is inside the capture.
          <div className="flex p-3">
            <ChartTooltip className="relative">
              <div className="mb-1 text-meta font-semibold text-fg">
                14:32 · 9% errors
              </div>
              <div className="text-meta text-dim">
                Above the 6% threshold for 4 minutes
              </div>
            </ChartTooltip>
          </div>
        ),
      },
    ],
  },

  // ── Countdown ────────────────────────────────────────────────────────
  {
    group: "Countdown",
    title: "Formats",
    specimens: [
      {
        name: "seconds · in undo button",
        node: (
          <MotionConfig reducedMotion="always">
            <Button
              variant="ghost"
              icon={<IconUndo size={20} />}
              iconTone="full"
              aria-label="Undo merge, 8 left"
              className="shrink-0 pr-2 text-dim"
            >
              <CountdownDigits deadline={inSeconds(8)} format="seconds" />
            </Button>
          </MotionConfig>
        ),
      },
      {
        name: "seconds · in undo button · sm",
        node: (
          <MotionConfig reducedMotion="always">
            <Button
              variant="ghost"
              size="sm"
              icon={<IconUndo size={18} />}
              iconTone="full"
              aria-label="Undo merge, 8 left"
              className="shrink-0 pr-2 text-dim"
            >
              <CountdownDigits deadline={inSeconds(8)} format="seconds" />
            </Button>
          </MotionConfig>
        ),
      },
      {
        name: "clock · in danger button",
        node: (
          <MotionConfig reducedMotion="always">
            <Button
              variant="danger"
              size="lg"
              icon={<IconUndo size={20} />}
              aria-label="Cancel deploy, 5:48 left"
            >
              <span className="inline-flex items-center">
                {"Cancel deploy\u00a0·\u00a0"}
                <CountdownDigits deadline={inSeconds(348)} format="clock" />
              </span>
            </Button>
          </MotionConfig>
        ),
      },
      {
        name: "clock · bare",
        node: (
          <MotionConfig reducedMotion="always">
            <span className="text-label text-dim">
              <CountdownDigits deadline={inSeconds(348)} format="clock" />
            </span>
          </MotionConfig>
        ),
      },
    ],
  },

  // ── Detail key ───────────────────────────────────────────────────────
  {
    group: "Detail key",
    title: "Grid",
    specimens: [
      {
        name: "grid · automation configuration",
        width: 480,
        node: (
          <div className="grid w-full grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2 text-label">
            <DetailKey>Trigger</DetailKey>
            <span className="min-w-0 text-dim">Every weekday at 9:00</span>
            <DetailKey>Mode</DetailKey>
            <span className="text-dim">
              Code · isolated worktree, can open PRs
            </span>
            <DetailKey>Environment</DetailKey>
            <span className="text-dim">wallet · mac-mini-02</span>
            <DetailKey>Model</DetailKey>
            <span className="text-dim">Opus 4.5 (default)</span>
          </div>
        ),
      },
      { name: "key · alone", node: <DetailKey>Schedule</DetailKey> },
    ],
  },

  // ── Meter ────────────────────────────────────────────────────────────
  {
    group: "Meter",
    title: "Track",
    specimens: [
      ...(
        [
          ["normal", 42],
          ["warn", 78],
          ["high", 96],
          ["unknown", null],
        ] as const
      ).map(([tone, pct]) => ({
        name: `track · ${tone} · ${pct === null ? "no value" : `${pct}%`}`,
        width: 240,
        node: <MeterTrack className="w-full" pct={pct} />,
      })),
      {
        name: "track · progress · full",
        width: 240,
        node: <MeterTrack className="w-full" pct={100} tone="normal" />,
      },
      {
        name: "track · progress · indeterminate",
        width: 240,
        node: (
          <MeterTrack
            // Animations are paused at 0, where the fill is still off the
            // left edge; start the capture partway through the sweep.
            className="w-full [&>div]:[animation-delay:-0.6s]"
            pct={null}
            tone="normal"
            indeterminate
            aria-label="Gmail import"
            aria-valuetext="Reading INBOX"
          />
        ),
      },
    ],
  },
  {
    group: "Meter",
    title: "Group",
    specimens: [
      {
        name: "group · desktop · three windows",
        width: 480,
        node: (
          <MeterGroup>
            <Meter label="5 hour" pct={34} value="34%" note="Resets 14:20" />
            <Meter label="Weekly" pct={76} value="76%" note="Resets Mon" />
            <Meter label="Weekly Opus" pct={93} value="93%" note="Resets Mon" />
          </MeterGroup>
        ),
      },
      {
        name: "group · desktop · unknown",
        width: 480,
        node: (
          <MeterGroup>
            <Meter label="5 hour" pct={null} value="–" />
            <Meter label="Spend cap" pct={12} value="$6 of $50" />
          </MeterGroup>
        ),
      },
      {
        name: "group · phone · three windows",
        width: 358,
        viewport: 390,
        node: (
          <MeterGroup>
            <Meter label="5 hour" pct={34} value="34%" note="Resets 14:20" />
            <Meter label="Weekly" pct={76} value="76%" note="Resets Mon" />
            <Meter label="Weekly Opus" pct={93} value="93%" note="Resets Mon" />
          </MeterGroup>
        ),
      },
    ],
  },
];

export const descriptions: Record<string, string> = {
  Badge:
    "ui/badge.tsx · a non-pressable label that reports state, soft by default and outline on filled surfaces",
  Card: "ui/card.tsx · a borderless panel on its own fill, or a divided list of rows inside one",
  Spinner:
    "ui/spinner.tsx · a small element waiting on a fetch, upload or save",
  "Page loader":
    "ui/page-loader.tsx · a whole page, pane or region that has nothing in it yet",
  "Pulse dot": "ui/status.tsx · a bare liveness dot for work in progress",
  "Working pill":
    "ui/status.tsx · the yellow pill that marks a session or run as in progress",
  "Empty state":
    "ui/state.tsx · a region, card or row with nothing in it, with an optional title and action",
  "Loading state":
    "ui/state.tsx · something working when the shape of the result is not known",
  Skeleton:
    "ui/state.tsx · ghost bars standing in for content whose shape is known",
  "List skeleton":
    "ui/state.tsx · a list that has not arrived yet, in the shape of its rows",
  "Transcript skeleton":
    "ui/state.tsx · a session conversation that is still loading",
  "Inline alert":
    "ui/state.tsx · an error, warning or note inline in a form or panel, with retry or dismiss",
  "Text shimmer":
    "ui/text-shimmer.tsx · a short activity label while a model is thinking",
  "Copy check":
    "ui/copy.tsx · an icon that swaps to a drawn check after copying",
  "Device code":
    "ui/device-code.tsx · a one-time device code someone must copy to another site",
  "Data grid":
    "ui/data-grid.tsx · tabular rows the person scans, like a database table or query result",
  "Overflow fade text":
    "ui/overflow-fade-text.tsx · single-line text that fades out instead of an ellipsis when it overflows",
  Fold: "ui/fold.tsx · the animated panel half of a fold whose trigger row is your own",
  Disclosure:
    "ui/disclosure.tsx · a titled block of reference material that opens in place",
  "Swipe card":
    "ui/swipe-deck.tsx · the draggable card in a swipe deck, flung left or right to act",
  "Deck done":
    "ui/swipe-deck.tsx · the end-of-deck recap once every card is dealt with",
  "Bar strip":
    "ui/bar-strip.tsx · one row of status bars, for trigger history and incident signals",
  "Chart tooltip":
    "ui/chart-tooltip.tsx · the opaque readout a chart raises under the pointer",
  Countdown:
    "ui/countdown.tsx · time left until a deadline, rolling in a fixed-width slot",
  "Detail key":
    "ui/detail-key.tsx · the left column of a detail drawer's key and value grid",
  Meter:
    "ui/meter.tsx · a 4px usage or progress track, alone or as compact limit windows",
};
