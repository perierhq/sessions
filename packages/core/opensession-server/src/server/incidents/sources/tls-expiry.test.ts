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

const trusted = { validTo: "Nov 30 10:00:00 2026 GMT", authorized: true };

test("an address that fails falls through to the next one", async () => {
  const tried: string[] = [];
  const run = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test" },
    {
      now: () => NOW,
      resolve: async () => ["2001:db8::7", "203.0.113.7"],
      probe: async (address, servername) => {
        tried.push(`${address} ${servername}`);
        if (address.includes(":")) throw new Error("EHOSTUNREACH");
        return trusted;
      },
    },
  );
  expect(tried).toEqual([
    "2001:db8::7 acme.example.test",
    "203.0.113.7 acme.example.test",
  ]);
  expect(run.observations[0]).toMatchObject({ result: "ok", value: 41 });
});

test("an IP literal is probed without a server name", async () => {
  let name: string | undefined = "unset";
  await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "203.0.113.7" },
    {
      now: () => NOW,
      resolve: async () => ["203.0.113.7"],
      probe: async (_address, servername) => {
        name = servername;
        return trusted;
      },
    },
  );
  expect(name).toBeUndefined();
});

test("one deadline covers every address", async () => {
  let clock = NOW;
  const budgets: number[] = [];
  const run = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test" },
    {
      now: () => clock,
      resolve: async () => ["203.0.113.7", "203.0.113.8", "203.0.113.9"],
      probe: async (_address, _name, _port, timeoutMs) => {
        budgets.push(timeoutMs);
        clock += 6_000;
        throw new Error("timed out");
      },
    },
  );
  expect(budgets).toEqual([10_000, 4_000]);
  expect(run.observations[0]).toMatchObject({
    result: "fail",
    detail: "Could not reach acme.example.test: timed out",
  });
});

test("a resolver that never answers is cut off by the deadline", async () => {
  const run = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test" },
    {
      now: () => NOW,
      timeoutMs: 20,
      resolve: () => new Promise(() => {}),
    },
  );
  expect(run.observations[0]).toMatchObject({
    result: "fail",
    detail: "Could not reach acme.example.test: no answer within 20 ms",
  });
});

test("DNS rebinding: only the addresses checked once are probed", async () => {
  const answers = [["203.0.113.7"], ["10.0.0.5"]];
  let calls = 0;
  const probed: string[] = [];
  const run = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "acme.example.test" },
    {
      now: () => NOW,
      resolve: async () => answers[Math.min(calls++, answers.length - 1)]!,
      probe: async (address) => {
        probed.push(address);
        return trusted;
      },
    },
  );
  expect(run.observations[0]).toMatchObject({ result: "ok", value: 41 });
  expect(calls).toBe(1);
  expect(probed).toEqual(["203.0.113.7"]);
});

test("an IPv4-mapped IPv6 answer for a private address is refused", async () => {
  for (const answer of [
    "::ffff:10.0.0.5",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
  ]) {
    let probed = false;
    const run = await runTlsExpirySource(
      { kind: "expiry", target: "tls", host: "acme.example.test" },
      {
        now: () => NOW,
        resolve: async () => ["203.0.113.7", answer],
        probe: async () => {
          probed = true;
          return trusted;
        },
      },
    );
    expect(run.observations[0]).toMatchObject({
      result: "unknown",
      detail: `Refused: acme.example.test resolves to the private address ${answer}`,
    });
    expect(probed).toBe(false);
  }
});

test("a reserved private name is refused without resolving", async () => {
  let resolved = false;
  const run = await runTlsExpirySource(
    { kind: "expiry", target: "tls", host: "db.internal" },
    {
      now: () => NOW,
      resolve: async () => {
        resolved = true;
        return ["203.0.113.7"];
      },
    },
  );
  expect(run.observations[0]).toMatchObject({
    result: "unknown",
    detail: "Refused: db.internal is a private name",
  });
  expect(resolved).toBe(false);
});
