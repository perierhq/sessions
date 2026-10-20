// Webhook payloads → observations. An incoming event is an alert (`fail`)
// unless a mapping says otherwise.
import type { Observation, WebhookSource } from "../../../shared/incidents";
import { mapJson } from "../json-mapping";

const MAX_DETAIL_CHARS = 200;

function fallbackDetail(payloadText: string): string {
  const line = payloadText
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, MAX_DETAIL_CHARS) : "Webhook received";
}

export function webhookObservations(
  source: WebhookSource,
  payloadText: string,
  at: string,
): { observations: Observation[]; matches: Record<string, unknown[]> } {
  const fallback = fallbackDetail(payloadText);
  const alert = (): {
    observations: Observation[];
    matches: Record<string, unknown[]>;
  } => ({
    observations: [{ at, result: "fail", detail: fallback }],
    matches: {},
  });
  if (!source.mapping) return alert();
  let doc: unknown;
  try {
    doc = JSON.parse(payloadText);
  } catch {
    return alert();
  }
  const outcome = mapJson(doc, source.mapping);
  const main: Observation = {
    at,
    result: outcome.result ?? "fail",
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    detail: (outcome.detail || fallback).slice(0, MAX_DETAIL_CHARS),
  };
  const lanes = outcome.lanes.map((lane): Observation => ({
    at,
    result: lane.result,
    ...(lane.value === undefined ? {} : { value: lane.value }),
    detail: lane.detail,
    lane: lane.lane,
  }));
  return { observations: [main, ...lanes], matches: outcome.matches };
}
