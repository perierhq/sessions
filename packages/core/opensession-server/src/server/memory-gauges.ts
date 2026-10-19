/**
 * Size gauges for long-lived in-process collections, read by the memory
 * diagnostics (memory-diagnostics.ts).
 *
 * State parked on `globalThis.__*` is found by scanning globalThis, so only
 * module-level maps and sets register here: one call next to the
 * declaration, returning the current size. Registering is a map insert and
 * nothing else, so it is safe at import time. This module imports nothing so
 * any server module can depend on it without pulling in a graph.
 */

export type MemoryGauge = () => number;

const g = globalThis as { __osMemoryGauges?: Map<string, MemoryGauge> };

/** The registry itself; also the globalThis key the scan skips. */
export const MEMORY_GAUGES_GLOBAL_KEY = "__osMemoryGauges";

export function memoryGauges(): Map<string, MemoryGauge> {
  return (g.__osMemoryGauges ??= new Map());
}

/**
 * Report the size of a long-lived collection under `name`
 * (`<module>.<variable>`). Re-registering a name replaces the gauge, so
 * `bun --hot` reloads read the live collection.
 */
export function registerMemoryGauge(name: string, size: MemoryGauge): void {
  memoryGauges().set(name, size);
}
