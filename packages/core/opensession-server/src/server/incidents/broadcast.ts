// Live updates for the incident views: one socket message per incident
// write, signal state change, signal edit, or project or access settings
// change. Messages carry ids
// and states only, never details; clients refetch what they show.
// Listeners attach only in startIncidentBroadcasts(); importing this module
// has no effect.
import type { IncidentState, SignalState } from "../../shared/incidents";
import { broadcastToAll } from "../ws-hub";
import { onIncidentAccessChange } from "./access/settings-store";
import { onIncidentChange } from "./incident-store";
import { onProjectSettingsChange } from "./response/project-settings";
import { onSignalStateChange } from "./signal-runtime";
import { onSignalWrite } from "./signal-store";

export type IncidentBroadcast =
  | {
      type: "incidents_changed";
      incidentId: string;
      project: string;
      state: IncidentState;
    }
  | {
      type: "incident_signals_changed";
      signalId: string;
      project: string;
      /** Absent when the signal's configuration changed (created, edited
       *  or deleted) rather than its state. */
      state?: SignalState;
    }
  | { type: "incident_settings_changed"; project: string };

let started = false;
let send: (message: IncidentBroadcast) => void = broadcastToAll;

/** Record broadcasts instead of sending them; undefined restores sending. */
export function __setIncidentBroadcastForTest(
  fn: ((message: IncidentBroadcast) => void) | undefined,
): void {
  send = fn ?? broadcastToAll;
}

/** Start broadcasting incident, signal, settings and access changes.
 *  Idempotent. */
export function startIncidentBroadcasts(): void {
  if (started) return;
  started = true;
  onIncidentChange((next) => {
    send({
      type: "incidents_changed",
      incidentId: next.id,
      project: next.project,
      state: next.state,
    });
  });
  onSignalStateChange((signal, current, previous) => {
    if (previous?.state === current.state) return;
    send({
      type: "incident_signals_changed",
      signalId: signal.id,
      project: signal.project,
      state: current.state,
    });
  });
  onSignalWrite((signal) => {
    send({
      type: "incident_signals_changed",
      signalId: signal.id,
      project: signal.project,
    });
  });
  onProjectSettingsChange((project) => {
    send({ type: "incident_settings_changed", project });
  });
  onIncidentAccessChange((project) => {
    send({ type: "incident_settings_changed", project });
  });
}
