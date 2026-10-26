// Folds a burst of requests into a leading call and at most one trailing
// call per window: socket messages arrive one per write, and each would
// otherwise refetch on its own. Shared by the incident and Knowledge live
// updates (hooks/useIncidents.ts, lib/knowledge/live.ts).

export interface Coalescer {
  request(): void;
  cancel(): void;
}

/** Leading call, then at most one trailing call per window. */
export function createCoalescer(
  run: () => void,
  windowMs: number,
  now: () => number = Date.now,
): Coalescer {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    last = now();
    run();
  };
  return {
    request() {
      if (timer) return;
      const wait = last + windowMs - now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
