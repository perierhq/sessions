import type { NotificationAlerts } from "./api/notifications";

/**
 * The alert switches in Settings › Notifications, one per server-side alert
 * group (src/server/notification-threads.ts ALERT_GROUPS). The native app
 * shows the same rows with the same text (NativePersonalSettingsViews.swift).
 */
export interface NotificationAlertRow {
  group: keyof NotificationAlerts;
  title: string;
  desc: string;
}

export const NOTIFICATION_ALERT_ROWS: ReadonlyArray<NotificationAlertRow> = [
  {
    group: "reviews",
    title: "Reviews",
    desc: "Someone asks you for a review, or finishes one you asked for",
  },
  {
    group: "teamReviews",
    title: "Team review requests",
    desc: "A team you're on is asked to review, like code owners",
  },
  {
    group: "mentions",
    title: "Mentions and comments",
    desc: "Someone tags you, assigns you a comment, or replies to one you're in",
  },
  {
    group: "collaborators",
    title: "Added to a workspace",
    desc: "Someone adds you as a collaborator",
  },
  { group: "reminders", title: "Reminders", desc: "Desk task reminders" },
  {
    group: "incidents",
    title: "Incidents",
    desc: "An incident you own opens, needs you, is about to deploy, rolls back or is fixed. At night only what can't wait",
  },
];
