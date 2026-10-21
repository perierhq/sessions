import { expect, test } from "bun:test";
import type { SignalView } from "../../../shared/incidents";
import {
  defaultDraft,
  draftFromSignal,
  draftToInput,
  hookUrl,
  intervalLabel,
  intervalOptions,
  REDACTED,
  type SignalDraft,
  switchKind,
} from "./signal-form";

/** A stored signal with only the fields a test sets. */
function view(fields: Partial<SignalView>): SignalView {
  // SAFETY: the form reads only the signal fields each test passes.
  return fields as SignalView;
}

test("defaults per kind", () => {
  expect(defaultDraft("http", "acme")).toMatchObject({
    method: "GET",
    intervalMs: 60_000,
    timeoutMs: 10_000,
    rule: { kind: "consecutive", failures: 3, recoveries: 2 },
    severity: "major",
    enabled: true,
  });
  expect(defaultDraft("webhook", "acme").rule).toEqual({
    kind: "rate",
    windowMs: 300_000,
    atLeast: 5,
  });
  expect(defaultDraft("heartbeat", "acme")).toMatchObject({
    schedule: "every",
    everyMs: 3_600_000,
    graceMs: 600_000,
  });
  expect(defaultDraft("expiry", "acme")).toMatchObject({
    port: "443",
    intervalMs: 21_600_000,
    rule: { kind: "deadline", warnDays: 14, failDays: 3 },
  });
});

test("round trip keeps redacted headers and drops empty rows", () => {
  const signal = view({
    id: "sig-a",
    name: "Search",
    project: "acme",
    enabled: true,
    severity: "major",
    rule: { kind: "consecutive", failures: 3 },
    intervalMs: 60_000,
    source: {
      kind: "http",
      url: "https://acme.example.test/q",
      headers: { Authorization: REDACTED, Accept: "application/json" },
    },
  });
  const d = draftFromSignal(signal);
  expect(d.headers[0]).toMatchObject({ name: "Authorization", hidden: true });
  const out = draftToInput({
    ...d,
    headers: [...d.headers, { name: "", value: "" }],
  });
  expect("input" in out && out.input.source).toEqual({
    kind: "http",
    url: "https://acme.example.test/q",
    method: "GET",
    headers: { Authorization: REDACTED, Accept: "application/json" },
    timeoutMs: 10_000,
  });
});

test("a typed value replaces a hidden header", () => {
  const d = {
    ...defaultDraft("http", "acme"),
    name: "x",
    url: "https://acme.example.test",
    headers: [{ name: "Authorization", value: "Bearer new", hidden: true }],
  };
  const out = draftToInput(d);
  expect("input" in out && out.input.source).toMatchObject({
    headers: { Authorization: "Bearer new" },
  });
});

test("http checks carry their expectations", () => {
  const out = draftToInput({
    ...defaultDraft("http", "acme"),
    name: "Search",
    url: " https://acme.example.test/q ",
    method: "POST",
    body: '{"q":"x"}',
    expectStatus: "200, 204",
    contains: "ok",
    regex: "",
  });
  expect(out).toMatchObject({
    input: {
      name: "Search",
      project: "acme",
      intervalMs: 60_000,
      rule: { kind: "consecutive", failures: 3, recoveries: 2 },
      source: {
        url: "https://acme.example.test/q",
        method: "POST",
        body: '{"q":"x"}',
        expectStatus: [200, 204],
        expectBody: { contains: "ok" },
      },
      dependsOn: [],
      maintenance: [],
      runOn: "",
      provider: false,
      selfReported: false,
    },
  });
});

test("heartbeat schedules", () => {
  const d = {
    ...defaultDraft("heartbeat", "acme"),
    name: "Nightly",
    schedule: "cron" as const,
    cron: "0 3 * * *",
    graceMs: 1_800_000,
  };
  expect(draftToInput(d)).toMatchObject({
    input: {
      source: { kind: "heartbeat" },
      rule: { kind: "missing", cron: "0 3 * * *", graceMs: 1_800_000 },
    },
  });
  expect(draftToInput({ ...d, cron: " " })).toEqual({
    field: "cron",
    error: "Enter a cron schedule",
  });
  const every = draftToInput({ ...d, schedule: "every" });
  expect(every).toMatchObject({
    input: { rule: { kind: "missing", everyMs: 3_600_000 } },
  });
  expect("input" in every && every.input.intervalMs).toBeUndefined();
});

test("expiry checks", () => {
  const d = {
    ...defaultDraft("expiry", "acme"),
    name: "Certificate",
    host: "acme.example.test",
  };
  expect(draftToInput(d)).toMatchObject({
    input: {
      source: {
        kind: "expiry",
        target: "tls",
        host: "acme.example.test",
        port: 443,
      },
      intervalMs: 21_600_000,
    },
  });
  expect(draftToInput({ ...d, host: "" })).toMatchObject({ field: "host" });
  expect(draftToInput({ ...d, port: "70000" })).toMatchObject({
    field: "port",
  });
});

test.each([
  [{ name: "" }, "name"],
  [{ name: "x", url: "ftp://acme.example.test" }, "url"],
  [
    {
      name: "x",
      url: "https://acme.example.test",
      headers: [{ name: "Bad Header", value: "1" }],
    },
    "headers",
  ],
  [
    { name: "x", url: "https://acme.example.test", expectStatus: "200, 7000" },
    "expectStatus",
  ],
])("rejects %j", (patch, field) => {
  // SAFETY: each patch sets only fields of SignalDraft.
  const draft = { ...defaultDraft("http", "acme"), ...patch } as SignalDraft;
  expect(draftToInput(draft)).toMatchObject({ field });
});

test("impact source drafts", () => {
  const d = {
    ...defaultDraft("http", "acme"),
    name: "Search",
    url: "https://acme.example.test/q",
    impact: {
      kind: "http" as const,
      url: "https://logs.example.test/c?since={{since}}",
      headers: [],
      countPath: "$.failed",
      peoplePath: "$.users",
      count: "fail-events" as const,
      noun: "searches failed",
      label: "the request log",
    },
  };
  expect(draftToInput(d)).toMatchObject({
    input: {
      impact: {
        kind: "http",
        url: "https://logs.example.test/c?since={{since}}",
        countPath: "$.failed",
        peoplePath: "$.users",
        noun: "searches failed",
        label: "the request log",
      },
    },
  });
  expect(draftToInput({ ...d, impact: { ...d.impact, noun: " " } })).toEqual({
    field: "impactNoun",
    error: "Say what the number counts, like searches failed",
  });
  expect(draftToInput({ ...d, impact: { ...d.impact, label: "" } })).toEqual({
    field: "impactLabel",
    error: "Name where it is counted, like the request log",
  });
  expect(
    draftToInput({ ...d, impact: { ...d.impact, countPath: "" } }),
  ).toMatchObject({ field: "impactCountPath" });
  expect(
    draftToInput({ ...d, impact: { ...d.impact, kind: "none" } }),
  ).toMatchObject({ input: { impact: null } });
  const events = draftToInput({
    ...defaultDraft("webhook", "acme"),
    name: "Errors",
    impact: { ...d.impact, kind: "events", count: "value-sum" },
  });
  expect("input" in events && events.input.impact).toEqual({
    kind: "events",
    count: "value-sum",
    noun: "searches failed",
    label: "the request log",
  });
});

test("an impact read back from a signal round-trips", () => {
  const d = draftFromSignal(
    view({
      id: "sig-a",
      name: "Search",
      project: "acme",
      enabled: true,
      severity: "major",
      rule: { kind: "consecutive", failures: 3 },
      source: { kind: "http", url: "https://acme.example.test/q" },
      impact: {
        kind: "http",
        url: "https://logs.example.test/c",
        headers: { Authorization: REDACTED },
        countPath: "$.n",
        noun: "searches failed",
        label: "the request log",
      },
    }),
  );
  const out = draftToInput(d);
  expect("input" in out && out.input.impact).toEqual({
    kind: "http",
    url: "https://logs.example.test/c",
    headers: { Authorization: REDACTED },
    countPath: "$.n",
    noun: "searches failed",
    label: "the request log",
  });
});

test("switching kind keeps the basics", () => {
  const d = switchKind(
    {
      ...defaultDraft("http", "acme"),
      name: "Search",
      severity: "critical",
      dependsOn: ["sig-b"],
    },
    "expiry",
  );
  expect(d).toMatchObject({
    kind: "expiry",
    name: "Search",
    severity: "critical",
    dependsOn: ["sig-b"],
    rule: { kind: "deadline" },
  });
});

test("hook URLs", () => {
  expect(hookUrl("/incident-hooks/sig-a/s3cret")).toEndWith(
    "/incident-hooks/sig-a/s3cret",
  );
  expect(hookUrl("/incident-hooks/sig-a/s3cret")).toStartWith("http");
});

test("interval labels", () => {
  expect(
    [30_000, 60_000, 120_000, 3_600_000, 86_400_000, 604_800_000].map(
      intervalLabel,
    ),
  ).toEqual(["30 s", "1 min", "2 min", "1 h", "1 day", "7 days"]);
  expect(intervalOptions([60_000], 90_000_000).map((o) => o.value)).toEqual([
    "60000",
    "90000000",
  ]);
});

test("a bad maintenance window stops the save before the server does", () => {
  const d = {
    ...defaultDraft("heartbeat", "acme"),
    name: "Nightly",
    maintenance: [
      {
        kind: "weekly" as const,
        days: [],
        start: "02:00",
        end: "03:00",
        timeZone: "UTC",
      },
    ],
  };
  expect(draftToInput(d)).toMatchObject({ field: "maintenance" });
});
