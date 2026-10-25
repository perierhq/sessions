import { describe, expect, test } from "bun:test";
import {
  MAIL_HOST_REFUSED,
  MailHostRefusedError,
  classifyMailAddress,
  resolveMailHost,
} from "./mail-host";

const PUBLIC = "93.184.216.34";

function resolver(answers: Record<string, string[]>) {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (host: string) => {
      asked.push(host);
      const out = answers[host];
      if (!out)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
          code: "ENOTFOUND",
        });
      return out;
    },
  };
}

describe("classifyMailAddress", () => {
  test("public addresses", () => {
    for (const ip of [PUBLIC, "8.8.8.8", "2606:4700::1111"])
      expect(classifyMailAddress(ip)).toBe("public");
  });

  test("loopback, private and tailnet addresses are internal", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "100.64.0.1",
      "100.127.255.254",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:192.168.1.10",
    ])
      expect(classifyMailAddress(ip)).toBe("internal");
  });

  test("link-local, cloud metadata and reserved addresses are always refused", () => {
    for (const ip of [
      "169.254.169.254",
      "169.254.1.1",
      "fe80::1",
      "fe80::1%en0",
      "fd00:ec2::254",
      "100.100.100.200",
      "192.0.0.192",
      "::ffff:169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "::",
      "not-an-ip",
    ])
      expect(classifyMailAddress(ip)).toBe("refused");
  });
});

describe("resolveMailHost", () => {
  test("a public name resolves, and the checked IP is dialled with the name kept for TLS", async () => {
    const r = resolver({ "imap.example.test": [PUBLIC] });
    expect(
      await resolveMailHost(
        "imap.example.test",
        { allowInternalHost: false },
        r.resolve,
      ),
    ).toEqual({
      host: "imap.example.test",
      address: PUBLIC,
      servername: "imap.example.test",
      loopback: false,
    });
  });

  test("an IP literal is not resolved and has no servername", async () => {
    const r = resolver({});
    expect(
      await resolveMailHost(PUBLIC, { allowInternalHost: false }, r.resolve),
    ).toEqual({
      host: PUBLIC,
      address: PUBLIC,
      servername: undefined,
      loopback: false,
    });
    expect(r.asked).toEqual([]);
  });

  test("IPv4 is dialled first when a name has both", async () => {
    const r = resolver({
      "imap.example.test": ["2606:4700::1111", PUBLIC],
    });
    const target = await resolveMailHost(
      "imap.example.test",
      { allowInternalHost: false },
      r.resolve,
    );
    expect(target.address).toBe(PUBLIC);
  });

  test("an internal address needs allowInternalHost", async () => {
    const r = resolver({ "mail.acme.example.test": ["192.168.1.10"] });
    const refused = resolveMailHost(
      "mail.acme.example.test",
      { allowInternalHost: false },
      r.resolve,
    );
    await expect(refused).rejects.toBeInstanceOf(MailHostRefusedError);
    await expect(refused).rejects.toThrow(MAIL_HOST_REFUSED);
    expect(
      await resolveMailHost(
        "mail.acme.example.test",
        { allowInternalHost: true },
        r.resolve,
      ),
    ).toMatchObject({ address: "192.168.1.10", loopback: false });
    await expect(
      resolveMailHost("127.0.0.1", { allowInternalHost: false }, r.resolve),
    ).rejects.toBeInstanceOf(MailHostRefusedError);
    expect(
      await resolveMailHost("127.0.0.1", { allowInternalHost: true }),
    ).toMatchObject({ address: "127.0.0.1", loopback: true });
  });

  test("link-local and metadata are refused even with allowInternalHost", async () => {
    const r = resolver({ "imap.example.test": ["169.254.169.254"] });
    for (const host of ["imap.example.test", "169.254.169.254", "fe80::1"])
      await expect(
        resolveMailHost(host, { allowInternalHost: true }, r.resolve),
      ).rejects.toBeInstanceOf(MailHostRefusedError);
  });

  test("metadata names are refused without resolving them", async () => {
    const r = resolver({});
    for (const host of [
      "metadata.google.internal",
      "Metadata.Google.Internal.",
      "metadata",
      "instance-data.ec2.internal",
    ])
      await expect(
        resolveMailHost(host, { allowInternalHost: true }, r.resolve),
      ).rejects.toBeInstanceOf(MailHostRefusedError);
    expect(r.asked).toEqual([]);
  });

  test("one bad address among several refuses the host", async () => {
    const r = resolver({ "imap.example.test": [PUBLIC, "10.0.0.5"] });
    await expect(
      resolveMailHost(
        "imap.example.test",
        { allowInternalHost: false },
        r.resolve,
      ),
    ).rejects.toBeInstanceOf(MailHostRefusedError);
  });

  test("the refusal never names the address or port", async () => {
    const r = resolver({ "imap.example.test": ["10.0.0.5"] });
    const error = await resolveMailHost(
      "imap.example.test",
      { allowInternalHost: false },
      r.resolve,
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(MailHostRefusedError);
    expect((error as Error).message).toBe(MAIL_HOST_REFUSED);
    expect((error as Error).message).not.toContain("10.0.0.5");
  });

  test("a name that doesn't resolve is a network error, not a refusal", async () => {
    const r = resolver({});
    const error = await resolveMailHost(
      "nowhere.example.test",
      { allowInternalHost: false },
      r.resolve,
    ).catch((e: Error & { code?: string }) => e);
    expect(error).not.toBeInstanceOf(MailHostRefusedError);
    expect((error as { code?: string }).code).toBe("ENOTFOUND");
  });
});
