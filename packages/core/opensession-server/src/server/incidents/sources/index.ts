// Source dispatcher: run a polled signal's source once. Pushed sources
// (webhook, heartbeat) produce nothing when polled. An http signal with
// `runOn` runs from that Runner; other kinds ignore `runOn`.
import type { Signal } from "../../../shared/incidents";
import { type SourceRun, type SourceRunOptions, runHttpSource } from "./http";
import { runnerNet } from "./runner-fetch";
import { runTlsExpirySource } from "./tls-expiry";

export type { SourceRun, SourceRunOptions } from "./http";

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export async function runSignalSource(
  signal: Signal,
  opts: SourceRunOptions = {},
): Promise<SourceRun> {
  const source = signal.source;
  switch (source.kind) {
    case "http":
      return runHttpSource(source, {
        ...opts,
        provider: signal.provider,
        // As the incident service, never as the signal's author; the
        // Runner must still be a reserved production Runner of the project
        // when the check runs.
        ...(signal.runOn
          ? {
              net: runnerNet(
                signal.runOn,
                {},
                {
                  repo: signal.project,
                  signalId: signal.id,
                  host: hostOf(source.url),
                  timeoutMs: source.timeoutMs,
                },
              ),
            }
          : {}),
      });
    case "expiry":
      return runTlsExpirySource(source, opts.now ? { now: opts.now } : {});
    case "webhook":
    case "heartbeat":
      return { observations: [] };
  }
}
