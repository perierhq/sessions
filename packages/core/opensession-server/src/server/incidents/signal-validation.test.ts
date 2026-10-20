import { expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import {
  REDACTED,
  type SignalValidationContext,
  generateHookSecret,
  hookPathFor,
  normalizeSignal,
  redactSecretQuery,
  redactSignal,
  restoreRedactedHeaders,
  restoreRedactedSource,
  restoredSecretFields,
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
  [{ rule: { kind: "missing", cron: "0 0 31 2 *", graceMs: 0 } }, "never runs"],
  [
    {
      maintenance: [
        {
          kind: "once",
          start: "2026-10-20T10:00:00",
          end: "2026-10-20T11:00:00",
        },
      ],
    },
    "offset",
  ],
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
    restoreRedactedHeaders(http.source, {
      kind: "http",
      url: "https://acme.example.test/other",
      headers: { authorization: REDACTED, Accept: "text/plain" },
    }),
  ).toEqual({ headers: { authorization: "Bearer abc", Accept: "text/plain" } });
  expect(generateHookSecret()).toMatch(/^[0-9a-f]{48}$/);
  expect(hookPathFor(http)).toBeUndefined();
});

const storedHttp: Signal["source"] = {
  kind: "http",
  url: "https://acme.example.test/q?api_key=k1&page=2",
  method: "POST",
  body: '{"token":"b1"}',
  headers: { Authorization: "Bearer abc", Accept: "application/json" },
};

test("redacted headers come back only for the same origin", () => {
  const next = (url: string) => ({
    kind: "http" as const,
    url,
    headers: { Authorization: REDACTED, Accept: "text/plain" },
  });
  expect(
    restoreRedactedHeaders(storedHttp, next("https://acme.example.test:443/x")),
  ).toEqual({
    headers: { Authorization: "Bearer abc", Accept: "text/plain" },
  });
  for (const url of [
    "https://evil.example.test/q",
    "http://acme.example.test/q",
    "https://acme.example.test:8443/q",
  ])
    expect(restoreRedactedHeaders(storedHttp, next(url))).toEqual({
      error: "Enter the Authorization value again for the new address",
    });
  expect(
    restoreRedactedHeaders(undefined, next("https://acme.example.test/q")),
  ).toEqual({ error: "Enter the Authorization value again" });
  expect(
    restoreRedactedHeaders(
      { kind: "webhook" },
      next("https://acme.example.test/q"),
    ),
  ).toEqual({ error: "Enter the Authorization value again" });
  expect(
    restoreRedactedHeaders(storedHttp, {
      kind: "http",
      url: "https://acme.example.test/q",
      headers: { Cookie: REDACTED },
    }),
  ).toEqual({ error: "Enter the Cookie value again" });
  // Nothing redacted: any address is fine.
  expect(
    restoreRedactedHeaders(storedHttp, {
      kind: "http",
      url: "https://evil.example.test/q",
      headers: { Authorization: "Bearer new" },
    }),
  ).toEqual({ headers: { Authorization: "Bearer new" } });
});

test("redacted body and URL secrets come back only for the same origin", () => {
  const red = redactSignal({ ...base, source: storedHttp });
  expect(red.source).toEqual({
    kind: "http",
    url: `https://acme.example.test/q?api_key=${REDACTED}&page=2`,
    method: "POST",
    body: REDACTED,
    headers: { Authorization: REDACTED, Accept: "application/json" },
  });
  expect(JSON.stringify(red)).not.toMatch(/k1|b1|Bearer abc/);
  expect(restoreRedactedSource(storedHttp, red.source)).toEqual({
    source: storedHttp,
  });
  expect(
    restoreRedactedSource(storedHttp, {
      ...(red.source as typeof storedHttp),
      url: `https://acme.example.test/q?page=3&api_key=${encodeURIComponent(REDACTED)}`,
    }),
  ).toEqual({
    source: {
      ...storedHttp,
      url: "https://acme.example.test/q?page=3&api_key=k1",
    },
  });
  expect(
    restoreRedactedSource(storedHttp, {
      ...(red.source as typeof storedHttp),
      headers: { Accept: "application/json" },
      url: "https://evil.example.test/q",
    }),
  ).toEqual({ error: "Enter the body again for the new address" });
  expect(
    restoreRedactedSource(storedHttp, {
      kind: "http",
      url: `https://evil.example.test/q?token=${REDACTED}`,
    }),
  ).toEqual({ error: "Enter the token value again for the new address" });
  expect(restoreRedactedSource(storedHttp, { kind: "webhook" })).toEqual({
    source: { kind: "webhook" },
  });
});

test("secret-looking query parameters are redacted, the rest kept byte for byte", () => {
  expect(
    redactSecretQuery(
      "https://acme.example.test/a?q=a%20b&api_key=1&Token=2&sig=3&signature=4&auth=5&key=6&secret=7&access_token=8&monkey=9#f",
    ),
  ).toBe(
    `https://acme.example.test/a?q=a%20b&api_key=${REDACTED}&Token=${REDACTED}&sig=${REDACTED}&signature=${REDACTED}&auth=${REDACTED}&key=${REDACTED}&secret=${REDACTED}&access_token=${REDACTED}&monkey=9#f`,
  );
  expect(redactSecretQuery("https://acme.example.test/a")).toBe(
    "https://acme.example.test/a",
  );
  expect(redactSecretQuery("not a url ?token=1")).toBe(
    `not a url ?token=${REDACTED}`,
  );
});

test.each([
  ["Host", "cannot be set"],
  ["content-length", "cannot be set"],
  ["Transfer-Encoding", "cannot be set"],
  ["Connection", "cannot be set"],
  ["Upgrade", "cannot be set"],
  ["TE", "cannot be set"],
  ["Trailer", "cannot be set"],
  ["Keep-Alive", "cannot be set"],
  ["Proxy-Authorization", "cannot be set"],
  ["Proxy-Connection", "cannot be set"],
])("rejects the header %s", async (name, message) => {
  const out = await validateSignalInput(
    {
      source: {
        kind: "http",
        url: "https://acme.example.test",
        headers: { [name]: "x" },
      },
    },
    ctx(),
  );
  expect(out).toEqual({ error: expect.stringContaining(message) });
});

test("rejects header names that differ only in case", async () => {
  const out = await validateSignalInput(
    {
      source: {
        kind: "http",
        url: "https://acme.example.test",
        headers: { Authorization: "a", authorization: "b" },
      },
    },
    ctx(),
  );
  expect(out).toEqual({ error: 'Header "authorization" is listed twice' });
});

test("a test run restores secrets only for the same method and path", () => {
  const red = redactSignal({ ...base, source: storedHttp }).source;
  const same = { sameRequest: true };
  expect(restoreRedactedSource(storedHttp, red, same)).toEqual({
    source: storedHttp,
  });
  expect(
    restoreRedactedSource(
      storedHttp,
      {
        ...(red as typeof storedHttp),
        url: red.kind === "http" ? red.url.replace("/q?", "/admin?") : "",
      },
      same,
    ),
  ).toEqual({
    error: "Enter the api_key value again to test another method or path",
  });
  expect(
    restoreRedactedSource(
      storedHttp,
      { ...(red as typeof storedHttp), method: "GET", body: undefined },
      same,
    ),
  ).toEqual({
    error: "Enter the api_key value again to test another method or path",
  });
  // A write keeps the origin rule only.
  expect(
    "source" in
      restoreRedactedSource(storedHttp, {
        ...(red as typeof storedHttp),
        method: "GET",
        body: undefined,
      }),
  ).toBe(true);
  expect(restoredSecretFields(red)).toEqual([
    "query.api_key",
    "headers.Authorization",
    "body",
  ]);
  expect(restoredSecretFields(storedHttp)).toEqual([]);
  expect(restoredSecretFields({ kind: "webhook" })).toEqual([]);
});
