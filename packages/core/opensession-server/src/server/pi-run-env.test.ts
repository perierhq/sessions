// piCliPoolEnv: the run's Claude workers (deepsec) follow Claude's route.
import { expect, spyOn, test } from "bun:test";
import { piCliPoolEnv } from "./pi-run-env";

const KEY = "sk-ms-test-secret-value-1234";
const opts = { claudeCliEnv: true, journal: { kind: "prompt" } } as any;

test("while Claude is routed through Mainspring, the workers go there too", () => {
  const env = piCliPoolEnv({
    opts,
    remote: undefined,
    accountUser: undefined,
    runKey: "run-1",
    claudeRoute: {
      kind: "mainspring",
      target: {
        baseUrl: "https://mainspring.example.test",
        key: KEY,
        sessionId: "session-1",
      },
      fallbackDirect: false,
    },
  });
  expect(env).toMatchObject({
    ANTHROPIC_BASE_URL: "https://mainspring.example.test",
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_CUSTOM_HEADERS: "X-Session-ID: session-1",
  });
  expect(env.CLAUDE_CONFIG_DIR).toEndWith("/cli/claude/mainspring");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("a Sandbox run never gets the key", () => {
  const env = piCliPoolEnv({
    opts,
    remote: {} as any,
    accountUser: undefined,
    runKey: "run-1",
    claudeRoute: {
      kind: "mainspring",
      target: {
        baseUrl: "https://mainspring.example.test",
        key: KEY,
        sessionId: "s",
      },
      fallbackDirect: false,
    },
  });
  expect(env).toEqual({});
});

test("a route Mainspring can't serve gives the workers nothing, not a local account", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const env = piCliPoolEnv({
      opts,
      remote: undefined,
      accountUser: undefined,
      runKey: "run-1",
      claudeRoute: { kind: "error", message: "no usable key" },
    });
    expect(env).toEqual({});
  } finally {
    warn.mockRestore();
  }
});
