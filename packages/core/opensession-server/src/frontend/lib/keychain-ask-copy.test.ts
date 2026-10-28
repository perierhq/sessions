import { expect, test } from "bun:test";
import { askChoices, askCeilings } from "./keychain-ask-copy";
import type { SessionKeychainAsk } from "./keychain-ask-store";

const ask = (
  over: Partial<SessionKeychainAsk> = {},
  credential: Partial<SessionKeychainAsk["credentials"][number]> = {},
): SessionKeychainAsk => ({
  id: "ka-1",
  requestedBy: "Sam",
  purpose: "count open orders",
  requestedMode: "standing",
  credentials: [
    {
      service: "acme-orders",
      host: "api.example.test",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/v1/orders"],
      ...credential,
    },
  ],
  createdAt: "2026-10-28T10:00:00.000Z",
  ...over,
});

test("each credential's ceiling, and whether it is open", () => {
  expect(askCeilings(ask())).toEqual([
    { text: "GET · /v1/orders", open: false },
  ]);
  expect(
    askCeilings(ask({}, { allowedMethods: [], allowedPathPrefixes: [] })),
  ).toEqual([{ text: "Any method, any path", open: true }]);
  // A login has no ceiling to show: it is released, not called.
  expect(
    askCeilings(ask({ requestedMode: "release" }, { kind: "login" })),
  ).toEqual([]);
});

test("the asked-for mode is primary, except once wins on an open credential", () => {
  const labels = (a: SessionKeychainAsk) =>
    askChoices(a).map((c) => `${c.label}${c.primary ? "*" : ""}`);
  expect(labels(ask())).toEqual(["Allow once", "Allow 7 days*"]);
  expect(labels(ask({ requestedMode: "once" }))).toEqual([
    "Allow 7 days",
    "Allow once*",
  ]);
  expect(
    labels(ask({}, { allowedMethods: [], allowedPathPrefixes: [] })),
  ).toEqual(["Allow 7 days", "Allow once*"]);
  expect(labels(ask({ requestedMode: "release" }, { kind: "login" }))).toEqual([
    "Release password*",
  ]);
  expect(
    labels(ask({ requestedMode: "run", run: { command: "x", maxCalls: 5 } })),
  ).toEqual(["Allow run*"]);
});

test("each choice says what it permits", () => {
  const [once, standing] = askChoices(ask({ requestedMode: "standing" }));
  expect(once!.terms).toBe("One call, within the next hour");
  expect(standing!.terms).toBe("Any number of calls for 7 days");
});
