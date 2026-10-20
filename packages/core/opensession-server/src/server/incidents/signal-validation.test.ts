import { expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import {
  REDACTED,
  type SignalValidationContext,
  generateHookSecret,
  hookPathFor,
  mergeRedactedHeaders,
  normalizeSignal,
  redactSignal,
  validateSignalInput,
} from "./signal-validation";

const ctx = (
  over: Partial<SignalValidationContext> = {},
): SignalValidationContext => ({
  projectExists: (id) => id === "acme",
  signalExists: async (id) => id === "sig-other",
  ...over,
});
const base: Signal = {
  id: "sig-1",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test/search" },
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z",
};

test("accepts a full http signal and reports touched fields", async () => {
  const out = await validateSignalInput(
    {
      name: " Search ",
      project: "acme",
      source: {
        kind: "http",
        url: "https://acme.example.test/q",
        headers: { "User-Agent": "acme-app/4.2", Authorization: "Bearer abc" },
        json: { preset: "plain" },
      },
      rule: { kind: "consecutive", failures: 3 },
      dependsOn: ["sig-other"],
      maintenance: [],
      ignored: 1,
    },
    ctx(),
  );
  expect("error" in out).toBe(false);
  if ("error" in out) return;
  expect(out.fields.name).toBe("Search");
  expect([...out.touched].sort()).toEqual([
    "dependsOn",
    "maintenance",
    "name",
    "project",
    "rule",
    "source",
  ]);
});

test.each([
  [{ name: "" }, "Name"],
  [{ project: "globex" }, "project"],
  [{ source: { kind: "http", url: "ftp://acme.example.test" } }, "http"],
  [
    { source: { kind: "http", url: "https://u:p@acme.example.test" } },
    "Put credentials in a header, not the URL",
  ],
  [
    {
      source: {
        kind: "http",
        url: "https://acme.example.test",
        headers: { "X-A": "a\r\nb" },
      },
    },
    "header",
  ],
  [
    {
      source: {
        kind: "http",
        url: "https://acme.example.test",
        expectBody: { regex: "(a+)+$" },
      },
    },
    "regex",
  ],
  [
    {
      rule: { kind: "missing", everyMs: 60_000, cron: "0 3 * * *", graceMs: 0 },
    },
    "one of",
  ],
  [{ rule: { kind: "deadline", warnDays: 3, failDays: 3 } }, "warnDays"],
  [{ dependsOn: ["sig-missing"] }, "sig-missing"],
  [{ dependsOn: ["sig-1"] }, "itself"],
])("rejects %j", async (input, message) => {
  const out = await validateSignalInput(input, ctx({ selfId: "sig-1" }));
  expect(out).toEqual({ error: expect.stringContaining(message) });
});

test("normalize: defaults, compatibility, intervals", () => {
  expect(normalizeSignal({ ...base, rule: undefined as never })).toMatchObject({
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    intervalMs: 60_000,
  });
  expect(
    normalizeSignal({
      ...base,
      source: { kind: "heartbeat" },
      rule: undefined as never,
    }),
  ).toEqual({ error: "A heartbeat needs a schedule" });
  expect(
    normalizeSignal({
      ...base,
      rule: { kind: "deadline", warnDays: 14, failDays: 3 },
    }),
  ).toEqual({ error: expect.stringContaining("does not fit") });
  expect(normalizeSignal({ ...base, intervalMs: 5_000 })).toEqual({
    error: expect.any(String),
  });
  expect(
    normalizeSignal({
      ...base,
      source: { kind: "webhook" },
      rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
      intervalMs: 60_000,
    }),
  ).not.toHaveProperty("intervalMs");
  expect(
    normalizeSignal({ ...base, provider: true, selfReported: true }),
  ).toEqual({ error: expect.any(String) });
  expect(
    normalizeSignal({
      ...base,
      source: {
        kind: "http",
        url: base.source.kind === "http" ? base.source.url : "",
        method: "HEAD",
        json: { preset: "plain" },
      },
    }),
  ).toEqual({ error: expect.any(String) });
});

test("redaction never returns a secret and round-trips", () => {
  const stored: Signal = {
    ...base,
    hookSecret: "f".repeat(48),
    source: { kind: "webhook" },
  };
  expect(redactSignal(stored)).not.toHaveProperty("hookSecret");
  expect(redactSignal(stored).hookPath).toBe(
    `/incident-hooks/sig-1/${"f".repeat(48)}`,
  );
  const http: Signal = {
    ...base,
    source: {
      kind: "http",
      url: "https://acme.example.test",
      headers: {
        Authorization: "Bearer abc",
        "X-Acme-Token": "t",
        Accept: "application/json",
      },
    },
  };
  const red = redactSignal(http);
  expect(JSON.stringify(red)).not.toContain("Bearer abc");
  expect(red.source.kind === "http" && red.source.headers).toEqual({
    Authorization: REDACTED,
    "X-Acme-Token": REDACTED,
    Accept: "application/json",
  });
  expect(
    mergeRedactedHeaders(
      { authorization: REDACTED, Accept: "text/plain", Cookie: REDACTED },
      { Authorization: "Bearer abc" },
    ),
  ).toEqual({ authorization: "Bearer abc", Accept: "text/plain" });
  expect(generateHookSecret()).toMatch(/^[0-9a-f]{48}$/);
  expect(hookPathFor(http)).toBeUndefined();
});
