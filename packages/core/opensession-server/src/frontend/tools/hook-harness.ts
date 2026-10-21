// Interaction tests without a DOM: run one component's own hooks by hand.
//
// There is no DOM preload in this repo, so a component test either renders
// static markup or mocks React's hooks (useConnectionPresentation.test.ts).
// This is the second way, made reusable: `mock.module("react", () =>
// reactWithHarness(real, harness))` before importing the component, then
// `harness.mount(Component, props)`. The component function is called with
// these hooks; what it returns is a tree of elements whose children are NOT
// rendered, so a test reads and calls their props (`find`), the way a click
// on that child would. State updates re-render on a microtask and effects
// run after each render, in order, with their deps compared like React's.
import {
  isValidElement,
  type JSXElementConstructor,
  type ReactElement,
  type ReactNode,
} from "react";

type Cleanup = () => void;

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: Cleanup;
  ran: boolean;
}

interface Instance {
  slots: Map<number, StateBox<unknown> | EffectSlot | HookSlot>;
  /** Effects due after the current render. */
  pending: Array<() => void>;
  /** Every effect slot, for the cleanups on unmount. */
  effects: EffectSlot[];
  /** External store subscriptions, made once. */
  subscriptions: Cleanup[];
  rerender: () => void;
  scheduled: boolean;
}

interface StateBox<T> {
  value: T;
  set: (next: T | ((previous: T) => T)) => void;
}

/** What a ref, an id or a subscription keeps. */
interface HookSlot {
  current?: unknown;
  id?: string;
}

const sameDeps = (
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined,
) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** A lazy initial value or an updater: React calls it, so do we. */
const resolve = <T>(value: T | (() => T)): T =>
  value instanceof Function ? value() : value;

const apply = <T>(next: T | ((previous: T) => T), previous: T): T =>
  next instanceof Function ? next(previous) : next;

export interface Mounted<P> {
  /** The element tree the last render returned. */
  output(): ReactNode;
  /** Render again with new props. */
  update(next: P): void;
  unmount(): void;
}

export function createHookHarness() {
  let current: Instance | null = null;
  let index = 0;
  const owner = (): Instance => {
    if (!current) throw new Error("A hook ran outside a harness render");
    return current;
  };
  const next = () => index++;

  const stateSlot = <T>(init: () => T): StateBox<T> => {
    const instance = owner();
    const i = next();
    const found = instance.slots.get(i);
    if (found && "set" in found) {
      // SAFETY: slot i holds the state this same hook call created.
      return found as StateBox<T>;
    }
    const box: StateBox<T> = {
      value: init(),
      set: (update) => {
        const value = apply(update, box.value);
        if (Object.is(value, box.value)) return;
        box.value = value;
        instance.rerender();
      },
    };
    // SAFETY: stored and read back by the same call site, as T.
    instance.slots.set(i, box as StateBox<unknown>);
    return box;
  };

  const hookSlot = (): HookSlot => {
    const instance = owner();
    const i = next();
    const found = instance.slots.get(i);
    if (found && !("set" in found) && !("ran" in found)) return found;
    const created: HookSlot = {};
    instance.slots.set(i, created);
    return created;
  };

  const effect = (run: () => void | Cleanup, deps?: readonly unknown[]) => {
    const instance = owner();
    const i = next();
    let slot = instance.slots.get(i);
    if (!slot || !("ran" in slot)) {
      slot = { ran: false };
      instance.slots.set(i, slot);
      instance.effects.push(slot);
    }
    const s = slot;
    if (s.ran && deps && sameDeps(s.deps, deps)) return;
    instance.pending.push(() => {
      s.cleanup?.();
      const cleanup = run();
      s.cleanup = cleanup instanceof Function ? cleanup : undefined;
      s.deps = deps;
      s.ran = true;
    });
  };

  const hooks = {
    useState<T>(init: T | (() => T)): [T, StateBox<T>["set"]] {
      const box = stateSlot(() => resolve(init));
      return [box.value, box.set];
    },
    useRef<T>(init: T): { current: T } {
      const slot = hookSlot();
      if (!("current" in slot)) slot.current = init;
      // SAFETY: this slot's `current` was set from this call's T.
      return slot as { current: T };
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect: effect,
    useEffectEvent<A extends never[]>(fn: (...args: A) => void) {
      const latest = stateSlot(() => fn);
      latest.value = fn;
      return stateSlot(
        () =>
          (...args: A) =>
            latest.value(...args),
      ).value;
    },
    useSyncExternalStore<T>(
      subscribe: (onChange: () => void) => Cleanup,
      getSnapshot: () => T,
    ): T {
      const instance = owner();
      const slot = hookSlot();
      if (!slot.id) {
        slot.id = "subscribed";
        instance.subscriptions.push(subscribe(() => instance.rerender()));
      }
      return getSnapshot();
    },
    useMemo<T>(fn: () => T): T {
      next();
      return fn();
    },
    useCallback<T>(fn: T): T {
      next();
      return fn;
    },
    useId(): string {
      const slot = hookSlot();
      slot.id ??= `:h${index}:`;
      return slot.id;
    },
  };

  const mounted = new Set<() => void>();

  function mount<P>(component: (props: P) => ReactNode, first: P): Mounted<P> {
    let props = first;
    let tree: ReactNode = null;
    let alive = true;
    const instance: Instance = {
      slots: new Map(),
      pending: [],
      effects: [],
      subscriptions: [],
      scheduled: false,
      rerender: () => {
        if (instance.scheduled || !alive) return;
        instance.scheduled = true;
        queueMicrotask(() => {
          instance.scheduled = false;
          if (alive) render();
        });
      },
    };
    const render = () => {
      const previous = current;
      current = instance;
      index = 0;
      try {
        tree = component(props);
      } finally {
        current = previous;
      }
      for (const run of instance.pending.splice(0)) run();
    };
    const unmount = () => {
      if (!alive) return;
      alive = false;
      mounted.delete(unmount);
      for (const off of instance.subscriptions) off();
      for (const s of instance.effects) s.cleanup?.();
    };
    mounted.add(unmount);
    render();
    return {
      output: () => tree,
      update(nextProps) {
        props = nextProps;
        render();
      },
      unmount,
    };
  }

  /** Unmount everything still mounted (an `afterEach`), so a failed test
   *  leaves no subscriber behind for the next one. */
  const unmountAll = () => {
    for (const unmount of [...mounted]) unmount();
  };

  return { hooks, mount, unmountAll };
}

export type HookHarness = ReturnType<typeof createHookHarness>;

/** React with the harness's hooks in place of its own. */
export function reactWithHarness<R>(real: R, harness: HookHarness) {
  const merged = { ...real, ...harness.hooks };
  return { ...merged, default: merged };
}

/** Let promise chains and queued re-renders run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Every element in `tree`, children and element-valued props alike. */
export function elements(tree: ReactNode): Array<ReactElement<object>> {
  const out: Array<ReactElement<object>> = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isValidElement<object>(node)) return;
    out.push(node);
    for (const value of Object.values(node.props)) walk(value);
  };
  walk(tree);
  return out;
}

/** The first element of `type` in `tree` whose props pass `where`. */
export function find<P>(
  tree: ReactNode,
  type: string | JSXElementConstructor<P>,
  where: (props: P) => boolean = () => true,
): ReactElement<P> | undefined {
  for (const el of elements(tree))
    if (el.type === type && isValidElement<P>(el) && where(el.props)) return el;
  return undefined;
}
