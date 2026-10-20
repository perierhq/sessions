import { describe, expect, test } from "bun:test";
import {
  embeddedIpv4,
  ipv6Hextets,
  isBlockedAddress,
  isTailnetIpv4,
  normalizeAddress,
} from "./network-address";

/** The host part of a URL, as `new URL()` normalises it. */
const urlHost = (host: string) => new URL(`http://${host}/`).hostname;

describe("ipv6Hextets", () => {
  test("expands compressed, dotted-tail and full forms", () => {
    expect(ipv6Hextets("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Hextets("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Hextets("::ffff:127.0.0.1")).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x7f00, 1,
    ]);
    expect(ipv6Hextets("64:ff9b::10.0.0.1")).toEqual([
      0x64, 0xff9b, 0, 0, 0, 0, 0x0a00, 1,
    ]);
    expect(ipv6Hextets("1:2:3:4:5:6:7.8.9.10")).toEqual([
      1, 2, 3, 4, 5, 6, 0x0708, 0x090a,
    ]);
    expect(ipv6Hextets("2001:db8:0:0:0:0:0:1")).toEqual([
      0x2001, 0xdb8, 0, 0, 0, 0, 0, 1,
    ]);
    expect(ipv6Hextets("[fe80::1%eth0]")).toEqual([
      0xfe80, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  test("is undefined for anything that is not IPv6", () => {
    expect(ipv6Hextets("127.0.0.1")).toBeUndefined();
    expect(ipv6Hextets("example.com")).toBeUndefined();
    expect(ipv6Hextets("1::2::3")).toBeUndefined();
    expect(ipv6Hextets("")).toBeUndefined();
  });
});

describe("embeddedIpv4", () => {
  test("reads every IPv4-carrying IPv6 form", () => {
    expect(embeddedIpv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(embeddedIpv4("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(embeddedIpv4("::ffff:0:a00:1")).toBe("10.0.0.1");
    expect(embeddedIpv4("::7f00:1")).toBe("127.0.0.1");
    expect(embeddedIpv4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIpv4("2002:c0a8:101::1")).toBe("192.168.1.1");
  });

  test("is undefined for native IPv6 and for IPv4", () => {
    expect(embeddedIpv4("2606:4700::1111")).toBeUndefined();
    expect(embeddedIpv4("fd00::1")).toBeUndefined();
    expect(embeddedIpv4("8.8.8.8")).toBeUndefined();
  });
});

describe("isBlockedAddress", () => {
  test("blocks IPv4 embedded in IPv6, in the form a URL normalises it to", () => {
    for (const host of [
      "[::ffff:127.0.0.1]",
      "[::ffff:a9fe:a9fe]",
      "[::ffff:10.0.0.1]",
      "[::ffff:192.168.1.1]",
      "[::ffff:100.100.1.1]",
      "[::7f00:1]",
      "[::127.0.0.1]",
      "[::a9fe:a9fe]",
      "[64:ff9b::127.0.0.1]",
      "[64:ff9b::a9fe:a9fe]",
      "[64:ff9b::a00:1]",
      "[2002:7f00:1::]",
      "[2002:a9fe:a9fe::1]",
      "[2002:c0a8:101:1::1]",
      "[::ffff:0:7f00:1]",
    ]) {
      expect(isBlockedAddress(urlHost(host))).toBe(true);
      expect(isBlockedAddress(host)).toBe(true);
    }
  });

  test("blocks native private IPv6, with or without a zone id", () => {
    for (const ip of [
      "::",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "fe80::1",
      "fe80::1%eth0",
      "[fe80::1%25eth0]",
      "febf::1",
      "fec0::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "64:ff9b:1::a",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("allows public IPv6 and public IPv4 carried in IPv6", () => {
    for (const ip of [
      "2606:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "[::ffff:1.1.1.1]",
      "64:ff9b::808:808",
      "2002:808:808::1",
      "2a00:1450::1",
    ]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("keeps the IPv4 rules", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.63.255.255"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("a name is not an address", () => {
    expect(isBlockedAddress("example.com")).toBe(false);
  });
});

describe("normalizeAddress", () => {
  test("maps IPv4-mapped IPv6 to dotted IPv4 in either spelling", () => {
    expect(normalizeAddress("::ffff:100.64.0.1")).toBe("100.64.0.1");
    expect(normalizeAddress("::ffff:6440:1")).toBe("100.64.0.1");
    expect(normalizeAddress("100.64.0.1:4000")).toBe("100.64.0.1");
    expect(normalizeAddress("fd7a:115c:a1e0::1")).toBe("fd7a:115c:a1e0::1");
  });

  test("tailnet recognition covers mapped forms only", () => {
    expect(isTailnetIpv4("::ffff:6440:1")).toBe(true);
    expect(isTailnetIpv4("::ffff:100.64.0.1")).toBe(true);
    // NAT64 and 6to4 are not the tailnet peer itself.
    expect(isTailnetIpv4("64:ff9b::6440:1")).toBe(false);
    expect(isTailnetIpv4("2002:6440:1::1")).toBe(false);
  });
});
