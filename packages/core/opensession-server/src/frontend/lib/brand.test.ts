import { describe, expect, test } from "bun:test";
import { PRODUCT_NAME, sessionSourceLabel } from "./brand";

describe("sessionSourceLabel", () => {
  test("shows the product's own UI under the product name", () => {
    expect(sessionSourceLabel("opensession")).toBe(PRODUCT_NAME.toLowerCase());
  });

  test("still recognises the pre-rename id for 'started here'", () => {
    // `backstage` leaked into the archived list as a literal chip; older
    // servers and archived sessions still send it.
    expect(sessionSourceLabel("backstage")).toBe(PRODUCT_NAME.toLowerCase());
  });

  test("leaves every other origin alone", () => {
    for (const source of ["slack", "linear", "cli", "plain"]) {
      expect(sessionSourceLabel(source)).toBe(source);
    }
  });
});

describe("agentInProse", () => {
  test("an instance without a persona says the agent", async () => {
    const { agentInProse } = await import("./brand");
    expect(agentInProse()).toBe("the agent");
    expect(agentInProse({ start: true })).toBe("The agent");
  });

  test("a named persona is used as is; the unnamed default is not", async () => {
    const load = async (personaName: string, key: string) => {
      // SAFETY: tests run without a DOM; `window` is only read by brand.ts
      // at import time, and restored below.
      const scope = globalThis as { window?: unknown };
      const before = scope.window;
      scope.window = { __OPENSESSION_INSTANCE__: { personaName } };
      try {
        // SAFETY: the same module, loaded again under another specifier so
        // its import-time constants read this window.
        return (await import(`./brand.ts?${key}`)) as typeof import("./brand");
      } finally {
        scope.window = before;
      }
    };
    const named = await load("Pat", "named");
    expect(named.agentInProse()).toBe("Pat");
    expect(named.agentInProse({ start: true })).toBe("Pat");
    const unnamed = await load("Assistant", "unnamed");
    expect(unnamed.agentInProse({ start: true })).toBe("The agent");
  });
});
