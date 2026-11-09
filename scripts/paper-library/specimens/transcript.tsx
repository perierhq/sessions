import * as React from "react";
import type { Section, Specimen } from "../entry";
import type {
  TranscriptEntry,
  CommentThread,
  ThreadComment,
  AskQuestion,
} from "../../../packages/core/opensession-server/src/frontend/lib/types";
import type { AnsweredAskData } from "../../../packages/core/protocol/src/notices";
import type { PlanItem } from "../../../packages/core/protocol/src/todo-plan";
import { MessageBubble } from "../../../packages/core/opensession-server/src/frontend/components/MessageBubble";
import {
  TurnBlock,
  ToolSection,
} from "../../../packages/core/opensession-server/src/frontend/components/TurnBlock";
import {
  TurnFooter,
  type TouchedFile,
} from "../../../packages/core/opensession-server/src/frontend/components/TurnFooter";
import {
  ToolCallBlock,
  LiveSubagentsProvider,
  OpenAssetProvider,
  ToolPathRootsProvider,
} from "../../../packages/core/opensession-server/src/frontend/components/ToolCallBlock";
import { PlanChecklist } from "../../../packages/core/opensession-server/src/frontend/components/PlanChecklist";
import { TypingIndicator } from "../../../packages/core/opensession-server/src/frontend/components/TypingIndicator";
import { ReplySuggestions } from "../../../packages/core/opensession-server/src/frontend/components/ReplySuggestions";
import { AskCard } from "../../../packages/core/opensession-server/src/frontend/components/AskCard";
import { AnsweredAskCard } from "../../../packages/core/opensession-server/src/frontend/components/AnsweredAskCard";
import { NoteBubble } from "../../../packages/core/opensession-server/src/frontend/components/NoteBubble";
import { KeychainAskCard } from "../../../packages/core/opensession-server/src/frontend/components/KeychainAskCard";
import { ForceMergeCard } from "../../../packages/core/opensession-server/src/frontend/components/ForceMergeCard";
import { SessionContextMessage } from "../../../packages/core/opensession-server/src/frontend/components/SessionContextMessage";
import { MarkdownBody } from "../../../packages/core/opensession-server/src/frontend/components/MarkdownBody";
import {
  renderMarkdown,
  setSessionTitles,
} from "../../../packages/core/opensession-server/src/frontend/lib/markdown";
import { msgBody } from "../../../packages/core/opensession-server/src/frontend/lib/msg-classes";
import { transcriptDisclosureLedger } from "../../../packages/core/opensession-server/src/frontend/lib/transcript-disclosures";
import { MessageLinkProvider } from "../../../packages/core/opensession-server/src/frontend/lib/message-link";

/* ── Environment: who is signed in, and the few API reads these make ────── */

const SID = "ses_walletpass01";
const ME = "Kacper";

localStorage.setItem("opensession-user", ME);

setSessionTitles([
  ["ses_walletpass01", "Wallet pass redesign", false, "Wallet pass redesign"],
  ["ses_passlayout02", "Pass layout audit", false, "Pass layout audit"],
  [
    "ses_stripe03",
    "Reconcile September Stripe payouts",
    true,
    "Reconcile September Stripe payouts",
  ],
  ["ses_passkey04", "Passkey sign-in", false, "Passkey sign-in"],
]);

const CONTEXT_BODY = `You are working in the habit repository on branch feat/wallet-pass.

Repository notes
- apps/web is the Next.js client, apps/api the Hono server.
- Run bun test before opening a pull request.

Attached session excerpt (Pass layout audit)
The barcode overlaps the footer strip on 390px passes. Keep the strip at 92px.`;

const STRIPE_CRED = {
  service: "stripe-habit",
  name: "Stripe (Habit)",
  host: "api.stripe.com",
  kind: "api" as const,
  description: "Live account, read access for finance work",
  allowedMethods: ["GET"],
  allowedPathPrefixes: ["/v1/payouts", "/v1/balance_transactions"],
};
const KEYCHAIN_ASKS: Record<string, unknown[]> = {
  ses_kc_borrow: [
    {
      id: "kca_1",
      requestedBy: "Kacper",
      purpose:
        "Pull the September payouts and balance transactions to reconcile them against the ledger export.",
      requestedMode: "standing",
      credentials: [STRIPE_CRED],
      createdAt: "2026-11-08T09:12:00.000Z",
    },
  ],
  ses_kc_open: [
    {
      id: "kca_2",
      requestedBy: "Jaap",
      purpose: "Check whether the Resend domain for habit.app is verified.",
      requestedMode: "once",
      credentials: [
        {
          service: "resend",
          name: "Resend",
          host: "api.resend.com",
          kind: "api",
        },
      ],
      createdAt: "2026-11-08T09:14:00.000Z",
    },
  ],
  ses_kc_run: [
    {
      id: "kca_3",
      requestedBy: "Kacper",
      purpose: "Reconcile every September payout in one pass.",
      requestedMode: "run",
      run: {
        command:
          "bun run apps/api/scripts/reconcile-payouts.ts --month 2026-09",
        maxCalls: 1200,
      },
      credentials: [STRIPE_CRED],
      createdAt: "2026-11-08T09:16:00.000Z",
    },
  ],
  ses_kc_login: [
    {
      id: "kca_4",
      requestedBy: "Maya",
      purpose:
        "Sign in to the staging dashboard and check the pass preview at 390px.",
      requestedMode: "release",
      credentials: [
        {
          service: "habit-staging",
          name: "Habit staging",
          host: "staging.habit.app",
          kind: "login",
          username: "qa@habit.app",
          loginUrl: "staging.habit.app/login",
        },
      ],
      createdAt: "2026-11-08T09:18:00.000Z",
    },
  ],
};
const FM_REQUEST = {
  id: "fm_1",
  repo: "habit",
  ghRepo: "kacper/habit",
  number: 482,
  title: "Wallet pass: move the barcode under the points strip",
  url: "https://github.com/kacper/habit/pull/482",
  author: "kacper",
  base: "main",
  head: "feat/wallet-pass",
  headSha: "9f2c4e1a7b3d",
  method: "squash",
  reason:
    "The visual regression check times out on the shared runner. Maya checked the pass on three phones and the release is due today.",
  bypass: [
    {
      kind: "check",
      name: "visual-regression",
      state: "failing",
      required: true,
    },
    { kind: "check", name: "e2e (webkit)", state: "pending", required: false },
    { kind: "review", detail: "1 approving review required, 0 given" },
  ],
  driver: "Kacper",
  requestedAt: Date.parse("2026-11-08T10:00:00.000Z"),
  expiresAt: Date.parse("2026-11-08T10:30:00.000Z"),
};
const FORCE_MERGES: Record<string, unknown> = {
  ses_fm_driver: { request: FM_REQUEST, canConfirm: true },
  ses_fm_viewer: { request: FM_REQUEST, canConfirm: false },
  ses_fm_clean: {
    request: {
      ...FM_REQUEST,
      id: "fm_2",
      bypass: [],
      reason: "Branch protection is still on the old required check name.",
    },
    canConfirm: true,
  },
};

const realFetch = window.fetch.bind(window);
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.includes("/session-context")) {
    if (url.includes("ses_ctx_loading")) return new Promise<Response>(() => {});
    if (url.includes("content=1"))
      return json({
        available: true,
        exact: true,
        bytes: 18_432,
        estimatedTokens: 4_600,
        content: CONTEXT_BODY,
      });
    if (url.includes("ses_ctx_partial"))
      return json({
        available: true,
        exact: false,
        bytes: 96_256,
        estimatedTokens: 24_000,
      });
    if (url.includes("ses_ctx_none")) return json({ available: false });
    return json({
      available: true,
      exact: true,
      bytes: 18_432,
      estimatedTokens: 4_600,
    });
  }
  if (url.includes("/api/people"))
    return json({
      people: [
        { name: "Kacper", fullName: "Kacper Kwapisz" },
        { name: "Jaap", fullName: "Jaap de Vries" },
        { name: "Maya", fullName: "Maya Okafor" },
      ],
    });
  if (url.includes("/api/keychain/asks")) {
    const sid = new URL(url, location.href).searchParams.get("sessionId");
    return json({ asks: KEYCHAIN_ASKS[sid ?? ""] ?? [] });
  }
  if (url.includes("/api/force-merge")) {
    const sid = new URL(url, location.href).searchParams.get("sessionId");
    return json(FORCE_MERGES[sid ?? ""] ?? { request: null });
  }
  if (url.includes("/summary"))
    return json({
      summary:
        "Payout totals match the ledger except two refunds from 28 September, both flagged in the report.",
    });
  return realFetch(input, init);
}) as typeof fetch;

/* ── Forcing states the component keeps internal ─────────────────────── */

type Step = {
  sel: string;
  do: "attr" | "click" | "type" | "style";
  value?: string;
  doc?: boolean;
  at?: number;
};

/** Applies DOM steps to the rendered specimen after mount: a forced hover
 *  attribute on an inner element, a click that opens a menu, typed text. The
 *  hidden marker sits after the specimen, so it never becomes the capture. */
function Force({
  steps,
  children,
}: {
  steps: Step[];
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const timers = steps.map((s) =>
      window.setTimeout(() => {
        const scope: ParentNode = s.doc ? document : host;
        const els =
          s.sel === "root"
            ? [host.firstElementChild as HTMLElement].filter(Boolean)
            : Array.from(scope.querySelectorAll<HTMLElement>(s.sel));
        for (const el of els) {
          if (s.do === "attr")
            el.setAttribute(s.value ?? "data-force-hover", "");
          else if (s.do === "style") el.style.cssText += s.value ?? "";
          else if (s.do === "click") (el as HTMLElement).click();
          else if (s.do === "type") {
            const proto =
              el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(
              el,
              s.value ?? "",
            );
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          if (s.do !== "attr") break;
        }
      }, s.at ?? 30),
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <>
      {children}
      <span ref={ref} hidden />
    </>
  );
}

/** Capturing through `select` gives async parts (shiki, motion, menus) 400ms
 *  to settle; only one specimen is on the page, so this matches it. */
const SETTLE = "[data-spec] > *";

const ROOTS = [
  { dir: "/Users/kacper/projects/habit" },
  { dir: "/Users/kacper/projects/franking" },
];
/** The session's worktree, so tool paths read repo-relative as they do in the app. */
const Roots = ({ children }: { children: React.ReactNode }) => (
  <ToolPathRootsProvider value={ROOTS}>{children}</ToolPathRootsProvider>
);

/* ── Data helpers ─────────────────────────────────────────────────────── */

const BASE = Date.parse("2026-11-08T09:00:00.000Z");
const t = (min: number, sec = 0) =>
  new Date(BASE + (min * 60 + sec) * 1000).toISOString();

let seq = 0;
function tool(
  name: string,
  input: unknown,
  at: string,
  id?: string,
): TranscriptEntry {
  const n = ++seq;
  return {
    id: id ?? `tu-${n}`,
    type: "tool_use",
    toolName: name,
    toolInput: input,
    toolUseId: `call-${id ?? n}`,
    content: `Using ${name}`,
    timestamp: at,
  };
}
function result(
  of: TranscriptEntry,
  content: string,
  at: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id: `${of.id}-r`,
    type: "tool_result",
    toolUseId: of.toolUseId,
    content,
    timestamp: at,
    ...extra,
  };
}
function results(...rs: TranscriptEntry[]) {
  return new Map(rs.map((r) => [r.toolUseId!, r]));
}
function assistant(
  content: string,
  at: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id: `as-${++seq}`,
    type: "assistant",
    content,
    timestamp: at,
    model: "claude-opus-4-5",
    ...extra,
  };
}
function user(
  content: string,
  at: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return { id: `us-${++seq}`, type: "user", content, timestamp: at, ...extra };
}

const CODE_LINES = [
  "export function PassStrip({ pass }: { pass: WalletPass }) {",
  "  const balance = formatPoints(pass.points);",
  "  const tier = tierLabel(pass.tier);",
  "  return (",
  '    <div className="pass-strip">',
  '      <span className="pass-tier">{tier}</span>',
  '      <span className="pass-balance">{balance}</span>',
  "    </div>",
  "  );",
  "}",
  "",
  "const STRIP_HEIGHT = 92;",
  "const BARCODE_GAP = 12;",
];
const code = (n: number) =>
  Array.from({ length: n }, (_, i) => CODE_LINES[i % CODE_LINES.length]).join(
    "\n",
  );

const expand = (kind: "tool-call" | "tool-run" | "turn", ids: string[]) =>
  transcriptDisclosureLedger.write(kind, SID, ids, true);

/* ── Message bubble ───────────────────────────────────────────────────── */

const own = user(
  "Can you move the barcode below the points strip on the wallet pass? It overlaps the footer on small phones.",
  t(0),
);
const ownLong = user(
  "A few things on the pass before we ship:\n\n1. The barcode overlaps the footer on 390px screens.\n2. Points should read 12,480 rather than 12480.\n3. Keep the tier colour from the existing pass, don't invent a new one.\n\nPR #482 has the screenshots from Maya.",
  t(1),
);
const ownFile = user(
  "Here is the export that spiked. Can you find what holds the memory?",
  t(2),
  {
    files: [
      {
        name: "export-worker-heap.heapsnapshot",
        path: "/tmp/uploads/export-worker-heap.heapsnapshot",
      },
    ],
  },
);
const ownPaste = user("This is the failing log from CI.", t(3), {
  pastedTexts: [
    "bun test v1.2.21\n\napps/api/src/export/worker.test.ts:\n✓ streams rows in batches [12ms]\n✗ releases the cursor after each batch [3008ms]\n  error: expected heapUsed < 256 MB, got 912 MB\n\n 1 pass\n 1 fail\nRan 2 tests across 1 file. [3.04s]",
  ],
});
const teammate = user(
  "Let's keep the old tier colours for now, the brand refresh lands in December.",
  t(4),
  { sender: "Jaap" },
);
const viaSlack = user(
  "Approved on my side, ship it once tests are green.",
  t(5),
  { sender: "Maya", senderVia: "slack" },
);
const answer = assistant(
  "I moved the barcode into the strip area and pinned the strip to 92px, so it no longer reaches the footer on 390px passes.\n\n- `pass-card.tsx` now renders `PassStrip` above the barcode\n- Points use `formatPoints`, so 12480 reads **12,480**\n- Tier colours are unchanged\n\nTests pass locally (`bun test apps/web/src/wallet`, 14 passed).",
  t(18),
);
const reasoning = assistant(
  "**Checking the pass layout**\n\nThe barcode is absolutely positioned from the bottom edge, so a taller footer pushes into it. Moving it into the flow under the strip removes the overlap without a breakpoint.",
  t(2),
  { isReasoning: true },
);
const notice = (
  title: string,
  extra: Partial<NonNullable<TranscriptEntry["notice"]>> = {},
  content = "",
): TranscriptEntry => ({
  id: `no-${++seq}`,
  type: "system",
  content,
  timestamp: t(20),
  notice: { kind: "system", title, tone: "info", ...extra },
});
const incoming: TranscriptEntry = {
  id: "agent-in-1",
  type: "user",
  content:
    "Finished the September reconciliation. Payout totals match the ledger except two refunds from 28 September (re_3Px1 and re_3Px4), which Stripe settled a day late. Both are flagged in reconciliation-september.md.",
  timestamp: t(21),
  notice: {
    kind: "session-notice",
    title: "",
    tone: "info",
    link: { label: "Open session", sessionId: "ses_stripe03" },
  },
};

const loopTick: TranscriptEntry = {
  id: "loop-1",
  type: "user",
  content:
    "Check the staging export queue and tell me if any job has been stuck for more than 10 minutes.",
  timestamp: t(22),
  notice: {
    kind: "loop-tick",
    title: "Loop check",
    tone: "info",
    icon: "clock",
    body: "collapsed",
  },
};
const ysk = (id: string, title: string, body: string): TranscriptEntry => ({
  id,
  type: "system",
  content: body,
  timestamp: t(23),
  notice: {
    kind: "you-should-know",
    title,
    tone: "info",
    ...(body ? { body: "collapsed" as const } : {}),
  },
});
const YSK_TITLE =
  "Heads up · The agent pinned the strip to 92px, so a long member name now wraps the tier label on small phones.";
const YSK_BODY =
  "`PassStrip` used to grow with its content. With a fixed height, the tier label has one line to fit in, and on a 320px screen a name over 18 characters pushes it onto a second line that is clipped.\n\nIf that matters, ask for the label to truncate with an ellipsis instead.";
const yskOpen = ysk("ysk-1", YSK_TITLE, YSK_BODY);
const yskLearn = ysk("ysk-2", YSK_TITLE, YSK_BODY);
const yskAsked = ysk("ysk-3", YSK_TITLE, YSK_BODY);
const yskKnown = ysk(
  "ysk-4",
  "You should know · Bun runs the wallet tests in parallel by default, so a shared fixture file can race.",
  "",
);
localStorage.setItem(
  "opensession-you-should-know-used",
  JSON.stringify({ [`${SID}:ysk-3`]: "asked", [`${SID}:ysk-4`]: "known" }),
);

const BUBBLE_W = 780;
/** The main transcript offers "Copy link" on a message (TranscriptView). */
const linkTo = (entryId: string) =>
  `https://sessions.pl/session/${SID}#message-${encodeURIComponent(entryId)}`;
const Linked = ({ children }: { children: React.ReactNode }) => (
  <MessageLinkProvider value={linkTo}>{children}</MessageLinkProvider>
);
const bubble = (
  name: string,
  entry: TranscriptEntry,
  extra: Partial<React.ComponentProps<typeof MessageBubble>> = {},
  s: Partial<Specimen> = {},
  steps: Step[] = [],
): Specimen => ({
  name,
  width: BUBBLE_W,
  // Person turns hang copy, link and edit below the bubble, in the row's
  // bottom margin; a flex wrapper contains that margin so the capture
  // includes them.
  node: (
    <Force steps={steps}>
      <Linked>
        {entry.type === "user" && !entry.notice ? (
          <div className="flex w-full flex-col">
            <MessageBubble
              entry={entry}
              owner={ME}
              onEdit={() => {}}
              {...extra}
            />
          </div>
        ) : (
          <MessageBubble
            entry={entry}
            owner={ME}
            sessionId={SID}
            onEdit={() => {}}
            {...extra}
          />
        )}
      </Linked>
    </Force>
  ),
  ...s,
});
const phone = (s: Specimen): Specimen => ({ ...s, width: 390, viewport: 390 });

/* ── Turn block ───────────────────────────────────────────────────────── */

const PASS = "/Users/kacper/projects/habit/apps/web/src/wallet";

// Done, tool only: 18m, 4 steps, +86 -12 (62+24 added, 8+4 removed).
const a1 = tool("Read", { file_path: `${PASS}/pass-card.tsx` }, t(0), "a1");
const a2 = tool(
  "Edit",
  {
    file_path: `${PASS}/pass-card.tsx`,
    old_string: code(8),
    new_string: code(62),
  },
  t(3),
  "a2",
);
const a3 = tool(
  "Edit",
  {
    file_path: `${PASS}/pass-styles.ts`,
    old_string: code(4),
    new_string: code(24),
  },
  t(9),
  "a3",
);
const a4 = tool(
  "Bash",
  {
    command: "bun test apps/web/src/wallet",
    description: "Run the wallet tests",
  },
  t(17, 20),
  "a4",
);
const turnA = [a1, a2, a3, a4];
const turnAResults = results(
  result(a1, code(40), t(0, 2)),
  result(a2, "The file has been updated.", t(3, 1)),
  result(a3, "The file has been updated.", t(9, 1)),
  result(a4, "14 pass\n0 fail\nRan 14 tests across 3 files. [1.84s]", t(18)),
);

// Done, narrated: reasoning, 3 routine reads, narration, 2 edits, a sub-agent.
const b0 = assistant(
  "**Finding where the barcode is positioned**\n\nThe overlap only shows on short passes, so the barcode is probably placed from the bottom edge rather than in the flow. I'll read the pass card and search for where it sets the offset.",
  t(30),
  {
    isReasoning: true,
    id: "b0",
  },
);
const b1 = tool(
  "Read",
  { file_path: `${PASS}/pass-card.tsx` },
  t(30, 10),
  "b1",
);
const b2 = tool(
  "Grep",
  { pattern: "barcode", path: `${PASS}` },
  t(30, 30),
  "b2",
);
const b3 = tool("Read", { file_path: `${PASS}/barcode.tsx` }, t(31), "b3");
const b4 = assistant(
  "The barcode is absolutely positioned from the bottom edge, so the footer strip runs into it on short passes. I'll move it into the flow under the points strip.",
  t(32),
  { id: "b4" },
);
const b5 = tool(
  "Edit",
  {
    file_path: `${PASS}/barcode.tsx`,
    old_string: code(6),
    new_string: code(9),
  },
  t(33),
  "b5",
);
const b6 = tool(
  "Bash",
  { command: "bun test apps/web/src/wallet" },
  t(36),
  "b6",
);
const b7 = tool(
  "Task",
  {
    subagent_type: "reviewer",
    description: "Check the pass on 390px",
    prompt:
      "Open the pass preview at 390px and confirm the barcode clears the footer.",
  },
  t(37),
  "b7",
);
const turnB = [b0, b1, b2, b3, b4, b5, b6, b7];
const turnBResults = results(
  result(b1, code(40), t(30, 12)),
  result(b2, "barcode.tsx:14\npass-card.tsx:52", t(30, 31)),
  result(b3, code(30), t(31, 1)),
  result(b5, "The file has been updated.", t(33, 1)),
  result(b6, "14 pass\n0 fail", t(37)),
  result(b7, "The barcode clears the footer by 12px at 390px.", t(42), {
    agentId: "ses_passlayout02",
  }),
);

// Live, narrated, ending on a thought; the earlier thought folds to one line.
const c0 = assistant(
  "**Profiling the export worker**\n\nThe heap climbs during the September export, so I'll read the worker loop and profile a 200,000 row run.",
  t(49, 50),
  { isReasoning: true, id: "c0" },
);
const c1 = tool(
  "Read",
  {
    file_path: "/Users/kacper/projects/franking/apps/api/src/export/worker.ts",
  },
  t(50),
  "c1",
);
const c2 = tool(
  "Bash",
  { command: "bun run apps/api/scripts/heap-profile.ts --rows 200000" },
  t(50, 20),
  "c2",
);
const c3 = assistant(
  "Heap grows by about 4 MB per batch and never drops, so something keeps every batch alive.",
  t(52),
  { id: "c3" },
);
const c4 = assistant("**Tracing what holds the batch buffers**", t(52, 30), {
  isReasoning: true,
  id: "c4",
});
const turnC = [c0, c1, c2, c3, c4];
const turnCResults = results(
  result(c1, code(30), t(50, 1)),
  result(c2, "heapUsed 912 MB after 200000 rows", t(51, 50)),
);

// Live, tool only, last call still running.
const d1 = tool(
  "Grep",
  {
    pattern: "cursor.close",
    path: "/Users/kacper/projects/franking/apps/api/src",
  },
  t(60),
  "d1",
);
const d2 = tool(
  "Read",
  {
    file_path: "/Users/kacper/projects/franking/apps/api/src/export/cursor.ts",
  },
  t(60, 10),
  "d2",
);
const d3 = tool(
  "Bash",
  { command: "bun test apps/api/src/export --timeout 20000" },
  t(60, 30),
  "d3",
);
const turnD = [d1, d2, d3];
const turnDResults = results(
  result(d1, "export/worker.ts:88", t(60, 1)),
  result(d2, code(20), t(60, 11)),
);

expand(
  "turn",
  turnB.map((e) => e.id),
);

const turnSpec = (
  name: string,
  items: TranscriptEntry[],
  res: Map<string, TranscriptEntry>,
  live: boolean,
  s: Partial<Specimen> = {},
  expandWhileRunning = false,
  // The app's defaults: "Thinking messages: latest" folds every thought of a
  // settled turn and all but the newest of a live one (quietThoughts), and a
  // live turn's phase frames say the model request is open.
  {
    quiet = live ? "earlier" : "all",
    phase = live ? "model" : null,
  }: {
    quiet?: React.ComponentProps<typeof TurnBlock>["quietThoughts"];
    phase?: React.ComponentProps<typeof TurnBlock>["livePhase"];
  } = {},
): Specimen => ({
  name,
  width: 780,
  select: SETTLE,
  node: (
    <Roots>
      <div className="w-full px-2">
        <TurnBlock
          items={items}
          toolResults={res}
          live={live}
          sessionId={SID}
          expandWhileRunning={expandWhileRunning}
          onOpenSubagent={() => {}}
          quietThoughts={quiet}
          livePhase={phase}
        />
      </div>
    </Roots>
  ),
  ...s,
});

/* ── Turn footer ──────────────────────────────────────────────────────── */

const finalAnswer = assistant(
  "I moved the barcode into the strip area.",
  t(18),
  { id: "final-1", model: "claude-opus-4-5-20251101" },
);
const FILES: TouchedFile[] = [
  {
    path: `${PASS}/pass-card.tsx`,
    additions: 62,
    deletions: 8,
    hunks: [
      "-  <Barcode bottom={16} />\n+  <PassStrip pass={pass} />\n+  <Barcode />",
    ],
  },
  {
    path: `${PASS}/pass-styles.ts`,
    additions: 24,
    deletions: 4,
    hunks: ["-const STRIP_HEIGHT = 80;\n+const STRIP_HEIGHT = 92;"],
  },
];
const MORE_FILES: TouchedFile[] = [
  ...FILES,
  {
    path: `${PASS}/barcode.tsx`,
    additions: 9,
    deletions: 6,
    hunks: ["+const BARCODE_GAP = 12;"],
  },
  {
    path: `${PASS}/pass-card.test.tsx`,
    additions: 31,
    deletions: 0,
    hunks: ['+test("barcode clears the footer", () => {});'],
  },
];
const footer = (
  name: string,
  files: TouchedFile[],
  assets: string[] = [],
  s: Partial<Specimen> = {},
  steps: Step[] = [],
): Specimen => ({
  name,
  width: 780,
  select: steps.some((x) => x.doc) ? '[role="menu"]' : SETTLE,
  node: (
    <Force steps={steps}>
      <OpenAssetProvider value={() => {}}>
        <Linked>
          <Roots>
            <TurnFooter
              entry={finalAnswer}
              durationMs={18 * 60_000}
              files={files}
              assets={assets}
              onFork={() => {}}
              className="px-2 pt-2"
            />
          </Roots>
        </Linked>
      </OpenAssetProvider>
    </Force>
  ),
  ...s,
});

/* ── Tool call ────────────────────────────────────────────────────────── */

const HABIT = "/Users/kacper/projects/habit";

const bash = tool(
  "Bash",
  {
    command: "bun test apps/web/src/wallet",
    description: "Run the wallet tests",
  },
  t(70),
  "bash",
);
const bashOk = result(
  bash,
  "bun test v1.2.21\n\n✓ pass card renders the strip above the barcode [4ms]\n✓ points read 12,480 [1ms]\n✓ barcode clears the footer at 390px [6ms]\n\n 14 pass\n 0 fail\nRan 14 tests across 3 files. [1.84s]",
  t(70, 4),
);
const bashErr = result(
  bash,
  "✗ barcode clears the footer at 390px [6ms]\n  error: expected 12, received -4\n\n 13 pass\n 1 fail",
  t(70, 4),
  { isError: true, id: "bash-err" },
);
const bashE = tool(
  "Bash",
  {
    command: "bun test apps/web/src/wallet",
    description: "Run the wallet tests",
  },
  t(70),
  "bash-e",
);
const bashEErr = { ...bashErr, toolUseId: bashE.toolUseId };
const bashLong = tool(
  "Bash",
  {
    command:
      "cd apps/api && bun run scripts/reconcile-payouts.ts --month 2026-09 --account acct_1PxHabit --out reports/reconciliation-september.md --verbose",
  },
  t(70),
  "bash-long",
);

const read = tool(
  "Read",
  { file_path: `${PASS}/pass-card.tsx` },
  t(71),
  "read",
);
const readOk = result(
  read,
  CODE_LINES.slice(0, 10)
    .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
    .join("\n"),
  t(71, 1),
);

const edit = tool(
  "Edit",
  {
    file_path: `${PASS}/pass-styles.ts`,
    old_string: "const STRIP_HEIGHT = 80;\nconst BARCODE_BOTTOM = 16;",
    new_string:
      "const STRIP_HEIGHT = 92;\nconst BARCODE_GAP = 12;\n\nexport const passLayout = {\n  strip: STRIP_HEIGHT,\n  barcodeGap: BARCODE_GAP,\n};",
  },
  t(72),
  "edit",
);
const editOk = result(edit, "The file has been updated.", t(72, 1));

const grep = tool(
  "Grep",
  { pattern: "BARCODE_BOTTOM", path: `${HABIT}/apps/web/src` },
  t(73),
  "grep",
);
const grepOk = result(
  grep,
  "apps/web/src/wallet/pass-styles.ts\napps/web/src/wallet/barcode.tsx",
  t(73, 1),
);
const glob = tool(
  "Glob",
  { pattern: "**/*.pass.json", path: `${HABIT}/apps/web/public` },
  t(73),
  "glob",
);

const webFetch = tool(
  "WebFetch",
  {
    url: "https://developer.apple.com/documentation/walletpasses/pass",
    prompt: "Which barcode formats does a pass support?",
  },
  t(74),
  "webfetch",
);
const webFetchOk = result(
  webFetch,
  "Pass barcodes support PKBarcodeFormatQR, PKBarcodeFormatPDF417, PKBarcodeFormatAztec and PKBarcodeFormatCode128.",
  t(74, 3),
);
const webSearch = tool(
  "WebSearch",
  { query: "Apple Wallet pass barcode minimum size" },
  t(74),
  "websearch",
);

const task = tool(
  "Task",
  {
    subagent_type: "reviewer",
    description: "Check the pass on 390px",
    prompt:
      "Open the pass preview at 390px and confirm the barcode clears the footer.",
  },
  t(75),
  "task",
);
const taskOk = result(
  task,
  "The barcode clears the footer by 12px at 390px.",
  t(81),
  { agentId: "ses_passlayout02" },
);
const taskLive = tool(
  "Task",
  {
    subagent_type: "general",
    description: "Reconcile September Stripe payouts",
  },
  t(75),
  "task-live",
);

const mcp = tool("mcp__linear__get_issue", { id: "HAB-412" }, t(76), "mcp");
const mcpOk = result(
  mcp,
  '{\n  "id": "HAB-412",\n  "title": "Barcode overlaps footer on small passes",\n  "state": "In Progress",\n  "assignee": "Kacper"\n}',
  t(76, 1),
);
const mcpAsset = tool(
  "mcp__opensession-assets__write_asset",
  {
    path: "reconciliation-september.md",
    content: "# September payouts\n\nAll 214 payouts reconciled.",
  },
  t(76),
  "mcp-asset",
);
const mcpAssetOk = result(
  mcpAsset,
  "Wrote reconciliation-september.md",
  t(76, 1),
);

const skill = tool("Skill", { skill: "design-principles" }, t(77), "skill");
const skillOk = result(skill, "Loaded skill design-principles.", t(77, 1));

const PLAN: PlanItem[] = [
  {
    content: "Move the barcode under the points strip",
    status: "completed",
    activeForm: "Moving the barcode",
  } as PlanItem,
  {
    content: "Format points with thousands separators",
    status: "completed",
    activeForm: "Formatting points",
  } as PlanItem,
  {
    content: "Check the pass at 390px",
    status: "in_progress",
    activeForm: "Checking the pass at 390px",
  } as PlanItem,
  {
    content: "Open the pull request",
    status: "pending",
    activeForm: "Opening the pull request",
  } as PlanItem,
];
const todo = tool("TodoWrite", { todos: PLAN }, t(78), "todo");
const todoOk = result(todo, "Todos updated.", t(78, 1));

for (const id of [
  "bash-x",
  "bash-e-x",
  "read-x",
  "edit-x",
  "grep-x",
  "webfetch-x",
  "task-x",
  "mcp-x",
  "skill-x",
  "todo-x",
])
  expand("tool-call", [id]);
const asExpanded = (e: TranscriptEntry): TranscriptEntry => ({
  ...e,
  id: `${e.id}-x`,
});

const TOOL_W = 780;
type ToolProps = React.ComponentProps<typeof ToolCallBlock>;
const toolSpec = (
  name: string,
  p: ToolProps,
  s: Partial<Specimen> = {},
  steps: Step[] = [],
): Specimen => ({
  name,
  width: TOOL_W,
  select: SETTLE,
  node: (
    <Force steps={steps}>
      <div className="w-full">
        <OpenAssetProvider value={() => {}}>
          <Roots>
            <LiveSubagentsProvider
              value={
                new Map([
                  [
                    taskLive.toolUseId!,
                    { id: "ses_stripe03", status: "running" },
                  ],
                ])
              }
            >
              <ToolCallBlock sessionId={SID} onOpenSubagent={() => {}} {...p} />
            </LiveSubagentsProvider>
          </Roots>
        </OpenAssetProvider>
      </div>
    </Force>
  ),
  ...s,
});
const HOVER: Step[] = [{ sel: "button[aria-expanded]", do: "attr" }];

const family = (
  row: string,
  entry: TranscriptEntry,
  ok: TranscriptEntry,
  opts: {
    err?: TranscriptEntry;
    errEntry?: TranscriptEntry;
    expanded?: boolean;
  } = {},
): Specimen[] => [
  toolSpec(`${row} · collapsed · done`, { entry, result: ok }),
  toolSpec(`${row} · collapsed · hover`, { entry, result: ok }, {}, HOVER),
  toolSpec(`${row} · collapsed · running`, { entry, pending: true }),
  ...(opts.err
    ? [
        toolSpec(`${row} · collapsed · error`, {
          entry: opts.errEntry ?? entry,
          result: opts.err,
        }),
      ]
    : []),
  ...(opts.expanded === false
    ? []
    : [
        toolSpec(`${row} · expanded · done`, {
          entry: asExpanded(entry),
          result: { ...ok, id: `${ok.id}-x` },
        }),
      ]),
];

/* Grouped run of routine steps */
const r1 = tool("Read", { file_path: `${PASS}/pass-card.tsx` }, t(90), "r1");
const r2 = tool("Grep", { pattern: "barcode", path: PASS }, t(90, 10), "r2");
const r3 = tool(
  "Edit",
  {
    file_path: `${PASS}/barcode.tsx`,
    old_string: code(6),
    new_string: code(9),
  },
  t(90, 20),
  "r3",
);
const runItems = [r1, r2, r3];
const runResults = results(
  result(r1, code(10), t(90, 1)),
  result(r2, "barcode.tsx:14", t(90, 11)),
  result(r3, "The file has been updated.", t(90, 21)),
);
const o1 = { ...r1, id: "o1" },
  o2 = { ...r2, id: "o2" },
  o3 = { ...r3, id: "o3" };
expand("tool-run", ["o1", "o2", "o3"]);
const runSpec = (
  name: string,
  items: TranscriptEntry[],
  res: Map<string, TranscriptEntry>,
  live = false,
  s: Partial<Specimen> = {},
  steps: Step[] = [],
): Specimen => ({
  name,
  width: TOOL_W,
  select: SETTLE,
  node: (
    <Force steps={steps}>
      <div className="w-full">
        <Roots>
          <ToolSection
            items={items}
            toolResults={res}
            live={live}
            expandAll={false}
            sessionId={SID}
          />
        </Roots>
      </div>
    </Force>
  ),
  ...s,
});

/* ── Ask card ─────────────────────────────────────────────────────────── */

const Q_BARCODE: AskQuestion = {
  header: "Barcode",
  question:
    "Which barcode format should the wallet pass use? Scanners at the partner gyms read **QR** and **PDF417**.",
  options: [
    {
      label: "QR code",
      description:
        "Square, scans from any angle. Works with every partner scanner.",
    },
    {
      label: "PDF417",
      description: "Wide and short, fits the strip without resizing it.",
    },
    {
      label: "Aztec",
      description: "Smallest of the three, but two partners can't read it.",
    },
  ],
};
const Q_PLAIN: AskQuestion = {
  question:
    "Should I open the pull request now, or wait for Maya's screenshots?",
  options: [{ label: "Open it now" }, { label: "Wait for screenshots" }],
};
const Q_MULTI: AskQuestion = {
  header: "Platforms",
  question:
    "Which platforms should the redesigned pass ship to in this release?",
  multiSelect: true,
  options: [
    {
      label: "Apple Wallet",
      description: "Signed .pkpass through the existing pass service.",
    },
    {
      label: "Google Wallet",
      description: "Needs a new issuer account before launch.",
    },
    {
      label: "Email fallback",
      description: "PDF attachment for members without a wallet app.",
    },
  ],
};
const Q_TIER: AskQuestion = {
  header: "Tier colour",
  question: "Keep the current tier colours, or use the December brand palette?",
  options: [{ label: "Keep current" }, { label: "December palette" }],
};
const Q_FREE: AskQuestion = {
  question:
    "What should the pass call the points balance? Today it says **Points**.",
};

type AskProps = Partial<React.ComponentProps<typeof AskCard>>;
/** The status row wraps only when it runs out of room, which it never does
 *  here. The serializer reads a wrapping row whose items differ in height
 *  (the 28px dismiss button) as several lines and drops the ml-auto that
 *  parks the button right, so the row is pinned to one line. */
const ASK_ONE_LINE: Step[] = [
  { sel: "form > div:first-child", do: "style", value: "flex-wrap:nowrap" },
];
const askSpec = (
  name: string,
  questions: AskQuestion[],
  steps: Step[] = [],
  s: Partial<Specimen> = {},
  // The transcript's card can always be dismissed (SessionViewerMainRegion).
  props: AskProps = { onDismiss: () => {} },
): Specimen => ({
  name,
  width: 780,
  select: SETTLE,
  node: (
    <Force steps={[...ASK_ONE_LINE, ...steps]}>
      <AskCard
        questions={questions}
        onAnswer={() => {}}
        active={false}
        {...props}
      />
    </Force>
  ),
  ...s,
});

/* The incident page's next-action card (incidents/NextAction.tsx): blue
   "Next" status, plain-text question, suggested steps then quiet fixed
   decisions, a note a pick needs, and Close without action in the menu. */
const Q_INCIDENT: AskQuestion = {
  question:
    "Exports on staging fail with heap out of memory since 09:40. The likely cause is the batch buffer kept by rowsSeen in worker.ts.",
  options: [
    {
      label: "Roll back to v2.14.0",
      description:
        "Redeploys the last release. Exports work again in about 4 minutes.",
    },
    {
      label: "Ship the fix in #517",
      description:
        "Releases the buffer after each write. Needs a review first.",
    },
    { label: "Snooze for an hour", description: "Pages again at 11:40" },
    {
      label: "Not an incident",
      description: "Closes it and mutes this signal",
    },
  ],
};
const INCIDENT_PROPS: AskProps = {
  status: { label: "Next", tone: "blue" },
  plainText: true,
  freeText: {
    label: "Tell the investigator",
    placeholder: "Tell the investigator what to look at…",
    submitLabel: "Add note",
  },
  groups: [
    { label: "Suggested", count: 2 },
    { label: "Or decide", count: 2, quiet: true },
  ],
  notes: {
    "Not an incident": {
      label: "Why is this not an incident?",
      placeholder: "The investigator learns from this",
      maxLength: 500,
    },
  },
  context: (
    <p className="m-0 text-supporting leading-[1.45] text-dim">
      Started 09:40 after deploy v2.14.1. 38 exports failed, 4 customers
      affected.
    </p>
  ),
  menu: [{ key: "close", label: "Close without action", onSelect: () => {} }],
};

/* ── Answered ask card ────────────────────────────────────────────────── */

const ANS_LONE: AnsweredAskData = {
  version: 1,
  questions: [{ ...Q_BARCODE, answer: "QR code" }],
};
const ANS_TYPED: AnsweredAskData = {
  version: 1,
  questions: [{ ...Q_BARCODE, answer: "PDF417 on Apple, QR on Google" }],
};
const ANS_MULTI_Q: AnsweredAskData = {
  version: 1,
  questions: [
    { ...Q_MULTI, answer: "Apple Wallet, Email fallback" },
    { ...Q_TIER, answer: "Keep current" },
  ],
};
const ANS_FREE: AnsweredAskData = {
  version: 1,
  questions: [{ ...Q_FREE, answer: "Habit points" }],
};
const ANS_SKIPPED: AnsweredAskData = {
  version: 1,
  questions: [{ ...Q_PLAIN, answer: "" }],
};
const answeredSpec = (
  name: string,
  record: AnsweredAskData,
  s: Partial<Specimen> = {},
): Specimen => ({
  name,
  width: 780,
  node: <AnsweredAskCard record={record} entryId={`ans-${name}`} />,
  ...s,
});

/* ── Note bubble ──────────────────────────────────────────────────────── */

const NOTE_TS = Date.parse("2026-11-08T10:42:00.000Z");
const MIN = 60_000;
const comment = (
  id: string,
  user: string,
  text: string,
  ts: number,
  extra: Partial<ThreadComment> = {},
): ThreadComment => ({ id, user, text, ts, ...extra });
const thread = (
  id: string,
  comments: ThreadComment[],
  extra: Partial<CommentThread> = {},
): CommentThread => ({
  id,
  sessionId: SID,
  status: "open",
  createdBy: comments[0]!.user,
  ts: comments[0]!.ts,
  updatedAt: comments[comments.length - 1]!.ts,
  comments,
  ...extra,
});
const noteOther = thread("n1", [
  comment(
    "c1",
    "Jaap",
    "Heads up: the partner gyms in Utrecht still run the old scanners, so QR only for them until January.",
    NOTE_TS,
  ),
]);
const MINE_TEXT =
  "Talked to @Maya, she'll send the 390px screenshots after lunch. Holding the PR until then.";
const noteMine = thread("n2", [
  comment("c2", ME, MINE_TEXT, NOTE_TS + 6 * MIN),
]);
const noteEdited = thread("n3", [
  comment("c3", ME, MINE_TEXT, NOTE_TS + 6 * MIN, {
    editedAt: NOTE_TS + 9 * MIN,
  }),
]);
const noteLong = thread("n4", [
  comment(
    "c4",
    "Maya",
    "Checked the pass on an iPhone SE, a Pixel 8 and an iPad mini.\nThe barcode clears the footer on all three.\nOne thing: the tier label wraps on the SE when the member name is long, worth a follow-up.",
    NOTE_TS - 26 * 60 * MIN,
  ),
]);
const noteReplies = thread("n5", [
  noteOther.comments[0]!,
  comment(
    "c5",
    "Maya",
    "Same for Rotterdam Noord, they swap scanners in February.",
    NOTE_TS + 4 * MIN,
  ),
  comment(
    "c6",
    ME,
    "Noted. I'll keep QR as the default and add PDF417 behind a flag.",
    NOTE_TS + 7 * MIN,
  ),
]);
const noteAssigned = thread(
  "n6",
  [
    comment(
      "c7",
      ME,
      "Can someone check the tier label on the SE with a long member name?",
      NOTE_TS + 12 * MIN,
    ),
  ],
  { assignee: "Maya" },
);
const noteAgent = thread("n7", [
  comment(
    "c8",
    ME,
    "@agent which gyms are still on the old scanners?",
    NOTE_TS + 15 * MIN,
  ),
  comment(
    "c9",
    "Pi",
    "From `partners/scanners.json`: **Utrecht Centrum**, **Utrecht Oost** and **Rotterdam Noord** read QR only. Every other partner reads QR and PDF417.",
    NOTE_TS + 16 * MIN,
    { agent: true },
  ),
]);
const noteAnswering = thread(
  "n8",
  [noteAgent.comments[0]!],
  // Within the stale window, so the shimmer line shows (agentIsAnswering).
  { agentPendingSince: Date.now() },
);
const noteResolved = thread("n9", noteReplies.comments, {
  status: "resolved",
  resolvedBy: "Jaap",
  resolvedAt: NOTE_TS + 20 * MIN,
});
const NOTE_MENU = 'button[aria-label="Thread actions"]';
const noteSpec = (
  name: string,
  note: CommentThread,
  steps: Step[] = [],
  s: Partial<Specimen> = {},
  // null: a read-only host (the sub-agent pane), no actions and no replies.
  sessionId: string | null = SID,
): Specimen => ({
  name,
  width: 780,
  select: steps.some((x) => x.doc) ? '[role="menu"]' : SETTLE,
  node: (
    <Force steps={steps}>
      <NoteBubble thread={note} sessionId={sessionId ?? undefined} />
    </Force>
  ),
  ...s,
});

/* ── Markdown body ────────────────────────────────────────────────────── */

const MD_PROSE = `The export worker holds every batch because \`rowsSeen\` keeps a reference to each buffer. Releasing it after the write brings the heap back to a flat line.

It peaked at **912 MB** on 200,000 rows and now stays under *180 MB*. The fix is in [#517](https://github.com/kacper/franking/pull/517).`;
const MD_LIST = `What changed:

- \`worker.ts\` drops the batch buffer after each write
- The cursor closes in a \`finally\`, so a failed batch no longer leaks it
- A new test asserts the heap stays under 256 MB

Next steps:

1. Deploy to staging
2. Rerun the September export
3. Watch memory for a day before closing the incident`;
const MD_CODE = `The cursor now closes even when a batch throws:

\`\`\`ts
for await (const batch of cursor.batches(500)) {
  try {
    await writer.write(batch);
  } finally {
    batch.release();
  }
}
\`\`\``;
const MD_TABLE = `| Run | Rows | Peak heap | Duration |
| --- | ---: | ---: | ---: |
| Before | 200,000 | 912 MB | 4m 12s |
| After | 200,000 | 176 MB | 3m 48s |
| After, 1M rows | 1,000,000 | 181 MB | 18m |`;
const MD_QUOTE = `### Release note

> Exports no longer slow down or fail on large workspaces.

Shipped in \`v2.14.1\`.`;
const MD_PRS = `PR #517 fixes the leak. Once PR #517 is merged, PR #521 drops the workaround.`;
const MD_REMOTE = `Maya's screenshot from the iPhone SE:

![Pass on an iPhone SE](https://i.imgur.com/pass-se.png)

The recording is on [Loom ![Walkthrough](https://cdn.loom.com/pass-walkthrough.mp4)](https://www.loom.com/share/pass-walkthrough).`;
const MD_REMOTE_IMAGE = MD_REMOTE.split("\n\nThe recording")[0];
const MD_PROSE_TABLE = `| PR | State | What it changes |
| --- | --- | --- |
| #517 | Open | Releases the batch buffer after each write in the export worker |
| #518 | Merged | Closes the cursor in a finally block |
| #521 | Draft | Removes the 20 second timeout workaround from the tests |`;
const MD_DOC = `# Wallet pass redesign

Moves the barcode into the flow under the points strip, so it no longer overlaps the footer on small phones.

## What changed

- \`PassStrip\` renders above the barcode at a fixed 92px
- Points use \`formatPoints\`, so 12480 reads **12,480**
- Tier colours are unchanged until the December brand refresh

### Checklist

- [x] Move the barcode under the points strip
- [x] Format points with thousands separators
- [ ] Check the pass at 390px on an iPhone SE

> The partner gyms in Utrecht read QR only until January.

## Layout

\`\`\`ts
const STRIP_HEIGHT = 92;
const BARCODE_GAP = 12;
\`\`\`

| Phone | Width | Barcode clearance |
| --- | ---: | ---: |
| iPhone SE | 320 | 12px |
| Pixel 8 | 412 | 18px |
| iPad mini | 744 | 40px |`;
/** The phone page stops before the code and table: the capture is bounded
 *  by the phone viewport's height. */
const MD_DOC_SHORT = MD_DOC.split("\n\n## Layout")[0];
const doc = (
  name: string,
  src: string,
  s: Partial<Specimen> = {},
): Specimen => ({
  name,
  width: 780,
  select: SETTLE,
  // As AssetView opens a .md file: the raised page, the document scale.
  node: (
    <div className="w-full bg-raised px-6 py-10 sm:px-12 sm:py-14">
      <MarkdownBody
        className="markdown markdown-doc"
        html={renderMarkdown(src)}
      />
    </div>
  ),
  ...s,
});
const md = (
  name: string,
  src: string,
  s: Partial<Specimen> = {},
): Specimen => ({
  name,
  width: 780,
  select: SETTLE,
  node: (
    <MarkdownBody
      className={`${msgBody} markdown w-full text-fg`}
      html={renderMarkdown(src, { repo: "kacper/franking" })}
    />
  ),
  ...s,
});

/* ── Keychain ask and force merge cards ─────────────────────────────── */

/* Both read their request from the server by session id (mocked above). */
const keychain = (name: string, sessionId: string): Specimen => ({
  name,
  width: 780,
  select: SETTLE,
  node: (
    <div className="flex w-full flex-col">
      <KeychainAskCard sessionId={sessionId} />
    </div>
  ),
});
const forceMerge = (name: string, sessionId: string): Specimen => ({
  name,
  width: 780,
  select: SETTLE,
  node: (
    <div className="flex w-full flex-col">
      <ForceMergeCard sessionId={sessionId} />
    </div>
  ),
});

/* ── Sections ─────────────────────────────────────────────────────────── */

export const sections: Section[] = [
  /* MessageBubble */
  {
    group: "Message bubble",
    title: "User",
    specimens: [
      bubble("user · short · default", own),
      bubble("user · short · sending", own, {
        pendingDelivery: true,
        optimistic: true,
      }),
      bubble("user · long · default", ownLong),
      bubble("user · with file · default", ownFile),
      bubble("user · with pasted text · default", ownPaste),
      bubble("teammate · in app · default", teammate),
      bubble("teammate · via Slack · default", viaSlack),
    ],
  },
  {
    group: "Message bubble",
    title: "Assistant",
    specimens: [
      bubble("assistant · answer · default", answer),
      bubble("assistant · reasoning · default", reasoning),
      {
        ...bubble("agent · incoming · collapsed", incoming, { sessionId: SID }),
        select: SETTLE,
      },
    ],
  },
  {
    group: "Message bubble",
    title: "Notices",
    specimens: [
      bubble(
        "notice · info · merged",
        notice("Merged #482 into main", { icon: "merge" }),
      ),
      bubble(
        "notice · info · deployed",
        notice("Deployed to staging", { icon: "deploy" }),
      ),
      bubble(
        "notice · info · collapsed",
        notice(
          "Context compacted",
          { kind: "compaction", body: "collapsed" },
          "Summary of the first 42 turns.",
        ),
      ),
      bubble(
        "notice · inline · recap",
        notice(
          "While you were away",
          { kind: "recap", body: "inline" },
          "The agent moved the barcode, fixed points formatting and is waiting on screenshots before opening the PR.",
        ),
      ),
      bubble("notice · info · loop check", loopTick),
      bubble(
        "notice · warn · default",
        notice("Switched to Sonnet 4.5 after the Opus 4.5 limit and retried", {
          tone: "warn",
        }),
      ),
      bubble(
        "notice · error · with continue",
        notice("The run stopped after the runner went offline 40 minutes ago", {
          tone: "error",
        }),
        { onContinue: () => {} },
      ),
    ],
  },
  {
    group: "Message bubble",
    title: "You should know",
    specimens: [
      {
        ...bubble("you should know · note · default", yskOpen),
        select: SETTLE,
      },
      {
        ...bubble("you should know · note · learn more", yskLearn, {}, {}, [
          { sel: "button[aria-expanded]", do: "click" },
        ]),
        select: SETTLE,
      },
      bubble("you should know · folded · asked", yskAsked),
      bubble("you should know · folded · known", yskKnown),
    ],
  },
  {
    group: "Message bubble",
    title: "Phone",
    specimens: [
      phone(bubble("phone · user · default", ownLong)),
      phone(bubble("phone · assistant · default", answer)),
      phone(bubble("phone · you should know · default", yskOpen)),
      phone(
        bubble(
          "phone · notice · error",
          notice(
            "The run stopped after the runner went offline 40 minutes ago",
            { tone: "error" },
          ),
          { onContinue: () => {} },
        ),
      ),
    ],
  },

  /* TurnBlock */
  {
    group: "Turn block",
    title: "Collapsed",
    specimens: [
      turnSpec("collapsed · done · with changes", turnA, turnAResults, false),
      turnSpec("collapsed · done · hover", turnA, turnAResults, false, {
        node: (
          <Force steps={[{ sel: "button[aria-expanded]", do: "attr" }]}>
            <Roots>
              <div className="w-full px-2">
                <TurnBlock
                  items={turnA}
                  toolResults={turnAResults}
                  live={false}
                  sessionId={SID}
                  quietThoughts="all"
                />
              </div>
            </Roots>
          </Force>
        ),
      }),
      turnSpec(
        "collapsed · running · tool only",
        turnD,
        turnDResults,
        true,
        {},
        false,
        { phase: "tool" },
      ),
      turnSpec("collapsed · running · narrated", turnC, turnCResults, true),
    ],
  },
  {
    group: "Turn block",
    title: "Expanded",
    specimens: [
      turnSpec("expanded · done · narrated", turnB, turnBResults, false),
      turnSpec(
        "expanded · done · thoughts in full",
        turnB.map((e) => ({ ...e })),
        turnBResults,
        false,
        {},
        false,
        { quiet: "none" },
      ),
      turnSpec(
        "expanded · running · thinking",
        turnC,
        turnCResults,
        true,
        {},
        true,
      ),
    ],
  },
  {
    group: "Turn block",
    title: "Phone",
    specimens: [
      phone(turnSpec("phone · collapsed · done", turnA, turnAResults, false)),
      phone(turnSpec("phone · expanded · done", turnB, turnBResults, false)),
    ],
  },

  /* TurnFooter */
  {
    group: "Turn footer",
    title: "Variants",
    specimens: [
      footer("footer · files · default", FILES),
      footer("footer · more files · default", MORE_FILES),
      footer("footer · asset · default", [], ["reconciliation-september.md"]),
      footer("footer · no files · default", []),
      footer("footer · files · copy hover", FILES, [], {}, [
        { sel: 'button[aria-label="Copy message"]', do: "attr" },
      ]),
      footer("footer · files · menu open", FILES, [], { width: 780 }, [
        { sel: 'button[aria-label="More message actions"]', do: "click" },
        {
          sel: '[role="menu"]',
          do: "attr",
          value: "data-x",
          doc: true,
          at: 200,
        },
      ]),
    ],
  },
  {
    group: "Turn footer",
    title: "Phone",
    specimens: [phone(footer("phone · more files · default", MORE_FILES))],
  },

  /* ToolCallBlock */
  {
    group: "Tool call",
    title: "Run",
    specimens: [
      ...family("Bash", bash, bashOk, { err: bashEErr, errEntry: bashE }),
      toolSpec("Bash · expanded · error", {
        entry: asExpanded(bashE),
        result: { ...bashEErr, id: "bash-e-err-x" },
      }),
      toolSpec("Bash · collapsed · long command", {
        entry: bashLong,
        result: result(
          bashLong,
          "Wrote reports/reconciliation-september.md",
          t(71),
        ),
      }),
    ],
  },
  {
    group: "Tool call",
    title: "File read",
    specimens: family("Read", read, readOk),
  },
  {
    group: "Tool call",
    title: "Edit",
    specimens: family("Edit", edit, editOk),
  },
  {
    group: "Tool call",
    title: "Find",
    specimens: [
      ...family("Grep", grep, grepOk),
      toolSpec("Glob · collapsed · done", {
        entry: glob,
        result: result(glob, "public/passes/gold.pass.json", t(73, 1)),
      }),
    ],
  },
  {
    group: "Tool call",
    title: "Web",
    specimens: [
      ...family("WebFetch", webFetch, webFetchOk),
      toolSpec("WebSearch · collapsed · done", {
        entry: webSearch,
        result: result(webSearch, "3 results", t(74, 2)),
      }),
    ],
  },
  {
    group: "Tool call",
    title: "Agent",
    specimens: [
      ...family("Task", task, taskOk, { expanded: true }).filter(
        (s) => !s.name.includes("running"),
      ),
      toolSpec("Task · collapsed · running", {
        entry: taskLive,
        pending: true,
      }),
    ],
  },
  {
    group: "Tool call",
    title: "MCP",
    specimens: [
      ...family("Linear", mcp, mcpOk),
      toolSpec("Asset · collapsed · done", {
        entry: mcpAsset,
        result: mcpAssetOk,
      }),
    ],
  },
  {
    group: "Tool call",
    title: "Skill and plan",
    specimens: [
      ...family("Skill", skill, skillOk, { expanded: false }),
      toolSpec("TodoWrite · collapsed · done", { entry: todo, result: todoOk }),
      toolSpec("TodoWrite · expanded · done", {
        entry: asExpanded(todo),
        result: { ...todoOk, id: "todo-r-x" },
      }),
    ],
  },
  {
    group: "Tool call",
    title: "Grouped steps",
    specimens: [
      runSpec("steps · collapsed · done", runItems, runResults),
      runSpec("steps · collapsed · hover", runItems, runResults, false, {}, [
        { sel: "button[aria-expanded]", do: "attr" },
      ]),
      runSpec(
        "steps · collapsed · running",
        runItems,
        results(result(r1, code(10), t(90, 1))),
        true,
      ),
      runSpec(
        "steps · expanded · done",
        [o1, o2, o3],
        results(
          { ...result(r1, code(10), t(90, 1)) },
          { ...result(r2, "barcode.tsx:14", t(90, 11)) },
          { ...result(r3, "The file has been updated.", t(90, 21)) },
        ),
      ),
    ],
  },
  {
    group: "Tool call",
    title: "Phone",
    specimens: [
      phone(toolSpec("phone · Edit · done", { entry: edit, result: editOk })),
      phone(toolSpec("phone · Linear · done", { entry: mcp, result: mcpOk })),
      phone(
        toolSpec("phone · Bash · running", { entry: bashLong, pending: true }),
      ),
      phone(runSpec("phone · steps · done", runItems, runResults)),
    ],
  },

  /* PlanChecklist */
  {
    group: "Plan checklist",
    title: "States",
    specimens: [
      {
        name: "plan · mixed · default",
        width: 420,
        node: <PlanChecklist items={PLAN} className="w-full" />,
      },
      {
        name: "plan · mixed · live",
        width: 420,
        node: <PlanChecklist items={PLAN} live className="w-full" />,
      },
      {
        name: "plan · all done · default",
        width: 420,
        node: (
          <PlanChecklist
            items={PLAN.map((p) => ({ ...p, status: "completed" as const }))}
            className="w-full"
          />
        ),
      },
      {
        name: "plan · capped · more",
        width: 420,
        node: (
          <PlanChecklist
            items={[
              ...PLAN,
              {
                content: "Write the release note",
                status: "pending",
              } as PlanItem,
              {
                content: "Tell the partner gyms",
                status: "pending",
              } as PlanItem,
            ]}
            max={4}
            className="w-full"
          />
        ),
      },
      {
        name: "plan · long step · wrapping",
        width: 300,
        node: (
          <PlanChecklist
            items={[
              {
                content:
                  "Reconcile September Stripe payouts against the ledger export and flag late refunds",
                status: "in_progress",
              } as PlanItem,
              PLAN[3],
            ]}
            className="w-full"
          />
        ),
      },
    ],
  },

  /* TypingIndicator */
  {
    group: "Typing indicator",
    title: "States",
    specimens: [
      {
        name: "typing · one person · default",
        node: (
          <TypingIndicator
            presence={{
              users: ["Jaap"],
              drafts: { Jaap: "Can we keep QR for the Utrecht gyms" },
            }}
          />
        ),
      },
      {
        name: "typing · several people · default",
        node: (
          <TypingIndicator presence={{ users: ["Jaap", "Maya"], drafts: {} }} />
        ),
      },
      {
        // Composed: the inline preview line only renders on a touch-primary
        // client (isTouchPrimary, read once at module load), which the
        // headless browser isn't. Same markup and classes as the component.
        name: "phone · one person · with preview",
        width: 390,
        viewport: 390,
        node: (
          <div className="w-full text-label text-faint">
            <span role="status" className="inline-block">
              Jaap is typing…
            </span>
            <div className="truncate">
              Can we keep QR for the Utrecht gyms until the new scanners arrive
              in January
            </div>
          </div>
        ),
      },
    ],
  },

  /* ReplySuggestions */
  {
    group: "Reply suggestions",
    title: "States",
    specimens: [
      {
        name: "chips · three · default",
        width: 780,
        select: SETTLE,
        node: (
          <ReplySuggestions
            className="w-full"
            onPick={() => {}}
            suggestions={[
              {
                label: "Open the PR",
                text: "Open the pull request against main with the screenshots.",
              },
              {
                label: "Fix both",
                text: "Fix the tier label wrap and the barcode gap in this PR.",
              },
              {
                label: "Only step 1",
                text: "Only move the barcode for now, leave the tier label.",
              },
            ]}
          />
        ),
      },
      {
        name: "chips · three · hover",
        width: 780,
        select: SETTLE,
        node: (
          <Force steps={[{ sel: "button", do: "attr" }]}>
            <ReplySuggestions
              className="w-full"
              onPick={() => {}}
              suggestions={[
                {
                  label: "Open the PR",
                  text: "Open the pull request against main with the screenshots.",
                },
                {
                  label: "Fix both",
                  text: "Fix the tier label wrap and the barcode gap in this PR.",
                },
                {
                  label: "Only step 1",
                  text: "Only move the barcode for now, leave the tier label.",
                },
              ]}
            />
          </Force>
        ),
      },
      {
        name: "phone · overflowing · default",
        width: 390,
        viewport: 390,
        select: SETTLE,
        node: (
          <ReplySuggestions
            className="w-full px-3"
            onPick={() => {}}
            suggestions={[
              {
                label: "Deploy to staging",
                text: "Deploy the export fix to staging.",
              },
              {
                label: "Rerun September",
                text: "Rerun the September export on staging.",
              },
              {
                label: "Close incident",
                text: "Close the incident with a summary.",
              },
              {
                label: "Write release note",
                text: "Write the release note for v2.14.1.",
              },
            ]}
          />
        ),
      },
    ],
  },

  /* AskCard */
  {
    group: "Ask card",
    title: "Single question",
    specimens: [
      askSpec("single · with header · idle", [Q_BARCODE]),
      askSpec(
        "single · with header · hover",
        [Q_BARCODE],
        [{ sel: "fieldset label:first-of-type", do: "attr" }],
      ),
      askSpec("single · plain · idle", [Q_PLAIN]),
      askSpec(
        "single · with header · own answer",
        [Q_BARCODE],
        [
          {
            sel: 'input[type="text"], input:not([type])',
            do: "type",
            value: "PDF417 on Apple, QR on Google",
          },
        ],
      ),
      askSpec("single · free text · idle", [Q_FREE]),
    ],
  },
  {
    group: "Ask card",
    title: "Multiple",
    specimens: [
      askSpec(
        "multi-select · two picked · ready",
        [Q_MULTI],
        [
          { sel: 'input[value="Apple Wallet"]', do: "click" },
          { sel: 'input[value="Email fallback"]', do: "click", at: 80 },
        ],
      ),
      askSpec(
        "stepped · question 1 of 2 · picked",
        [Q_BARCODE, Q_TIER],
        [{ sel: 'input[value="QR code"]', do: "click" }],
      ),
    ],
  },
  {
    group: "Ask card",
    title: "Incident",
    specimens: [
      askSpec(
        "incident · grouped · idle",
        [Q_INCIDENT],
        [],
        {},
        INCIDENT_PROPS,
      ),
      askSpec(
        "incident · grouped · picked",
        [Q_INCIDENT],
        [{ sel: 'input[value="Roll back to v2.14.0"]', do: "click" }],
        {},
        INCIDENT_PROPS,
      ),
      askSpec(
        "incident · note · needed",
        [Q_INCIDENT],
        [{ sel: 'input[value="Not an incident"]', do: "click" }],
        {},
        INCIDENT_PROPS,
      ),
      askSpec(
        "incident · typed · add note",
        [Q_INCIDENT],
        [
          {
            sel: 'input[type="text"], input:not([type])',
            do: "type",
            value: "Check whether the 09:40 deploy changed the batch size",
          },
        ],
        {},
        INCIDENT_PROPS,
      ),
      askSpec(
        "incident · menu · open",
        [Q_INCIDENT],
        [{ sel: 'button[aria-label="More choices"]', do: "click" }],
        { select: '[role="menu"]' },
        INCIDENT_PROPS,
      ),
    ],
  },
  {
    group: "Ask card",
    title: "Phone",
    specimens: [
      phone(askSpec("phone · single · idle", [Q_BARCODE])),
      phone(
        askSpec(
          "phone · incident · idle",
          [Q_INCIDENT],
          [],
          {},
          INCIDENT_PROPS,
        ),
      ),
    ],
  },

  /* AnsweredAskCard */
  {
    group: "Answered ask card",
    title: "States",
    specimens: [
      answeredSpec("answered · option · default", ANS_LONE),
      answeredSpec("answered · own answer · default", ANS_TYPED),
      answeredSpec("answered · two questions · default", ANS_MULTI_Q),
      answeredSpec("answered · free text · default", ANS_FREE),
      answeredSpec("answered · no answer · default", ANS_SKIPPED),
      phone(answeredSpec("phone · option · default", ANS_LONE)),
    ],
  },

  /* NoteBubble */
  {
    group: "Note bubble",
    title: "States",
    specimens: [
      noteSpec("note · teammate · default", noteOther),
      noteSpec("note · mine · default", noteMine),
      noteSpec("note · mine · edited", noteEdited),
      noteSpec("note · teammate · multi-line", noteLong),
      noteSpec("note · teammate · replying", noteOther, [
        {
          sel: "textarea",
          do: "type",
          value: "Good to know, I'll tell the Utrecht gyms on Monday.",
        },
      ]),
      noteSpec(
        "note · mine · menu open",
        noteMine,
        [{ sel: NOTE_MENU, do: "click" }],
        { select: '[role="menu"]' },
      ),
      noteSpec(
        "note · mine · editing",
        noteMine,
        [
          { sel: NOTE_MENU, do: "click" },
          {
            sel: '[role="menuitem"]:has(+ [role="menuitem"].text-red)',
            do: "click",
            doc: true,
            at: 200,
          },
        ],
        { select: SETTLE },
      ),
    ],
  },
  {
    group: "Note bubble",
    title: "Threads",
    specimens: [
      noteSpec("thread · replies · default", noteReplies),
      noteSpec("thread · assigned · default", noteAssigned),
      noteSpec("thread · agent · answering", noteAnswering),
      noteSpec("thread · agent · answered", noteAgent),
      noteSpec("thread · resolved · folded", noteResolved),
      noteSpec("thread · resolved · shown", noteResolved, [
        { sel: "button", do: "click" },
      ]),
      noteSpec("thread · read only · default", noteReplies, [], {}, null),
    ],
  },
  {
    group: "Note bubble",
    title: "Phone",
    specimens: [
      phone(noteSpec("phone · teammate · default", noteOther)),
      phone(noteSpec("phone · replies · default", noteReplies)),
      phone(noteSpec("phone · resolved · folded", noteResolved)),
    ],
  },

  /* SessionContextMessage */
  {
    group: "Session context",
    title: "States",
    specimens: [
      {
        name: "context · loading · default",
        width: 780,
        select: SETTLE,
        node: (
          <Force
            steps={[
              { sel: '[role="status"]', do: "style", value: "animation:none" },
              { sel: ".animate-pulse", do: "style", value: "animation:none" },
            ]}
          >
            <SessionContextMessage sessionId="ses_ctx_loading" />
          </Force>
        ),
      },
      {
        name: "context · available · collapsed",
        width: 780,
        select: SETTLE,
        node: <SessionContextMessage sessionId="ses_ctx_full" />,
      },
      {
        name: "context · partial · collapsed",
        width: 780,
        select: SETTLE,
        node: <SessionContextMessage sessionId="ses_ctx_partial" />,
      },
      {
        name: "context · available · expanded",
        width: 780,
        select: SETTLE,
        node: (
          <Force
            steps={[{ sel: "button[aria-expanded]", do: "click", at: 120 }]}
          >
            <SessionContextMessage sessionId="ses_ctx_open" />
          </Force>
        ),
      },
      {
        name: "context · history · loading",
        width: 780,
        select: SETTLE,
        node: <SessionContextMessage sessionId="ses_ctx_full" historyLoading />,
      },
      phone({
        name: "phone · available · collapsed",
        select: SETTLE,
        node: <SessionContextMessage sessionId="ses_walletpass01" />,
      }),
    ],
  },

  /* MarkdownBody */
  {
    group: "Markdown body",
    title: "Samples",
    specimens: [
      md("markdown · paragraphs · default", MD_PROSE),
      md("markdown · lists · default", MD_LIST),
      md("markdown · code block · default", MD_CODE),
      md("markdown · table · default", MD_TABLE),
      md("markdown · heading and quote · default", MD_QUOTE),
      md("markdown · pull requests · repeated", MD_PRS),
      md("markdown · remote media · default", MD_REMOTE),
      md("markdown · table · prose column", MD_PROSE_TABLE),
      phone(md("phone · code block · default", MD_CODE)),
      phone(md("phone · table · default", MD_TABLE)),
      phone(md("phone · table · prose column", MD_PROSE_TABLE)),
      phone(md("phone · remote media · default", MD_REMOTE_IMAGE)),
    ],
  },
  {
    group: "Markdown body",
    title: "Document",
    specimens: [
      doc("document · page · default", MD_DOC),
      phone(doc("phone · page · default", MD_DOC_SHORT)),
    ],
  },

  /* KeychainAskCard */
  {
    group: "Keychain ask card",
    title: "States",
    specimens: [
      keychain("keychain · borrow · limited", "ses_kc_borrow"),
      keychain("keychain · borrow · open credential", "ses_kc_open"),
      keychain("keychain · run · script", "ses_kc_run"),
      keychain("keychain · login · release", "ses_kc_login"),
      phone(keychain("phone · borrow · limited", "ses_kc_borrow")),
    ],
  },

  /* ForceMergeCard */
  {
    group: "Force merge card",
    title: "States",
    specimens: [
      forceMerge("force merge · driver · bypasses", "ses_fm_driver"),
      forceMerge("force merge · viewer · waiting", "ses_fm_viewer"),
      forceMerge("force merge · driver · nothing to bypass", "ses_fm_clean"),
      phone(forceMerge("phone · driver · bypasses", "ses_fm_driver")),
    ],
  },
];

export const descriptions: Record<string, string> = {
  "Message bubble":
    "components/MessageBubble.tsx · every user, teammate and assistant message, the notice lines between turns, and You should know notes",
  "Turn block":
    "components/TurnBlock.tsx · the fold that holds one turn's work above its final answer",
  "Turn footer":
    "components/TurnFooter.tsx · the quiet row under a finished answer with duration, copy, menu and changed files",
  "Tool call":
    "components/ToolCallBlock.tsx · one tool step inside an open turn, or a grouped run of routine steps",
  "Plan checklist":
    "components/PlanChecklist.tsx · the agent's plan, in a TodoWrite step and the status flap above the composer",
  "Typing indicator":
    "components/TypingIndicator.tsx · under the transcript while a teammate types into the session",
  "Reply suggestions":
    "components/ReplySuggestions.tsx · follow-up chips floating above the composer after a turn ends on a choice",
  "Ask card":
    "components/AskCard.tsx · the agent is blocked on a question and needs input",
  "Answered ask card":
    "components/AnsweredAskCard.tsx · the receipt left in the transcript once a question is answered",
  "Note bubble":
    "components/NoteBubble.tsx · a team note thread in the transcript, with replies, assignee and resolve; the run never sees it",
  "Session context":
    "components/SessionContextMessage.tsx · the first row of a transcript, the provider input before the first message",
  "Markdown body":
    "components/MarkdownBody.tsx · rendered markdown in answers, asks and notes, and a .md file opened on its own (markdown-doc.css)",
  "Keychain ask card":
    "components/KeychainAskCard.tsx · the agent asks to borrow a credential the viewer owns, above the composer",
  "Force merge card":
    "components/ForceMergeCard.tsx · the agent asks the session's driver to merge a pull request past its checks",
};
