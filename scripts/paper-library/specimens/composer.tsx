import * as React from "react";
import { createPortal } from "react-dom";
import { Composer } from "../../../packages/core/opensession-server/src/frontend/components/Composer";
import { ComposerContextChip } from "../../../packages/core/opensession-server/src/frontend/components/ComposerContextChip";
import { QuoteContext } from "../../../packages/core/opensession-server/src/frontend/components/QuoteContext";
import { PastedTextContext } from "../../../packages/core/opensession-server/src/frontend/components/PastedTextContext";
import { FileChips } from "../../../packages/core/opensession-server/src/frontend/components/FileChips";
import { ImageThumbs } from "../../../packages/core/opensession-server/src/frontend/components/ImageThumbs";
import { ModelEffortSelect } from "../../../packages/core/opensession-server/src/frontend/components/ModelEffortSelect";
import { ModelMenuRow } from "../../../packages/core/opensession-server/src/frontend/components/ModelMenuRow";
import { ModelMark } from "../../../packages/core/opensession-server/src/frontend/components/ModelMark";
import { NavigationContext } from "../../../packages/core/opensession-server/src/frontend/hooks/useNavigation";
import { saveDraft } from "../../../packages/core/opensession-server/src/frontend/lib/drafts";
import { AGENT_NAME } from "../../../packages/core/opensession-server/src/frontend/lib/brand";
import { palettePill } from "../../../packages/core/opensession-server/src/frontend/lib/palette-classes";
import { composerToolbarPill } from "../../../packages/core/opensession-server/src/frontend/lib/composer-classes";
import { cn } from "../../../packages/core/opensession-server/src/frontend/ui/cn";
import {
  IconEye,
  IconFolder,
  IconNote,
} from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type {
  ModelOption,
  ProviderAccountOption,
} from "../../../packages/core/opensession-server/src/frontend/lib/api";
import type {
  ComposerConfig,
  ComposerActions,
} from "../../../packages/core/opensession-server/src/frontend/lib/composer-types";
import { SessionHeader } from "../../../packages/core/opensession-server/src/frontend/components/session/SessionHeader";
import { SessionTabs } from "../../../packages/core/opensession-server/src/frontend/components/SessionTabs";
import { AppMobileHeader } from "../../../packages/core/opensession-server/src/frontend/components/AppMobileHeader";
import { TitleBar } from "../../../packages/core/opensession-server/src/frontend/components/TitleBar";
import { NewSession } from "../../../packages/core/opensession-server/src/frontend/components/NewSession";
import { NewSessionPrompt } from "../../../packages/core/opensession-server/src/frontend/components/NewSessionPrompt";
import { RepoTile } from "../../../packages/core/opensession-server/src/frontend/components/RepoTile";
import { UserAvatar } from "../../../packages/core/opensession-server/src/frontend/components/UserAvatar";
import { UsageMeter } from "../../../packages/core/opensession-server/src/frontend/components/UsageMeter";
import { Button } from "../../../packages/core/opensession-server/src/frontend/ui/button";
import { Menu } from "../../../packages/core/opensession-server/src/frontend/ui/menu";
import { Tooltip } from "../../../packages/core/opensession-server/src/frontend/ui/tooltip";
import { CopyCheck } from "../../../packages/core/opensession-server/src/frontend/ui/copy";
import { PulseDot } from "../../../packages/core/opensession-server/src/frontend/ui/status";
import {
  dedupeViewers,
  facepileAvatarStyle,
} from "../../../packages/core/opensession-server/src/frontend/lib/presence";
import {
  HEADER_SESSIONBAR,
  HEADER_SESSIONBAR_MODEL,
  HEADER_SESSIONBAR_SEP,
  HEADER_SESSIONBAR_USAGE,
} from "../../../packages/core/opensession-server/src/frontend/lib/app-header-classes";
import {
  VIEWER_OVERFLOW,
  VIEWER_PRESENCE,
  VIEWER_PRESENCE_AVATAR,
} from "../../../packages/core/opensession-server/src/frontend/lib/session-viewer-classes";
import {
  IconDotsHorizontal,
  IconLink,
  IconSidebarRight,
  IconGlobe,
  IconArchive,
} from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type {
  UnifiedSession,
  Workspace,
} from "../../../packages/core/opensession-server/src/frontend/lib/types";
import type { Section } from "../entry";

const noop = () => {};

/* ── Mock data ─────────────────────────────────────────────────────────── */

const MODELS: ModelOption[] = [
  {
    id: "pi/anthropic/claude-opus-5-5",
    provider: "pi",
    label: "Opus 5.5",
    aliases: [],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    accountProvider: "claude",
    fastModeSupported: true,
  },
  {
    id: "pi/anthropic/claude-sonnet-5-5",
    provider: "pi",
    label: "Sonnet 5.5",
    aliases: [],
    efforts: ["low", "medium", "high"],
    accountProvider: "claude",
  },
  {
    id: "pi/anthropic/claude-haiku-5-5",
    provider: "pi",
    label: "Haiku 5.5",
    aliases: [],
    efforts: ["low", "medium", "high"],
    accountProvider: "claude",
  },
  {
    id: "pi/openai/gpt-6.1-sol",
    provider: "pi",
    label: "GPT-6.1 Sol",
    aliases: [],
    efforts: ["low", "medium", "high"],
    accountProvider: "codex",
  },
];
const OPUS = MODELS[0].id;
const SONNET = MODELS[1].id;

const ACCOUNTS: ProviderAccountOption[] = [
  {
    id: "acc-team",
    name: "Team Max",
    provider: "claude",
    usable: true,
    kind: "oauth",
  },
  {
    id: "acc-kacper",
    name: "Kacper",
    provider: "claude",
    owner: "kacper",
    usable: true,
    kind: "oauth",
  },
];

const USAGE = {
  costUsd: 4.18,
  inputTokens: 182_400,
  outputTokens: 21_300,
  cacheReadTokens: 1_240_000,
  cacheCreationTokens: 96_000,
  contextTokens: 64_200,
  contextWindow: 200_000,
  turns: 14,
  updatedAt: "2025-09-30T10:12:00.000Z",
};

// Drafts live in sessionStorage, which survives from one specimen's page load
// to the next: start every specimen from an empty store.
try {
  sessionStorage.clear();
} catch {}

// Recent models show at the top of the open model menu.
try {
  localStorage.setItem(
    "opensession-recent-models",
    JSON.stringify([SONNET, OPUS]),
  );
} catch {}

// Pasted-text chips come from the draft store, keyed by the composer's draftKey.
const PASTED_KEY = "paper-composer-pasted";
saveDraft(PASTED_KEY, {
  text: "",
  pastedTexts: [
    {
      id: "paste-1",
      text: Array.from(
        { length: 48 },
        (_, i) =>
          `2025-09-30T09:${String(i).padStart(2, "0")}:12Z worker[export] rss=${(612 + i * 9.5).toFixed(1)}MB heap=${(410 + i * 7).toFixed(0)}MB`,
      ).join("\n"),
    },
  ],
});

/** A mock screenshot of the wallet pass, as the data URL the composer expects. */
const shot = (tone: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#f4f1ea"/><rect x="96" y="24" width="128" height="192" rx="14" fill="${tone}"/><rect x="112" y="48" width="64" height="10" rx="5" fill="#fff" opacity=".85"/><rect x="112" y="68" width="96" height="6" rx="3" fill="#fff" opacity=".5"/><rect x="128" y="140" width="64" height="64" rx="6" fill="#fff"/><text x="160" y="232" font-family="system-ui" font-size="11" text-anchor="middle" fill="#555">${label}</text></svg>`,
  )}`;
const IMAGES = [shot("#1f6feb", "Pass front"), shot("#0f2d52", "Pass back")];

const FILES = [
  {
    name: "heap-snapshot-0930.heapsnapshot",
    type: "application/octet-stream",
    path: "/tmp/uploads/heap-snapshot-0930.heapsnapshot",
  },
  {
    name: "stripe-payouts-september.csv",
    type: "text/csv",
    path: "/tmp/uploads/stripe-payouts-september.csv",
  },
];

const NAV = new Proxy({}, { get: () => noop }) as any;

/* ── Composer harness ─────────────────────────────────────────────────── */

const BASE_CONFIG: ComposerConfig = {
  placeholder: `Ask ${AGENT_NAME}…`,
  models: MODELS,
  defaultModel: OPUS,
  model: "",
  effort: "high",
  speed: "standard",
  accounts: ACCOUNTS,
  accountId: "",
  usage: USAGE,
  images: [],
  files: [],
  modelTitle: "Switch the model for this session",
};

const BASE_ACTIONS: ComposerActions = {
  onSend: () => false,
  onModelChange: noop,
  onEffortChange: noop,
  onAutoFallbackChange: noop,
  onSpeedChange: noop,
  onAccountChange: noop,
  onImagesChange: noop,
  onFilesChange: noop,
  onAddAttachments: noop,
  onRemovePendingImage: noop,
  onRemovePendingFile: noop,
  onQuoteClear: noop,
  onNoteModeChange: noop,
  onSetGoal: noop,
  onStop: noop,
};

function C({
  value,
  config,
  actions,
  attached,
}: {
  value?: string;
  config?: Partial<ComposerConfig>;
  actions?: Partial<ComposerActions>;
  attached?: React.ReactNode;
}) {
  return (
    <NavigationContext value={NAV}>
      <div className="w-full bg-surface px-5 pb-5 pt-3">
        <Composer
          value={value}
          onChange={value === undefined ? undefined : noop}
          config={{ ...BASE_CONFIG, ...config }}
          actions={{ ...BASE_ACTIONS, ...actions }}
          attached={attached}
        />
      </div>
    </NavigationContext>
  );
}

/** Focus the field with the caret at the end, as if the person just typed:
 *  typing autocomplete only asks while the field is focused, and a phone
 *  composer only expands (and shows a prediction) while it is. */
const focusField = (root: HTMLElement) => {
  const el = root.querySelector<HTMLTextAreaElement>(
    "textarea.composer-textarea",
  );
  if (!el) return;
  el.focus();
  el.selectionStart = el.selectionEnd = el.value.length;
};

/** Stands in for the server's typing autocomplete. */
const COMPLETE = async (draft: string) =>
  draft.endsWith("backpressured")
    ? " stream and keep the column order the finance sheet expects"
    : null;

const PREDICTION =
  "Run the export against the September backfill and report the peak RSS.";

const DESK = 820;
const PHONE = 390;

const TEXT_SHORT =
  "Pull the pass colour from the merchant brand instead of hardcoding blue.";
const TEXT_LONG =
  "The export worker climbs past 2 GB after about 40 minutes and gets OOM-killed. Heap snapshot attached.\n\n" +
  "I think the CSV stream is buffering every row before it writes. Can you check `exportPayouts()` in workers/export.ts and switch it to a backpressured stream? Keep the existing column order so the finance sheet still lines up.";

/* ── Model select harness ─────────────────────────────────────────────── */

function MES({
  open,
  sub,
  model = "",
  effort = "high",
  speed = "standard",
  variant = "pill",
  disabled,
  modelDisabled,
  hover,
}: {
  hover?: boolean;
  open?: boolean;
  /** Also open this row's submenu ("Model", "Effort") and mark its popup. */
  sub?: string;
  model?: string;
  effort?: string;
  speed?: "standard" | "fast";
  variant?: "pill" | "menu-row" | "hero" | "field";
  disabled?: boolean;
  modelDisabled?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    // The trigger finishes a touch itself (see ModelEffortSelect), which is
    // the one open path that does not need a real pointer.
    ref.current
      ?.querySelector("button")
      ?.dispatchEvent(
        new Event("touchend", { bubbles: true, cancelable: true }),
      );
    if (!sub) return;
    const t1 = setTimeout(() => {
      const row = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="menu"] [role="menuitem"]',
        ),
      ].find((el) => el.textContent?.trim().startsWith(sub));
      if (!row) return;
      row.focus();
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }, 60);
    const t2 = setTimeout(() => {
      const menus = document.querySelectorAll('[role="menu"]');
      if (menus.length > 1)
        menus[menus.length - 1].setAttribute("data-paper-sub", "");
    }, 200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [open, sub]);
  return (
    <NavigationContext value={NAV}>
      <div
        ref={ref}
        data-force-hover-in={hover ? "" : undefined}
        className={cn(
          "flex",
          open && "pb-[460px]",
          (variant === "menu-row" || variant === "field") && "w-full",
        )}
      >
        <ModelEffortSelect
          selection={{
            models: MODELS,
            defaultModel: OPUS,
            model,
            preferredDefaultModel: OPUS,
            preferredDefaultEffort: "high",
            modelDisabled,
            modelTitle: modelDisabled
              ? "Set the model from the owning agent (its session file is agent-owned)"
              : undefined,
            effort,
            autoFallback: true,
            speed,
            accounts: ACCOUNTS,
            accountId: "",
            usage: USAGE,
          }}
          appearance={{
            className:
              variant === "pill"
                ? cn(palettePill, composerToolbarPill)
                : undefined,
            triggerVariant: variant,
            title: "Model and reasoning effort for this session",
            showUsage: variant !== "field",
            disabled,
          }}
          actions={{
            changeModel: noop,
            setAsDefault: noop,
            changeEffort: noop,
            changeAutoFallback: noop,
            changeSpeed: noop,
            changeAccount: noop,
          }}
        />
      </div>
    </NavigationContext>
  );
}

/* ── Fetch mock ───────────────────────────────────────────────────────────
   The new-session palette, the repo crumb and the sandbox badge load their
   catalog over /api. Serve the same mock catalog the composer uses. */

const REPOS = [
  {
    id: "habit",
    label: "habit",
    ghRepo: "tellahq/habit",
    defaultBranch: "main",
    sharedCheckout: false,
    default: true,
    color: "blue",
  },
  {
    id: "betterbahn",
    label: "betterbahn",
    ghRepo: "tellahq/betterbahn",
    defaultBranch: "main",
    sharedCheckout: false,
    color: "green",
  },
  {
    id: "franking",
    label: "franking",
    ghRepo: "tellahq/franking",
    defaultBranch: "main",
    sharedCheckout: false,
    color: "orange",
  },
  {
    id: "stacked",
    label: "stacked",
    ghRepo: "tellahq/stacked",
    defaultBranch: "main",
    sharedCheckout: false,
    color: "purple",
  },
];
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const path = new URL(url, location.href).pathname;
  if (!path.startsWith("/api/")) return realFetch(input, init);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const p = path.slice(4);
  if (p === "/repos") return json({ repos: REPOS, newSessionRepo: "habit" });
  if (p === "/models") return json({ models: MODELS, default: OPUS });
  if (p === "/worktrees") return json([]);
  if (p === "/sandbox/status")
    return json({
      enabled: false,
      defaultProvider: "",
      providers: [],
      killSwitch: false,
    });
  if (p === "/connections/mcp-oauth")
    return json({ servers: [], pending: false });
  return json({ error: "Not available in the specimen" }, 404);
}) as typeof fetch;

/* ── Sessions ─────────────────────────────────────────────────────────── */

const NOW = "2025-09-30T10:12:00.000Z";
function sess(
  p: Partial<UnifiedSession> & { id: string; title: string },
): UnifiedSession {
  return {
    source: "opensession",
    branch: "feat/wallet-pass",
    worktreeDir: "/work/habit/wallet-pass",
    startedBy: "kacper",
    createdBy: "kacper",
    lastActivity: NOW,
    createdAt: "2025-09-30T09:54:00.000Z",
    isRunning: false,
    ran: true,
    repo: "habit",
    workspaceId: "ws-wallet",
    mode: "code",
    ...p,
  } as UnifiedSession;
}

const WALLET = sess({ id: "s-wallet-front", title: "Pass front layout" });
const TAB_SESSIONS = [
  WALLET,
  sess({ id: "s-wallet-tests", title: "Pass back tests", isRunning: true }),
  sess({
    id: "s-wallet-sign",
    title: "Apple Wallet signing",
    waitingForInput: true,
  }),
  sess({ id: "s-wallet-copy", title: "Expiry copy" }),
];
const ARCHIVED = [
  sess({
    id: "s-wallet-old",
    title: "Pass colour spike",
    archived: true,
    lastActivity: "2025-09-28T16:20:00.000Z",
  }),
];
// An unsent draft in a sibling tab shows the pencil.
saveDraft("session:s-wallet-copy", {
  text: "Shorten the expiry line to fit one row",
});

const WORKSPACES: Workspace[] = [
  {
    id: "ws-wallet",
    name: "Wallet pass redesign",
    repo: "habit",
    createdBy: "kacper",
    createdAt: "2025-09-30T09:54:00.000Z",
  },
  {
    id: "ws-export",
    name: "Export worker memory spike",
    repo: "stacked",
    createdBy: "kacper",
    createdAt: "2025-09-29T13:02:00.000Z",
  },
];

/** Run a DOM tweak after mount: force a hover or open a menu by its trigger. */
function After({
  run,
  children,
  className = "flex",
}: {
  run: (root: HTMLElement) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (ref.current) run(ref.current);
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/* ── Session header ───────────────────────────────────────────────────── */

/** The ⋯ menu trigger exactly as SessionViewerChrome renders it. */
function OverflowTrigger() {
  return (
    <Menu.Root>
      <div className={VIEWER_OVERFLOW}>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="md"
              icon={<IconDotsHorizontal size={22} />}
            />
          }
          className="[corner-shape:squircle]"
          title="More actions"
          aria-label="More actions"
        />
      </div>
    </Menu.Root>
  );
}

/** The header's right-hand actions as SessionViewerChrome composes them on a
 *  wide desktop header: presence, share, then the side-panel toggle. */
function HeaderActions({
  viewers = [],
  copied,
}: {
  viewers?: string[];
  copied?: boolean;
}) {
  return (
    <>
      {viewers.length > 0 && (
        <div
          className={VIEWER_PRESENCE}
          title={`Viewing: ${viewers.join(", ")}`}
        >
          {dedupeViewers(viewers).map((v, index, all) => (
            <UserAvatar
              key={v.name}
              name={v.name}
              size={24}
              className={VIEWER_PRESENCE_AVATAR}
              style={facepileAvatarStyle(index, all.length, "var(--bg)")}
            />
          ))}
        </div>
      )}
      <Button
        size="md"
        variant="ghost"
        icon={
          <CopyCheck
            copied={!!copied}
            idle={<IconLink size={22} />}
            size={22}
          />
        }
        onClick={noop}
        title="Copy a link to this session"
        aria-label="Share"
      />
      <Tooltip label="Toggle workspace panel">
        <Button
          variant="ghost"
          size="md"
          className="rounded-control text-dim hover:bg-hover hover:text-fg phone:order-2 phone:h-[38px] phone:min-h-[38px] phone:w-[38px] phone:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] phone:text-accent"
          onClick={noop}
          aria-label="Toggle side panel"
          icon={<IconSidebarRight size={22} />}
        />
      </Tooltip>
    </>
  );
}

function Header({
  session = WALLET,
  workspaceName = "Wallet pass redesign",
  parent,
  workers,
  viewers,
  copied,
  tabStrip = true,
  count = 4,
  rename,
}: {
  session?: UnifiedSession;
  workspaceName?: string;
  parent?: { id: string; title: string };
  workers?: {
    id: string;
    title: string;
    model?: string;
    isRunning?: boolean;
  }[];
  viewers?: string[];
  copied?: boolean;
  tabStrip?: boolean;
  count?: number;
  rename?: string;
}) {
  return (
    <NavigationContext value={NAV}>
      <div className="w-full">
        <SessionHeader
          session={session}
          hasWorkspace
          workspaceName={workspaceName}
          parentSession={parent ?? null}
          workerSessions={workers}
          models={MODELS}
          openSession={noop}
          archiving={false}
          onArchive={noop}
          renameDraft={rename ?? null}
          onRenameDraftChange={noop}
          onCommitRename={noop}
          onCancelRename={noop}
          canRename
          menu={<OverflowTrigger />}
          isPhone={false}
          openNewSession={noop as any}
          tabStripVisible={tabStrip}
          workspaceSessionCount={count}
          newSiblingKeys={["⌘", "⌥", "N"]}
          actions={<HeaderActions viewers={viewers} copied={copied} />}
          headerRef={{ current: null }}
          headerActionsRef={{ current: null }}
        />
      </div>
    </NavigationContext>
  );
}

/* ── Session tabs ─────────────────────────────────────────────────────── */

function Tabs({
  sessions = TAB_SESSIONS,
  active = WALLET.id,
  views = [],
  colors = {},
  viewers = {},
  inSplit,
  history = true,
  order = [],
}: {
  order?: string[];
  sessions?: UnifiedSession[];
  active?: string | null;
  views?: {
    id: string;
    label: string;
    active: boolean;
    dotClass?: string | null;
    icon?: React.ReactNode;
    closable?: boolean;
  }[];
  colors?: Record<string, string>;
  viewers?: Record<string, string[]>;
  inSplit?: boolean;
  history?: boolean;
}) {
  return (
    // Phones pin the strip under the pane header (absolute, top: --pane-header-h),
    // so the phone frame is a positioned box with that much room above it.
    // [contain:layout] makes the frame the containing block for that pin.
    <div className="w-full desktop:pt-[11px] phone:relative phone:h-[calc(var(--header-h)+54px)] phone:bg-surface phone:[contain:layout] phone:[--pane-header-h:var(--header-h)]">
      <SessionTabs
        content={{
          sessions,
          archivedSessions: history ? ARCHIVED : [],
          activeSessionId: active,
          colors,
          viewers,
          order,
          views,
        }}
        layout={{ inSplit, showHistory: history }}
        actions={{
          selectSession: noop,
          setColor: noop,
          reorder: noop,
          selectView: noop,
          closeView: noop,
          newSession: noop,
          rename: noop,
          close: noop,
          restore: noop,
          toast: noop,
        }}
      />
    </div>
  );
}

const hoverTab = (title: string) => (root: HTMLElement) =>
  root
    .querySelector(`[role="tab"][title="${title}"]`)
    ?.setAttribute("data-force-hover", "");

/* ── Phone header ─────────────────────────────────────────────────────── */

function PhoneHeader({
  session = WALLET,
  running,
  call,
  title,
  route,
  withTabs,
}: {
  withTabs?: boolean;
  session?: UnifiedSession | null;
  running?: boolean;
  call?: boolean;
  title?: string;
  route?: any;
}) {
  const [repoEl, setRepoEl] = React.useState<HTMLElement | null>(null);
  const [modelEl, setModelEl] = React.useState<HTMLElement | null>(null);
  const isSession = !route || route.view === "session";
  return (
    <NavigationContext value={NAV}>
      {/* The session bar floats (position: fixed) over the transcript; the
          frame contains it so it lands in the specimen rather than the page. */}
      <div
        className={cn(
          "relative w-full bg-surface [contain:layout] [--pane-header-h:var(--header-h)]",
          withTabs
            ? "h-[calc(var(--header-h)+54px)]"
            : "h-[calc(var(--header-h)+8px)]",
        )}
      >
        <AppMobileHeader
          route={route ?? { view: "session", id: session?.id ?? "" }}
          mobileDetail
          currentSession={isSession ? session : null}
          activeWorkspaceId={session?.workspaceId ?? null}
          workspaces={WORKSPACES}
          connected
          addHandler={() => noop}
          navigate={noop as any}
          goBack={noop}
          returnsToSession={false}
          topbarTitle={title ?? ""}
          phoneTitleHandedOver
          commandMenuRef={{ current: null }}
          deskCallActive={!!call}
          onOpenDesk={noop}
          setAppHeaderEl={noop as any}
          setHeaderRepoEl={setRepoEl as any}
          setHeaderModelEl={setModelEl as any}
          setHeaderActionsEl={noop as any}
        />
        {/* What SessionViewerChrome portals into the header's slots on a phone. */}
        {isSession &&
          session &&
          repoEl &&
          createPortal(
            session.archived ? (
              <span role="img" aria-label="Archived" title="Archived">
                <IconArchive size={20} className="text-dim" />
              </span>
            ) : (
              <RepoTile name={session.repo || "repository"} size={18} round />
            ),
            repoEl,
          )}
        {isSession &&
          session &&
          modelEl &&
          createPortal(
            <span
              className={`${HEADER_SESSIONBAR} session-settings-trigger`}
              role="button"
              tabIndex={0}
            >
              {running && <PulseDot size={7} />}
              <span className={HEADER_SESSIONBAR_MODEL}>Opus 5.5</span>
              <span className={HEADER_SESSIONBAR_SEP} aria-hidden="true">
                ·
              </span>
              <UsageMeter usage={USAGE} className={HEADER_SESSIONBAR_USAGE} />
            </span>,
            modelEl,
          )}
        {withTabs && (
          <SessionTabs
            content={{
              sessions: TAB_SESSIONS,
              archivedSessions: [],
              activeSessionId: WALLET.id,
              colors: {},
              order: [],
              views: [],
            }}
            actions={{
              selectSession: noop,
              setColor: noop,
              reorder: noop,
              selectView: noop,
              closeView: noop,
              newSession: noop,
              rename: noop,
              close: noop,
              restore: noop,
              toast: noop,
            }}
          />
        )}
      </div>
    </NavigationContext>
  );
}

/* ── New session ──────────────────────────────────────────────────────── */

function NewSessionCard({
  mode,
  prompt,
  repo = "habit",
}: {
  mode?: "ask" | "code";
  prompt?: string;
  repo?: string;
}) {
  return (
    <NavigationContext value={NAV}>
      {/* A definite height, filled by the card (*:flex-1), so the prompt's
          flex-1 body has something to grow into once serialized. */}
      <div className="flex h-[260px] w-full flex-col *:flex-1">
        <NewSession
          inline
          onBack={noop}
          send={noop}
          addHandler={() => noop}
          connected
          prefillPrompt={prompt}
          forceMode={mode}
          forceRepo={repo}
          workspaces={WORKSPACES}
          sessions={[]}
        />
      </div>
    </NavigationContext>
  );
}

function NewSessionPalette({ prompt }: { prompt?: string }) {
  return (
    <NavigationContext value={NAV}>
      <NewSession
        onBack={noop}
        send={noop}
        addHandler={() => noop}
        connected
        prefillPrompt={prompt}
        forceRepo="habit"
        workspaces={WORKSPACES}
        sessions={[]}
      />
    </NavigationContext>
  );
}

function Prompt({
  text = "",
  images = [],
  files = [],
  staging = { images: 0, files: 0 },
  disabled = false,
  height = 150,
}: {
  text?: string;
  images?: string[];
  files?: typeof FILES;
  staging?: { images: number; files: number };
  disabled?: boolean;
  height?: number;
}) {
  return (
    // The prompt is the palette's flex-1 body; give it the room the card would.
    <div className="flex w-full flex-col" style={{ height }}>
      <NewSessionPrompt
        config={{
          initialText: text,
          repo: "habit",
          placeholder: "What do you want to work on?",
          disabled,
          images,
          files,
          pastedTexts: [],
          staging,
          sendKey: "enter",
          canCreate: !!text,
        }}
        refs={{
          textarea: { current: null },
          value: { current: "" },
          handle: { current: null },
        }}
        actions={{
          removeImage: noop,
          removeFile: noop,
          removePendingImage: noop,
          removePendingFile: noop,
          addAttachments: noop,
          addPastedText: noop,
          removePastedText: noop,
          create: noop,
          changeHasText: noop,
          settleDraft: noop,
          changeEdges: noop,
          changeMentionOpen: noop,
        }}
      />
    </div>
  );
}

/* ── Sections ─────────────────────────────────────────────────────────── */

export const sections: Section[] = [
  {
    group: "Composer",
    title: "States",
    specimens: [
      { name: "desktop · default · empty", width: DESK, node: <C /> },
      {
        name: "desktop · default · with text",
        width: DESK,
        node: <C value={TEXT_SHORT} />,
      },
      {
        name: "desktop · default · long draft",
        width: DESK,
        node: <C value={TEXT_LONG} />,
      },
      {
        name: "desktop · ask · empty",
        width: DESK,
        node: (
          <C
            config={{
              askMode: true,
              placeholder: `Ask ${AGENT_NAME}, read-only…`,
            }}
            actions={{ onAskModeExit: noop }}
          />
        ),
      },
      {
        name: "desktop · ask · switching",
        width: DESK,
        node: (
          <C
            config={{
              askMode: true,
              askExitPending: true,
              placeholder: "Setting up code workspace…",
            }}
            actions={{ onAskModeExit: noop }}
          />
        ),
      },
      {
        name: "desktop · team note · with text",
        width: DESK,
        node: (
          <C
            value="Kent, this one needs your eyes before we merge. The pass back changed."
            config={{ noteMode: true }}
          />
        ),
      },
      {
        name: "desktop · prediction · empty",
        width: DESK,
        node: <C config={{ prediction: PREDICTION }} />,
      },
      {
        name: "desktop · autocomplete · typing",
        width: DESK,
        // A select buys the capture the 400ms the 300ms pause before the
        // completion is asked for needs.
        select: "[data-paper-ghost]",
        node: (
          <div data-paper-ghost="" className="flex w-full">
            <After className="flex w-full" run={focusField}>
              <C
                value="Switch exportPayouts() to a backpressured"
                config={{ complete: COMPLETE }}
              />
            </After>
          </div>
        ),
      },
      {
        name: "desktop · disabled · paused for safety",
        width: DESK,
        node: (
          <C config={{ disabled: true, placeholder: "Paused for safety" }} />
        ),
      },
    ],
  },
  {
    group: "Composer",
    title: "Running",
    specimens: [
      {
        name: "desktop · running · empty",
        width: DESK,
        node: (
          <C
            config={{ busy: true, placeholder: "Queue for when it finishes…" }}
          />
        ),
      },
      {
        name: "desktop · running · queue a message",
        width: DESK,
        node: (
          <C
            value="Also add a test for the empty payout month."
            config={{ busy: true, placeholder: "Queue for when it finishes…" }}
          />
        ),
      },
      {
        name: "desktop · running · stopping",
        width: DESK,
        node: (
          <C
            config={{
              busy: true,
              stopping: true,
              placeholder: "Queue for when it finishes…",
            }}
          />
        ),
      },
    ],
  },
  {
    group: "Composer",
    title: "Attachments",
    specimens: [
      {
        name: "desktop · quote · with text",
        width: DESK,
        node: (
          <C
            value="Why does this run twice?"
            config={{
              quote: {
                id: "q1",
                text: "await reconcilePayouts(month); await reconcilePayouts(month);",
              },
            }}
          />
        ),
      },
      {
        name: "desktop · images · with text",
        width: DESK,
        node: (
          <C
            value="Match the back of the pass to the front."
            config={{ images: IMAGES }}
          />
        ),
      },
      {
        name: "desktop · files · with text",
        width: DESK,
        node: <C value={TEXT_SHORT} config={{ files: FILES }} />,
      },
      {
        name: "desktop · uploading · pending",
        width: DESK,
        node: (
          <C
            value="Here is the full heap dump."
            config={{
              staging: {
                images: 1,
                files: 1,
                fileProgress: [
                  {
                    name: "heap-dump-full.heapsnapshot",
                    size: 1_240_000_000,
                    fraction: 0.42,
                  },
                ],
              },
            }}
          />
        ),
      },
      {
        name: "desktop · pasted text · draft",
        width: DESK,
        node: <C config={{ draftKey: PASTED_KEY }} />,
      },
      {
        name: "desktop · everything · with text",
        width: DESK,
        node: (
          <C
            value="Compare these against the log."
            config={{
              askMode: true,
              quote: { id: "q2", text: "rss=1987.4MB heap=1730MB" },
              images: IMAGES.slice(0, 1),
              files: FILES.slice(0, 1),
            }}
            actions={{ onAskModeExit: noop }}
          />
        ),
      },
    ],
  },
  {
    group: "Composer",
    title: "Phone",
    specimens: [
      {
        name: "phone · resting · empty",
        width: PHONE,
        viewport: PHONE,
        node: <C />,
      },
      {
        name: "phone · resting · team note",
        width: PHONE,
        viewport: PHONE,
        node: <C config={{ noteMode: true }} />,
      },
      {
        name: "phone · resting · running",
        width: PHONE,
        viewport: PHONE,
        node: (
          <C
            config={{ busy: true, placeholder: "Queue for when it finishes…" }}
          />
        ),
      },
      {
        name: "phone · expanded · with text",
        width: PHONE,
        viewport: PHONE,
        node: <C value={TEXT_SHORT} />,
      },
      {
        name: "phone · expanded · prediction",
        width: PHONE,
        viewport: PHONE,
        // Focus morphs the resting pill open; a select waits out the morph.
        select: "[data-paper-morph]",
        node: (
          <div data-paper-morph="" className="flex w-full">
            <After className="flex w-full" run={focusField}>
              <C config={{ prediction: PREDICTION }} />
            </After>
          </div>
        ),
      },
      {
        name: "phone · expanded · ask with quote",
        width: PHONE,
        viewport: PHONE,
        node: (
          <C
            value="Is this safe to retry?"
            config={{
              askMode: true,
              quote: { id: "q3", text: "retryPayout(payoutId)" },
            }}
            actions={{ onAskModeExit: noop }}
          />
        ),
      },
      {
        name: "phone · expanded · running with text",
        width: PHONE,
        viewport: PHONE,
        node: (
          <C
            value="Also add a test for the empty payout month."
            config={{ busy: true }}
          />
        ),
      },
      {
        name: "phone · expanded · images",
        width: PHONE,
        viewport: PHONE,
        node: (
          <C value="Match the back to the front." config={{ images: IMAGES }} />
        ),
      },
    ],
  },

  {
    group: "Composer context chip",
    title: "Tones",
    specimens: [
      {
        name: "chip · neutral · removable",
        node: (
          <div className="p-2">
            <QuoteContext
              quote={{ id: "q", text: "await reconcilePayouts(month)" }}
              onRemove={noop}
            />
          </div>
        ),
      },
      {
        name: "chip · neutral · with meta",
        node: (
          <div className="p-2">
            <PastedTextContext
              attachment={{
                id: "p",
                text: Array.from({ length: 48 }, () => "rss=612MB").join("\n"),
              }}
              onRemove={noop}
            />
          </div>
        ),
      },
      {
        name: "chip · note · removable",
        node: (
          <div className="p-2">
            <ComposerContextChip
              icon={<IconNote size={15} />}
              label="Team note"
              title="The agent won't read this."
              tone="note"
              onRemove={noop}
              removeLabel="Leave note mode"
            />
          </div>
        ),
      },
      {
        name: "chip · ask · removable",
        node: (
          <div className="p-2">
            <ComposerContextChip
              icon={<IconEye size={15} />}
              label="Ask"
              tone="ask"
              onRemove={noop}
              removeLabel="Switch to code mode"
            />
          </div>
        ),
      },
      {
        name: "chip · ask · label only",
        node: (
          <div className="p-2">
            <ComposerContextChip
              icon={<IconEye size={15} />}
              label="Ask"
              tone="ask"
            />
          </div>
        ),
      },
      {
        name: "chip · ask · switching",
        node: (
          <div className="p-2">
            <ComposerContextChip
              icon={<IconEye size={15} />}
              label="Ask"
              meta="Switching…"
              tone="ask"
              onRemove={noop}
              removeLabel="Switch to code mode"
              disabled
            />
          </div>
        ),
      },
      {
        name: "chip · folder · removable",
        node: (
          <div className="p-2">
            <ComposerContextChip
              icon={<IconFolder size={15} />}
              label="wallet-assets"
              title="~/Design/wallet-assets will be connected to this session. It can read and edit it while this app is open."
              onRemove={noop}
              removeLabel="Don't connect wallet-assets"
            />
          </div>
        ),
      },
      {
        name: "chip · folder · read only",
        node: (
          <div className="p-2">
            <ComposerContextChip
              icon={<IconFolder size={15} />}
              label="Finance exports"
              meta="Read only"
              onRemove={noop}
              removeLabel="Don't connect Finance exports"
            />
          </div>
        ),
      },
      {
        name: "chip · neutral · disabled",
        node: (
          <div className="p-2">
            <QuoteContext
              quote={{ id: "q", text: "await reconcilePayouts(month)" }}
              onRemove={noop}
              disabled
            />
          </div>
        ),
      },
    ],
  },
  {
    group: "Composer context chip",
    title: "On tinted composer",
    specimens: [
      {
        name: "surface · note · chip",
        node: (
          <div
            className="rounded-xl p-3"
            style={{
              background:
                "color-mix(in srgb, var(--yellow) 10%, var(--composer-surface))",
            }}
          >
            <ComposerContextChip
              icon={<IconNote size={15} />}
              label="Team note"
              tone="note"
              onRemove={noop}
              removeLabel="Leave note mode"
            />
          </div>
        ),
      },
      {
        name: "surface · ask · chip",
        node: (
          <div
            className="rounded-xl p-3"
            style={{
              background:
                "color-mix(in srgb, var(--green) 7%, var(--composer-surface))",
            }}
          >
            <ComposerContextChip
              icon={<IconEye size={15} />}
              label="Ask"
              tone="ask"
              onRemove={noop}
              removeLabel="Switch to code mode"
            />
          </div>
        ),
      },
    ],
  },

  {
    group: "File chips",
    title: "States",
    specimens: [
      {
        name: "files · attached · two",
        width: 640,
        node: (
          <div className="w-full">
            <FileChips files={FILES} onRemove={noop} />
          </div>
        ),
      },
      {
        name: "files · uploading · progress",
        width: 640,
        node: (
          <div className="w-full">
            <FileChips
              files={[]}
              pending={2}
              progress={[
                {
                  name: "heap-dump-full.heapsnapshot",
                  size: 1_240_000_000,
                  fraction: 0.42,
                },
                { name: "export-worker.log", size: 18_400_000, fraction: 0 },
              ]}
              onRemove={noop}
              onRemovePending={noop}
            />
          </div>
        ),
      },
      {
        name: "files · uploading · unnamed",
        width: 640,
        node: (
          <div className="w-full">
            <FileChips
              files={[]}
              pending={1}
              onRemove={noop}
              onRemovePending={noop}
            />
          </div>
        ),
      },
      {
        name: "files · attached · disabled",
        width: 640,
        node: (
          <div className="w-full">
            <FileChips files={FILES.slice(0, 1)} onRemove={noop} disabled />
          </div>
        ),
      },
    ],
  },
  {
    group: "Image thumbs",
    title: "States",
    specimens: [
      {
        name: "images · attached · two",
        width: 640,
        node: (
          <div className="w-full">
            <ImageThumbs images={IMAGES} onRemove={noop} />
          </div>
        ),
      },
      {
        name: "images · uploading · one pending",
        width: 640,
        node: (
          <div className="w-full">
            <ImageThumbs
              images={IMAGES.slice(0, 1)}
              pending={1}
              onRemove={noop}
              onRemovePending={noop}
            />
          </div>
        ),
      },
      {
        name: "images · attached · disabled",
        width: 640,
        node: (
          <div className="w-full">
            <ImageThumbs images={IMAGES.slice(0, 1)} onRemove={noop} disabled />
          </div>
        ),
      },
    ],
  },

  {
    group: "Model and effort select",
    title: "Composer pill",
    specimens: [
      {
        name: "pill · default · idle",
        node: (
          <div className="bg-[var(--composer-surface)] p-2">
            <MES />
          </div>
        ),
      },
      {
        name: "pill · default · hover",
        node: (
          <div className="bg-[var(--composer-surface)] p-2">
            <MES hover />
          </div>
        ),
      },
      {
        name: "pill · sonnet medium · idle",
        node: (
          <div className="bg-[var(--composer-surface)] p-2">
            <MES model={SONNET} effort="medium" />
          </div>
        ),
      },
      {
        name: "pill · fast · idle",
        node: (
          <div className="bg-[var(--composer-surface)] p-2">
            <MES speed="fast" />
          </div>
        ),
      },
      {
        name: "pill · default · disabled",
        node: (
          <div className="bg-[var(--composer-surface)] p-2">
            <MES disabled />
          </div>
        ),
      },
    ],
  },
  {
    group: "Model and effort select",
    title: "Other triggers",
    specimens: [
      {
        name: "menu row · default · idle",
        width: 320,
        node: (
          <NavigationContext value={NAV}>
            <div className="w-full">
              <ModelMenuRow
                models={MODELS}
                model=""
                defaultModel={OPUS}
                onChange={noop}
                prettyLabel={(id) => id}
                effort="high"
                onEffortChange={noop}
                speed="standard"
                onSpeedChange={noop}
                accounts={ACCOUNTS}
                accountId=""
                onAccountChange={noop}
                usage={USAGE}
              />
            </div>
          </NavigationContext>
        ),
      },
      {
        name: "menu row · sonnet · hover",
        width: 320,
        node: (
          <NavigationContext value={NAV}>
            <div className="w-full" data-force-hover-in="">
              <ModelMenuRow
                models={MODELS}
                model={SONNET}
                defaultModel={OPUS}
                onChange={noop}
                prettyLabel={(id) => id}
                effort="medium"
                onEffortChange={noop}
                speed="standard"
                onSpeedChange={noop}
                accounts={ACCOUNTS}
                accountId=""
                onAccountChange={noop}
              />
            </div>
          </NavigationContext>
        ),
      },
      { name: "hero · default · idle", node: <MES variant="hero" /> },
      {
        name: "field · default · idle",
        width: 260,
        node: <MES variant="field" />,
      },
      {
        name: "field · sonnet medium · hover",
        width: 260,
        node: <MES variant="field" model={SONNET} effort="medium" hover />,
      },
    ],
  },
  {
    group: "Model and effort select",
    title: "Open menu",
    specimens: [
      {
        name: "menu · default · open",
        select: '[role="menu"]',
        node: <MES open />,
      },
      {
        name: "menu · sonnet · open",
        select: '[role="menu"]',
        node: <MES open model={SONNET} effort="medium" />,
      },
      {
        name: "menu · agent-owned model · open",
        select: '[role="menu"]',
        node: <MES open modelDisabled />,
      },
      {
        name: "submenu · model list · keyboard open",
        select: "[data-paper-sub]",
        node: <MES open sub="Model" />,
      },
      {
        name: "submenu · effort · keyboard open",
        select: "[data-paper-sub]",
        node: <MES open sub="Effort" />,
      },
    ],
  },
  {
    group: "Model mark",
    title: "Vendors",
    specimens: [
      {
        name: "mark · anthropic · 15",
        node: (
          <div className="p-1 text-dim">
            <ModelMark id={OPUS} provider="pi" />
          </div>
        ),
      },
      {
        name: "mark · openai · 15",
        node: (
          <div className="p-1 text-dim">
            <ModelMark id="pi/openai/gpt-6.1-sol" provider="pi" />
          </div>
        ),
      },
      {
        name: "mark · anthropic · 24",
        node: (
          <div className="p-1 text-dim">
            <ModelMark id={OPUS} provider="pi" size={24} />
          </div>
        ),
      },
    ],
  },
  {
    group: "Session header",
    title: "Desktop",
    specimens: [
      {
        name: "header · default · with tab strip",
        width: 1200,
        node: <Header />,
      },
      {
        name: "header · lone session · new tab button",
        width: 1200,
        node: <Header tabStrip={false} count={1} />,
      },
      {
        name: "header · viewers · two teammates",
        width: 1200,
        node: <Header viewers={["kent", "maja"]} />,
      },
      { name: "header · share · copied", width: 1200, node: <Header copied /> },
      {
        name: "header · worker · crumb back up",
        width: 1200,
        node: (
          <Header
            session={sess({
              id: "s-worker",
              title: "Write pass back tests",
              parentSessionId: WALLET.id,
            })}
            parent={{ id: WALLET.id, title: "Pass front layout" }}
          />
        ),
      },
      {
        name: "header · workers · delegated",
        width: 1200,
        node: (
          <Header
            workers={[
              {
                id: "w1",
                title: "Write pass back tests",
                model: SONNET,
                isRunning: true,
              },
              { id: "w2", title: "Audit pass colours", model: OPUS },
            ]}
          />
        ),
      },
      {
        name: "header · automation · started by agent",
        width: 1200,
        node: (
          <Header
            session={sess({
              id: "s-auto",
              title: "Reconcile September Stripe payouts",
              repo: "franking",
              branch: "chore/payouts-sept",
              automation: "Monthly payouts",
              automationId: "auto-payouts",
            })}
            workspaceName="Reconcile September Stripe payouts"
          />
        ),
      },
      {
        name: "header · from slack · source mark",
        width: 1200,
        node: (
          <Header
            session={sess({
              id: "s-slack",
              title: "Passkey sign-in",
              source: "slack" as any,
              repo: "betterbahn",
              branch: "feat/passkey",
            })}
            workspaceName="Passkey sign-in"
          />
        ),
      },
      {
        name: "header · ask · no repo",
        width: 1200,
        node: (
          <Header
            session={sess({
              id: "s-ask",
              title: "How do refunds post?",
              mode: "ask",
              repoLess: true,
              repo: undefined,
              branch: null,
            })}
            workspaceName="How do refunds post?"
          />
        ),
      },
      {
        name: "header · archived · unarchive",
        width: 1200,
        node: (
          <Header
            session={sess({
              id: "s-arch",
              title: "Pass colour spike",
              archived: true,
            })}
            workspaceName="Pass colour spike"
          />
        ),
      },
      {
        name: "header · renaming · input",
        width: 1200,
        node: <Header rename="Wallet pass redesign" />,
      },
      {
        name: "header · long title · truncated",
        width: 1200,
        node: (
          <Header
            workspaceName="Export worker memory spike after the September payouts backfill doubled the row count and the stream stopped applying backpressure"
            session={sess({
              id: "s-long",
              title: "Export worker memory spike",
              repo: "stacked",
              branch: "fix/export-stream",
            })}
          />
        ),
      },
    ],
  },
  {
    group: "Session header",
    title: "Title bar",
    specimens: [
      {
        name: "title bar · nav · idle",
        node: (
          <div className="sidebar-brand flex p-2">
            <TitleBar />
          </div>
        ),
      },
      {
        name: "title bar · nav and search · idle",
        node: (
          <div className="sidebar-brand flex p-2">
            <TitleBar onSearch={noop} />
          </div>
        ),
      },
      {
        name: "title bar · nav and search · back hover",
        node: (
          <After
            run={(r) =>
              r
                .querySelector('[aria-label="Back"]')
                ?.setAttribute("data-force-hover", "")
            }
          >
            <div className="sidebar-brand flex p-2">
              <TitleBar onSearch={noop} />
            </div>
          </After>
        ),
      },
    ],
  },

  {
    group: "Session tabs",
    title: "Desktop",
    specimens: [
      {
        name: "tabs · default · running, needs input, draft",
        width: 900,
        node: <Tabs />,
      },
      {
        name: "tabs · inactive · hover",
        width: 900,
        node: (
          <After className="flex w-full" run={hoverTab("Pass back tests")}>
            <Tabs />
          </After>
        ),
      },
      {
        name: "tabs · active · hover",
        width: 900,
        node: (
          <After className="flex w-full" run={hoverTab("Pass front layout")}>
            <Tabs />
          </After>
        ),
      },
      {
        name: "tabs · colored · with teammates",
        width: 900,
        node: (
          <Tabs
            colors={{ "s-wallet-front": "blue", "s-wallet-sign": "orange" }}
            viewers={{
              "s-wallet-front": ["kent"],
              "s-wallet-tests": ["maja", "kent", "ola"],
            }}
          />
        ),
      },
      {
        name: "tabs · view tabs · review active",
        width: 900,
        node: (
          <Tabs
            active={null}
            views={[
              {
                id: "review:s-wallet-front",
                label: "Review",
                active: true,
                dotClass: "bg-green",
              },
              {
                id: "staging:s-wallet-front",
                label: "Staging",
                active: false,
                icon: <IconGlobe size={16} />,
              },
            ]}
          />
        ),
      },
      {
        name: "tabs · two sessions · no history",
        width: 900,
        node: <Tabs sessions={TAB_SESSIONS.slice(0, 2)} history={false} />,
      },
      {
        name: "tabs · split · single tab",
        width: 440,
        node: <Tabs sessions={[WALLET]} inSplit history={false} />,
      },
      {
        name: "tabs · overflow · long titles",
        width: 560,
        node: (
          <Tabs
            sessions={[
              WALLET,
              sess({
                id: "s-l1",
                title: "Reconcile September Stripe payouts against the ledger",
                isRunning: true,
              }),
              sess({
                id: "s-l2",
                title: "Export worker memory spike follow-up",
              }),
              sess({ id: "s-l3", title: "Passkey sign-in on Android" }),
            ]}
          />
        ),
      },
    ],
  },
  {
    group: "Session tabs",
    title: "Phone",
    specimens: [
      {
        name: "phone · default · running, needs input",
        width: 390,
        viewport: 390,
        node: <Tabs />,
      },
      {
        name: "phone · view tab · review",
        width: 390,
        viewport: 390,
        node: (
          <Tabs
            sessions={TAB_SESSIONS.slice(0, 2)}
            active={null}
            order={["review:s", WALLET.id, "s-wallet-tests"]}
            views={[
              {
                id: "review:s",
                label: "Review",
                active: true,
                dotClass: "bg-green",
              },
            ]}
          />
        ),
      },
    ],
  },

  {
    group: "Phone session header",
    title: "Session",
    specimens: [
      {
        name: "session · idle · model and cost",
        width: 390,
        viewport: 390,
        node: <PhoneHeader />,
      },
      {
        name: "session · running · working dot",
        width: 390,
        viewport: 390,
        node: <PhoneHeader running />,
      },
      {
        name: "session · archived · archive mark",
        width: 390,
        viewport: 390,
        node: (
          <PhoneHeader
            session={sess({
              id: "s-exp",
              title: "Export worker memory spike",
              repo: "stacked",
              workspaceId: "ws-export",
              archived: true,
            })}
          />
        ),
      },
      {
        name: "session · worker · own title",
        width: 390,
        viewport: 390,
        node: (
          <PhoneHeader
            session={sess({
              id: "s-worker",
              title: "Write pass back tests",
              parentSessionId: WALLET.id,
            })}
            running
          />
        ),
      },
      {
        name: "session · desk call · live",
        width: 390,
        viewport: 390,
        node: <PhoneHeader call />,
      },
      {
        name: "session · with tab strip · running",
        width: 390,
        viewport: 390,
        node: <PhoneHeader running withTabs />,
      },
    ],
  },
  {
    group: "Phone session header",
    title: "Pushed page",
    specimens: [
      {
        name: "page · title · reviews",
        width: 390,
        viewport: 390,
        node: (
          <PhoneHeader route={{ view: "prs" }} session={null} title="Reviews" />
        ),
      },
    ],
  },

  {
    group: "New session",
    title: "Inline card",
    specimens: [
      { name: "inline · code · empty", width: 820, node: <NewSessionCard /> },
      {
        name: "inline · code · with prompt",
        width: 820,
        node: (
          <NewSessionCard prompt="Redesign the wallet pass so the merchant colour drives the background, and keep the barcode readable on dark colours." />
        ),
      },
      {
        name: "inline · ask · empty",
        width: 820,
        node: <NewSessionCard mode="ask" />,
      },
    ],
  },
  {
    group: "New session",
    title: "Palette",
    specimens: [
      {
        name: "palette · code · with prompt",
        select: '[role="dialog"]',
        node: (
          <NewSessionPalette prompt="Reconcile September Stripe payouts against the ledger export and list every mismatch." />
        ),
      },
      {
        name: "palette · phone · empty",
        viewport: 390,
        select: '[role="dialog"]',
        node: <NewSessionPalette />,
      },
    ],
  },
  {
    group: "New session prompt",
    title: "States",
    specimens: [
      { name: "prompt · empty · placeholder", width: 820, node: <Prompt /> },
      {
        name: "prompt · with text · idle",
        width: 820,
        node: (
          <Prompt text="Add passkey sign-in to the Android app. Reuse the web flow's challenge endpoint." />
        ),
      },
      {
        name: "prompt · attachments · images and file",
        width: 820,
        node: (
          <Prompt
            text="Match the back of the pass to the front."
            images={IMAGES}
            files={FILES.slice(1)}
            height={270}
          />
        ),
      },
      {
        name: "prompt · uploading · pending",
        width: 820,
        node: (
          <Prompt
            text="Here is the heap dump."
            staging={{ images: 1, files: 1 }}
            height={270}
          />
        ),
      },
      {
        name: "prompt · disabled · creating",
        width: 820,
        node: (
          <Prompt text="Add passkey sign-in to the Android app." disabled />
        ),
      },
    ],
  },
];

export const descriptions: Record<string, string> = {
  Composer:
    "components/Composer.tsx · the message box under every session transcript, with model pill, + menu, mic and send or stop, a predicted next message and typing autocomplete",
  "Composer context chip":
    "components/ComposerContextChip.tsx · names what is attached to the next send above the field: selected text, pasted text, team note, ask mode, a connected folder",
  "File chips":
    "components/FileChips.tsx · non-image attachments on the composer, with upload progress while they stage",
  "Image thumbs":
    "components/ImageThumbs.tsx · pasted or dropped screenshots on the composer, with ghost tiles while they upload",
  "Model and effort select":
    "components/ModelEffortSelect.tsx · the model, effort, speed and account menu behind the composer pill, the session info row and the default model field in Preferences",
  "Model mark":
    "components/ModelMark.tsx · vendor mark beside a model in any model dropdown",
  "Session header":
    "components/session/SessionHeader.tsx · the desktop bar above a session: repo › workspace crumb, ⋯ menu, presence, share and panel toggle",
  "Session tabs":
    "components/SessionTabs.tsx · the strip of sibling sessions and view panes in one workspace",
  "Phone session header":
    "components/AppMobileHeader.tsx · the phone top bar on a pushed page: back, the session pill with model and cost, and the Desk call button",
  "New session":
    "components/NewSession.tsx · the new-session palette, inline on an empty workspace or over the page",
  "New session prompt":
    "components/NewSessionPrompt.tsx · the prompt field and attachments inside the new-session palette",
};
