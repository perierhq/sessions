import { expect, test } from "bun:test";
import { runTlsExpirySource, tlsObservation } from "./tls-expiry";

const NOW = Date.parse("2026-10-20T10:00:00Z");

test("days left, trusted and rejected", () => {
  expect(
    tlsObservation(
      { validTo: "Nov 30 10:00:00 2026 GMT", authorized: true },
      "acme.example.test",
      443,
      NOW,
    ),
  ).toEqual({
    at: "2026-10-20T10:00:00.000Z",
    result: "ok",
    value: 41,
    sourceUrl: "tls://acme.example.test:443",
    detail: "Certificate expires 2026-11-30 (41 days)",
  });
  expect(
    tlsObservation(
      {
        validTo: "Oct 18 10:00:00 2026 GMT",
        authorized: false,
        authorizationError: "CERT_HAS_EXPIRED",
      },
      "acme.example.test",
      443,
      NOW,
    ),
  ).toMatchObject({
    result: "fail",
    value: -2,
    detail: "Certificate rejected: CERT_HAS_EXPIRED",
  });
});

test("private addresses are refused before any connection", async () => {
  let probed = false;
  const run = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test" },
    {
      now: () => NOW,
      resolve: async () => ["10.0.0.5"],
      probe: async () => {
        probed = true;
        throw new Error("no");
      },
    },
  );
  expect(run.observations[0]).toMatchObject({
    result: "unknown",
    detail:
      "Refused: acme.example.test resolves to the private address 10.0.0.5",
  });
  expect(probed).toBe(false);
});

test("probe and resolve failures are failures", async () => {
  const fails = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test", port: 8443 },
    {
      now: () => NOW,
      resolve: async () => ["203.0.113.7"],
      probe: async () => {
        throw new Error("timed out");
      },
    },
  );
  expect(fails.observations[0]).toMatchObject({
    result: "fail",
    detail: "Could not reach acme.example.test: timed out",
  });
  const unresolved = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test" },
    {
      now: () => NOW,
      resolve: async () => {
        throw new Error("getaddrinfo ENOTFOUND acme.example.test");
      },
    },
  );
  expect(unresolved.observations[0]).toMatchObject({
    result: "fail",
    detail:
      "Could not reach acme.example.test: getaddrinfo ENOTFOUND acme.example.test",
  });
  const ok = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test" },
    {
      now: () => NOW,
      resolve: async () => ["203.0.113.7"],
      probe: async () => ({
        validTo: "Nov 30 10:00:00 2026 GMT",
        authorized: true,
      }),
    },
  );
  expect(ok.observations[0].value).toBe(41);
});
