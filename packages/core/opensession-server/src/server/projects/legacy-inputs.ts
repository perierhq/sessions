// What an unmigrated project's settings compose from beside its own legacy
// records: the automations, the connectors (MCP config), the web search
// setting and the per-repo sandbox. Their writers bump this counter, and
// the composed-settings cache (store.ts) folds it into its stamp, so a
// change applies to the next read instead of after the cache's TTL. A leaf
// with no imports: the writers sit low in the import graph.

let generation = 0;

/** Call after writing any input listed above. */
export function legacyInputsChanged(): void {
  generation++;
}

export function legacyInputsGeneration(): number {
  return generation;
}
