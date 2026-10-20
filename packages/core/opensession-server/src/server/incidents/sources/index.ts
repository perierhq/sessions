// Source dispatcher: run a polled signal's source once. Pushed sources
// (webhook, heartbeat) produce nothing when polled. An http signal with
// `runOn` runs from that Runner; other kinds ignore `runOn`.
import type { Signal } from "../../../shared/incidents";
import { type SourceRun, type SourceRunOptions, runHttpSource } from "./http";
import { runnerNet } from "./runner-fetch";
import { runTlsExpirySource } from "./tls-expiry";

export type { SourceRun, SourceRunOptions } from "./http";

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
        ...(signal.runOn
          ? {
              net: runnerNet(
                signal.runOn,
                {},
                {
                  repo: signal.project,
                  user: signal.createdBy,
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
