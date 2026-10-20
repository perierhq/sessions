// Source dispatcher: run a polled signal's source once. Pushed sources
// (webhook, heartbeat) produce nothing when polled.
import type { Signal } from "../../../shared/incidents";
import { type SourceRun, type SourceRunOptions, runHttpSource } from "./http";
import { runTlsExpirySource } from "./tls-expiry";

export type { SourceRun, SourceRunOptions } from "./http";

export async function runSignalSource(
  signal: Signal,
  opts: SourceRunOptions = {},
): Promise<SourceRun> {
  const source = signal.source;
  switch (source.kind) {
    case "http":
      return runHttpSource(source, { ...opts, provider: signal.provider });
    case "expiry":
      return runTlsExpirySource(source, opts.now ? { now: opts.now } : {});
    case "webhook":
    case "heartbeat":
      return { observations: [] };
  }
}
