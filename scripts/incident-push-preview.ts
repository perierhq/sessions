#!/usr/bin/env bun
/**
 * Send one preview incident notification per kind straight to a person's
 * devices, for checking the lock screen, the buttons and the tap paths on
 * real phones and desktops.
 *
 *   bun scripts/incident-push-preview.ts --user <name> --incident <id> [--kind <kind>]
 *
 * The previews are built by the real planner (server/incidents/notify-plan.ts)
 * from fixture incidents titled "Search" in project "acme" that walk the
 * lifecycle, aimed at `--incident` so a tap opens that incident's page. It
 * writes no inbox rows: it only pushes. Run it as the gateway's user with the
 * gateway's OPENSESSION_STATE_DIR, so it finds the same VAPID keys and push
 * subscriptions.
 */
import type { IncidentResponse } from "../packages/core/opensession-server/src/shared/incident-response";
import type {
  FixedBy,
  Incident,
  IncidentEvent,
  IncidentState,
} from "../packages/core/opensession-server/src/shared/incidents";
import {
  type NotifyFacts,
  planIncidentNotification,
} from "../packages/core/opensession-server/src/server/incidents/notify-plan";
import {
  INCIDENT_NOTIFICATION_KINDS,
  type IncidentNotificationKind,
  type NotificationEvent,
} from "../packages/core/opensession-server/src/server/notification-threads";

const OWNER = "Ada";
const VETO_MINUTES = 6;

interface Step {
  to: IncidentState;
  from?: IncidentState;
  by?: string;
  response?: IncidentResponse;
  fixedBy?: FixedBy;
}

/** One fixture per kind: where the incident was, and the change it made. */
function walks(now: number): Step[] {
  const deadline = new Date(now + VETO_MINUTES * 60_000).toISOString();
  // SAFETY: the planner reads only `next` (and `veto.deadline` as a
  // fallback) from a response; the rest of the record is not consulted.
  const veto = {
    next: { kind: "veto", deadline, rule: "Deploy after veto" },
    veto: { startedAt: new Date(now).toISOString(), deadline },
  } as IncidentResponse;
  // SAFETY: as above, `next` only.
  const needsYou = {
    next: {
      kind: "needs-you",
      reason: "This change costs money, so it needs you",
      needsYou: "policy",
      options: ["stop", "approve", "send-back"],
    },
  } as IncidentResponse;
  return [
    { to: "heads-up" },
    { to: "investigating" },
    { to: "needs-you", from: "investigating", response: needsYou },
    { to: "veto", from: "fix-ready", response: veto },
    { to: "deploying", from: "veto" },
    { to: "rolled-back", from: "watching" },
    { to: "resolved", from: "watching", fixedBy: "agents" },
  ];
}

function fixture(
  incidentId: string,
  now: number,
  state: IncidentState,
  events: IncidentEvent[],
  over: Partial<Incident> = {},
): Incident {
  const at = new Date(now).toISOString();
  return {
    id: incidentId,
    project: "acme",
    title: "Search",
    state,
    severity: "major",
    owner: OWNER,
    openedBy: { kind: "rule", ref: "sig-preview" },
    signalIds: ["sig-preview"],
    primarySignalId: "sig-preview",
    openedAt: at,
    updatedAt: at,
    lastProblemAt: at,
    findings: [],
    events,
    droppedEvents: 0,
    ...over,
  };
}

/**
 * One planned event per incident notification kind, aimed at `incidentId`,
 * by day (no night rule), in this machine's time zone.
 */
export function previewNotifications(
  incidentId: string,
  now: number,
): NotificationEvent[] {
  const facts: NotifyFacts = {
    signal: "failing",
    night: false,
    fullyDown: false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    change: { kind: "deploy" },
  };
  const at = new Date(now).toISOString();
  return walks(now).flatMap((step, index) => {
    const opened: IncidentEvent = {
      id: `preview-${index}-opened`,
      at,
      kind: "opened",
      by: "sessions",
      detail: "",
      to: step.from ?? step.to,
    };
    const previous = step.from
      ? fixture(incidentId, now, step.from, [opened])
      : null;
    const moved: IncidentEvent[] = step.from
      ? [
          {
            id: `preview-${index}-state`,
            at,
            kind: "state",
            by: step.by ?? "sessions",
            detail: "",
            from: step.from,
            to: step.to,
          },
        ]
      : [];
    const next = fixture(incidentId, now, step.to, [opened, ...moved]);
    if (step.response) next.response = step.response;
    if (step.fixedBy) next.fixedBy = step.fixedBy;
    const planned = planIncidentNotification(next, previous, facts, now);
    return planned ? [{ ...planned.event, eventKey: `preview:${index}` }] : [];
  });
}

export interface PreviewArgs {
  user: string;
  incident: string;
  kind?: IncidentNotificationKind;
}

function isIncidentKind(value: string): value is IncidentNotificationKind {
  return INCIDENT_NOTIFICATION_KINDS.some((kind) => kind === value);
}

/** `--user` and `--incident` are required; `--kind` must be a known kind. */
export function parsePreviewArgs(argv: string[]): PreviewArgs | null {
  const flag = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
    return value && !value.startsWith("--") ? value : undefined;
  };
  const user = flag("user");
  const incident = flag("incident");
  const kind = flag("kind");
  if (!user || !incident) return null;
  if (kind === undefined) return { user, incident };
  return isIncidentKind(kind) ? { user, incident, kind } : null;
}

async function main(): Promise<void> {
  const args = parsePreviewArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      `usage: bun scripts/incident-push-preview.ts --user <name> --incident <id> [--kind <${INCIDENT_NOTIFICATION_KINDS.join("|")}>]`,
    );
    process.exit(2);
  }
  // Loaded here, not at the top: the test imports the planner half only.
  const { applyNotificationEvent, wireThread } =
    await import("../packages/core/opensession-server/src/server/notification-threads");
  const { pushFor } =
    await import("../packages/core/opensession-server/src/server/notifications");
  const { sendPushToUser } =
    await import("../packages/core/opensession-server/src/server/push");
  const events = previewNotifications(args.incident, Date.now()).filter(
    (event) => !args.kind || event.kind === args.kind,
  );
  const sent: string[] = [];
  for (const event of events) {
    const { thread } = applyNotificationEvent({ threads: [] }, event);
    if (!thread) continue;
    const { payload, options } = await pushFor(
      wireThread(thread),
      event,
      "alert",
    );
    await sendPushToUser(args.user, payload, options);
    sent.push(`${event.kind}: ${payload.title} · ${payload.body ?? ""}`);
  }
  for (const line of sent) console.log(line);
  console.log(`sent ${sent.length} preview(s) to ${args.user}'s devices`);
}

if (import.meta.main) await main();
