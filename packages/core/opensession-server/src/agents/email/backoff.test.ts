import { describe, expect, test } from "bun:test";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS } from "../../shared/support";
import {
  MAIL_HOST_REFUSED,
  MailHostRefusedError,
} from "../../server/support/mail-host";
import { PAUSE_COPY, classifyImapError, nextBackoffMs } from "./backoff";

describe("nextBackoffMs", () => {
  test("starts at the minimum", () => {
    expect(nextBackoffMs(0, () => 1)).toBe(30_000);
  });

  test("caps at the maximum", () => {
    expect(nextBackoffMs(10, () => 1)).toBe(900_000);
    expect(nextBackoffMs(1000, () => 1)).toBe(BACKOFF_MAX_MS);
  });

  test("never goes below the minimum", () => {
    expect(nextBackoffMs(3, () => 0)).toBe(30_000);
    expect(nextBackoffMs(0, () => 0)).toBe(BACKOFF_MIN_MS);
  });

  test("full jitter scales the window", () => {
    expect(nextBackoffMs(3, () => 0.5)).toBe(120_000);
  });

  test("honours a longer server hint", () => {
    expect(nextBackoffMs(0, () => 1, 120_000)).toBe(120_000);
    expect(nextBackoffMs(5, () => 1, 1_000)).toBe(900_000);
  });
});

describe("classifyImapError", () => {
  test("authentication failure", () => {
    expect(classifyImapError({ authenticationFailed: true }).kind).toBe("auth");
  });

  test("throttled response text", () => {
    expect(
      classifyImapError({ responseText: "[THROTTLED] slow down" }).kind,
    ).toBe("throttled");
  });

  test("throttle hint", () => {
    expect(classifyImapError({ throttleReset: 92415 })).toEqual({
      kind: "throttled",
      message: expect.any(String),
      retryAfterMs: 92415,
    });
  });

  test("throttled login is not an auth failure", () => {
    expect(
      classifyImapError({
        authenticationFailed: true,
        serverResponseCode: "THROTTLED",
        responseText: "Too many requests",
      }).kind,
    ).toBe("throttled");
  });

  test("too many connections", () => {
    expect(
      classifyImapError({
        responseText: "Too many simultaneous connections",
      }).kind,
    ).toBe("too-many-connections");
    expect(
      classifyImapError({
        authenticationFailed: true,
        responseText: "[UNAVAILABLE] Too many connections",
      }).kind,
    ).toBe("too-many-connections");
  });

  test("a refused login with an ALERT is an auth failure", () => {
    expect(
      classifyImapError({
        responseStatus: "NO",
        authenticationFailed: true,
        serverResponseCode: "ALERT",
        response: "Application-specific password required",
      }).kind,
    ).toBe("auth");
    expect(
      classifyImapError({
        responseStatus: "NO",
        serverResponseCode: "ALERT",
        response: "Application-specific password required",
      }).kind,
    ).toBe("auth");
    expect(
      classifyImapError({
        responseStatus: "NO",
        serverResponseCode: "ALERT",
        response: "Too many simultaneous connections",
      }).kind,
    ).toBe("too-many-connections");
    expect(
      classifyImapError({
        responseStatus: "NO",
        serverResponseCode: "ALERT",
        response: "[THROTTLED] slow down",
      }).kind,
    ).toBe("throttled");
  });

  test("an unavailable or broken server on LOGIN is not an auth failure", () => {
    for (const code of ["UNAVAILABLE", "SERVERBUG"])
      expect(
        classifyImapError({
          responseStatus: "NO",
          authenticationFailed: true,
          serverResponseCode: code,
          response: "Try again later",
        }).kind,
      ).toBe("network");
    expect(
      classifyImapError({
        authenticationFailed: true,
        responseText: "[UNAVAILABLE] Backend down",
      }).kind,
    ).toBe("network");
  });

  test("network errors", () => {
    expect(classifyImapError({ code: "ECONNREFUSED" }).kind).toBe("network");
    expect(classifyImapError({ code: "ETIMEOUT" }).kind).toBe("network");
    expect(classifyImapError({ code: "NoConnection" }).kind).toBe("network");
  });

  test("anything else is a protocol problem", () => {
    expect(classifyImapError(new Error("odd")).kind).toBe("protocol");
    expect(classifyImapError(undefined).kind).toBe("protocol");
  });

  test("the message never carries the password", () => {
    const result = classifyImapError({
      authenticationFailed: true,
      responseText: "Invalid credentials",
      executedCommand: 'A1 LOGIN "user" "secret-pass"',
    });
    expect(result.message).not.toContain("secret-pass");
  });

  test("a refused server address is its own kind, with the generic copy", () => {
    expect(classifyImapError(new MailHostRefusedError())).toEqual({
      kind: "address",
      message: MAIL_HOST_REFUSED,
    });
  });

  test("required STARTTLS not offered, or a refused certificate, is a TLS failure", () => {
    for (const err of [
      Object.assign(new Error("Server does not support STARTTLS"), {
        tlsFailed: true,
      }),
      Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
      Object.assign(new Error("Hostname/IP does not match"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
    ])
      expect(classifyImapError(err)).toEqual({
        kind: "tls",
        message: PAUSE_COPY.tls,
      });
  });

  test("every kind has copy", () => {
    for (const kind of [
      "auth",
      "throttled",
      "too-many-connections",
      "alert",
      "network",
      "protocol",
      "address",
      "tls",
    ] as const)
      expect(PAUSE_COPY[kind].length).toBeGreaterThan(0);
  });
});
