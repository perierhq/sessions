import { expect, test } from "bun:test";
import type { CandidateCheck } from "../../../shared/incident-response";
import type { Signal } from "../../../shared/incidents";
import type { SourceRun } from "../sources";
import { PROOF_SAMPLES, PROOF_SPACING_MS, runProof } from "./proof";

const http: Signal = {
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  runOn: "runner-prod",
  source: {
    kind: "http",
    url: "https://acme.example.test/search?q=x",
    headers: { Authorization: "Bearer s3cret" },
  },
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: "x",
  updatedAt: "x",
};
const obs = (result: "ok" | "fail" | "unknown"): SourceRun => ({
  observations: [{ at: "t", result, detail: result }],
});
const fake = (results: Array<"ok" | "fail" | "unknown">) => {
  const seen: Signal[] = [];
  const sleeps: number[] = [];
  let i = 0;
  return {
    seen,
    sleeps,
    deps: {
      runSource: async (s: Signal) => {
        seen.push(s);
        return obs(results[i++]!);
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => 0,
    },
  };
};
const request = (
  url: string,
  headers: Record<string, string> = {},
  method?: "GET" | "HEAD" | "POST",
): CandidateCheck => ({
  kind: "request",
  source: { kind: "http", url, headers, ...(method ? { method } : {}) },
});

test("baseline fails, candidate passes, from the same Runner with the stored secret", async () => {
  const { seen, sleeps, deps } = fake(["fail", "fail", "ok", "ok", "ok", "ok"]);
  const p = await runProof(
    {
      signal: http,
      evaluation: null,
      recent: [],
      round: 1,
      check: request("https://acme.example.test/search?q=x", {
        Authorization: "[redacted]",
        "User-Agent": "acme-app/4.2",
      }),
    },
    deps,
  );
  expect(p).toMatchObject({
    round: 1,
    at: new Date(0).toISOString(),
    runner: "runner-prod",
    baseline: { verdict: "fails" },
    candidate: { kind: "request", verdict: "passes" },
  });
  expect(p.baseline.samples).toEqual([
    { at: "t", result: "fail", detail: "fail" },
    { at: "t", result: "fail", detail: "fail" },
    { at: "t", result: "ok", detail: "ok" },
  ]);
  expect(seen).toHaveLength(6);
  expect(seen[0]).toBe(http);
  expect(seen[3]).toMatchObject({
    runOn: "runner-prod",
    source: {
      headers: {
        Authorization: "Bearer s3cret",
        "User-Agent": "acme-app/4.2",
      },
    },
  });
  // Spaced within each set, not after the last sample.
  expect(sleeps).toEqual(Array(4).fill(PROOF_SPACING_MS));
  expect(PROOF_SAMPLES).toBe(3);
});

test("an agent cannot aim the production Runner elsewhere", async () => {
  const { seen, deps } = fake(["fail", "fail", "fail"]);
  const p = await runProof(
    {
      signal: http,
      evaluation: null,
      recent: [],
      round: 1,
      check: request("http://127.0.0.1:9000/admin"),
    },
    deps,
  );
  expect(p.candidate).toEqual({
    kind: "request",
    samples: [],
    verdict: "unclear",
    refused: "The candidate check leaves the signal's origin",
  });
  expect(seen).toHaveLength(3);

  const post = await runProof(
    {
      signal: http,
      evaluation: null,
      recent: [],
      round: 1,
      check: request("https://acme.example.test/admin", {}, "POST"),
    },
    fake(["fail", "fail", "fail"]).deps,
  );
  expect(post.candidate.refused).toBe(
    "A request check must use GET or HEAD unless the signal sends that method to that path",
  );

  const redacted = await runProof(
    {
      signal: http,
      evaluation: null,
      recent: [],
      round: 1,
      check: request("https://acme.example.test/q", { Cookie: "[redacted]" }),
    },
    fake(["fail", "fail", "fail"]).deps,
  );
  expect(redacted.candidate).toEqual({
    kind: "request",
    samples: [],
    verdict: "unclear",
    refused: "Enter the Cookie value again",
  });
});

test("unclear and flaky outcomes, and after-deploy", async () => {
  expect(
    await runProof(
      {
        signal: http,
        evaluation: null,
        recent: [],
        round: 1,
        check: request("https://acme.example.test/q"),
      },
      fake(["fail", "unknown", "ok", "ok", "fail", "ok"]).deps,
    ),
  ).toMatchObject({
    baseline: { verdict: "unclear" },
    candidate: { verdict: "fails" },
  });
  expect(
    (
      await runProof(
        {
          signal: http,
          evaluation: null,
          recent: [],
          round: 1,
          check: request("https://acme.example.test/q"),
        },
        fake(["ok", "ok", "fail", "ok", "unknown", "ok"]).deps,
      )
    ).candidate.verdict,
  ).toBe("unclear");
  expect(
    (
      await runProof(
        {
          signal: http,
          evaluation: null,
          recent: [],
          round: 1,
          check: { kind: "after-deploy", reason: "Code fix" },
        },
        fake(["fail", "fail", "fail"]).deps,
      )
    ).candidate,
  ).toEqual({ kind: "after-deploy", samples: [], verdict: "after-deploy" });
});

test("a failed or empty run is an unknown sample, never a throw", async () => {
  let i = 0;
  const p = await runProof(
    {
      signal: http,
      evaluation: null,
      recent: [],
      round: 2,
      check: { kind: "after-deploy", reason: "Code fix" },
    },
    {
      runSource: async () => {
        i++;
        if (i === 1) throw new Error("Runner offline");
        if (i === 2) return { observations: [] };
        return {
          observations: [
            { at: "a", result: "ok", detail: "lane", lane: "db" },
            { at: "b", result: "fail", detail: "main" },
          ],
        };
      },
      sleep: async () => {},
      now: () => 5,
    },
  );
  expect(p.baseline).toEqual({
    verdict: "unclear",
    samples: [
      {
        at: new Date(5).toISOString(),
        result: "unknown",
        detail: "Runner offline",
      },
      {
        at: new Date(5).toISOString(),
        result: "unknown",
        detail: "No observation",
      },
      { at: "b", result: "fail", detail: "main" },
    ],
  });
});

test("pushed signals prove the baseline from their evaluation", async () => {
  const hook: Signal = {
    ...http,
    runOn: undefined,
    source: { kind: "webhook" },
    rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
  };
  const p = await runProof(
    {
      signal: hook,
      evaluation: {
        signalId: "sig-a",
        state: "failing",
        since: "x",
        at: "x",
        reason: "5 failures in 5 min",
        inMaintenance: false,
      },
      recent: [{ at: "1", result: "fail", detail: "TypeError" }],
      round: 1,
      check: { kind: "after-deploy", reason: "Code fix" },
    },
    fake([]).deps,
  );
  expect(p.baseline).toEqual({
    verdict: "fails",
    samples: [{ at: "1", result: "fail", detail: "TypeError" }],
  });
  expect(p.runner).toBeUndefined();
  const recent = await runProof(
    {
      signal: hook,
      evaluation: {
        signalId: "sig-a",
        state: "ok",
        since: "x",
        at: "x",
        reason: "",
        inMaintenance: false,
      },
      recent: [
        { at: "1", result: "fail", detail: "a" },
        { at: "2", result: "ok", detail: "b", lane: "db" },
        { at: "3", result: "ok", detail: "c" },
        { at: "4", result: "ok", detail: "d" },
        { at: "5", result: "ok", detail: "e" },
      ],
      round: 1,
      check: { kind: "after-deploy", reason: "Code fix" },
    },
    fake([]).deps,
  );
  expect(recent.baseline.verdict).toBe("passes");
  expect(recent.baseline.samples.map((s) => s.at)).toEqual(["3", "4", "5"]);
  const runOn = await runProof(
    {
      signal: hook,
      evaluation: null,
      recent: [],
      round: 1,
      check: request("https://acme.example.test"),
    },
    fake([]).deps,
  );
  expect(runOn.baseline.verdict).toBe("unclear");
  expect(runOn.candidate.refused).toBe("A request check needs an http signal");
});
