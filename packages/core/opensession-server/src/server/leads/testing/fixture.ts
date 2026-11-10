// Test fixture: a project whose own status page and an outside provider
// flap (each opens 16 incidents in two weeks that close by themselves
// within minutes), whose site had one real outage someone fixed, and whose
// two certificate checks stayed quiet. Fake names throughout.
// Not on any live import chain (excluded from the side-effect scan).
import type {
  FixedBy,
  Incident,
  IncidentState,
  Signal,
} from "../../../shared/incidents";

export const PROJECT = "acme";
export const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;

function signal(
  id: string,
  name: string,
  fields: Partial<Signal> & Pick<Signal, "source" | "rule">,
): Signal {
  return {
    id,
    name,
    project: PROJECT,
    enabled: true,
    severity: "major",
    createdBy: "Ada",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

export const SIGNALS: Signal[] = [
  signal("sig-status", "Status page", {
    source: {
      kind: "http",
      url: "https://status.acme.example/api/v2/status.json",
      json: { preset: "statuspage" },
    },
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    intervalMs: MINUTE,
  }),
  signal("sig-rail", "Rail API", {
    source: { kind: "http", url: "https://api.railco.example/v1/health" },
    rule: { kind: "consecutive", failures: 2, recoveries: 2 },
    intervalMs: MINUTE,
  }),
  signal("sig-site", "Site up", {
    source: { kind: "http", url: "https://acme.example/" },
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    intervalMs: MINUTE,
  }),
  signal("sig-cert", "Certificate", {
    source: { kind: "expiry", target: "tls", host: "acme.example" },
    rule: { kind: "deadline", warnDays: 14, failDays: 3 },
  }),
  signal("sig-cert-www", "Certificate (www)", {
    source: { kind: "expiry", target: "tls", host: "www.acme.example" },
    rule: { kind: "deadline", warnDays: 14, failDays: 3 },
  }),
];

let seq = 0;

export function incident(fields: {
  signalId: string;
  openedAt: number;
  openMinutes: number | null;
  state: IncidentState;
  fixedBy?: FixedBy;
  title?: string;
  project?: string;
}): Incident {
  const opened = new Date(fields.openedAt).toISOString();
  const closed =
    fields.openMinutes === null
      ? undefined
      : new Date(fields.openedAt + fields.openMinutes * MINUTE).toISOString();
  seq++;
  return {
    id: `inc-${String(seq).padStart(4, "0")}`,
    project: fields.project ?? PROJECT,
    title: fields.title ?? `${fields.signalId} is failing`,
    state: fields.state,
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule", ref: fields.signalId },
    signalIds: [fields.signalId],
    primarySignalId: fields.signalId,
    openedAt: opened,
    updatedAt: closed ?? opened,
    lastProblemAt: opened,
    ...(closed ? { closedAt: closed } : {}),
    ...(fields.fixedBy ? { fixedBy: fields.fixedBy } : {}),
    findings: [],
    events: [],
    droppedEvents: 0,
  };
}

/** 16 flaps per flapping signal over 13 days, each open 2 to 6 minutes. */
function flaps(signalId: string, offsetHours: number): Incident[] {
  return Array.from({ length: 16 }, (_, k) =>
    incident({
      signalId,
      openedAt: NOW - 13 * DAY + k * 19 * 3_600_000 + offsetHours * 3_600_000,
      openMinutes: 2 + (k % 5),
      state: "closed-without-action",
      fixedBy: "recovered",
    }),
  );
}

export function fixtureIncidents(): Incident[] {
  seq = 0;
  return [
    ...flaps("sig-status", 0),
    ...flaps("sig-rail", 3),
    incident({
      signalId: "sig-site",
      openedAt: NOW - 4 * DAY,
      openMinutes: 45,
      state: "resolved",
      fixedBy: "by-hand",
      title: "Site down",
    }),
    // Outside the window: never counted.
    incident({
      signalId: "sig-site",
      openedAt: NOW - 30 * DAY,
      openMinutes: 3,
      state: "closed-without-action",
      fixedBy: "recovered",
    }),
  ];
}
