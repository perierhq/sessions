import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
let serverPrefs: Record<string, string> = {};
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: {
    addEventListener(type: string, handler: () => void) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, handler: () => void) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of listeners.get(event.type) ?? []) handler();
    },
  },
  Event: class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
  fetch: async (input: string | URL, init?: RequestInit) => {
    if (
      String(input).includes("/ui-prefs") &&
      !init?.method?.match(/put|post/i)
    )
      return new Response(JSON.stringify({ prefs: serverPrefs }), {
        headers: { "content-type": "application/json" },
      });
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  },
});

let pref: typeof import("./live-typing-pref");

beforeAll(async () => {
  pref = await import("./live-typing-pref");
});

beforeEach(() => {
  store.clear();
  // A signed-in viewer, so hydration asks the server for their prefs.
  store.set("opensession-user", "Viewer");
  serverPrefs = {};
});

/** Re-run the server hydration the way a sign-in or user switch does. */
async function hydrate() {
  window.dispatchEvent(new Event("opensession-user-changed"));
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("Live typing preference", () => {
  test("defaults on for anyone who never chose", async () => {
    expect(pref.getLiveTypingPref()).toBe(true);
    await hydrate();
    expect(pref.getLiveTypingPref()).toBe(true);
  });

  test("an explicit off set here stays off", () => {
    pref.setLiveTypingPref(false);
    expect(pref.getLiveTypingPref()).toBe(false);
    expect(store.get("opensession-live-typing")).toBe("off");
  });

  test("an explicit off saved from another device wins over the default", async () => {
    serverPrefs = { "live-typing": "off" };
    let changed = 0;
    const unsubscribe = pref.onLiveTypingChanged(() => changed++);
    await hydrate();
    unsubscribe();
    expect(pref.getLiveTypingPref()).toBe(false);
    expect(changed).toBe(1);
  });
});
