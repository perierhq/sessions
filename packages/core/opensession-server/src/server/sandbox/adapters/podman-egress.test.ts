import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../provider";
import type { PodmanRunner, PodmanRunOpts } from "./podman-cli";
import {
  BLOCKED_IPV4_RANGES,
  installEgressRules,
  ipv4InBlockedRange,
  expectedEgressListing,
  normalizeNftListing,
  podmanEgressRuleset,
  resolveEgressInput,
  verifyEgressRules,
  verifyEgressRulesAt,
  workloadNetnsPath,
  type EgressInput,
} from "./podman-egress";
import {
  EGRESS_FIXTURE_INPUT,
  EGRESS_FIXTURE_LISTING,
} from "./podman-egress-fixture";

const INPUT: EgressInput = {
  callback: { addresses: ["203.0.113.7"], port: 443 },
  hostAddresses: ["10.1.2.3", "100.64.1.2", "fd00::1"],
  dns: ["1.1.1.1", "9.9.9.9"],
};

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

interface Call {
  argv: string[];
  opts?: PodmanRunOpts;
}

/** A runner that answers from `reply` and records every call. */
function fakeRunner(reply: (argv: string[]) => ExecResult): {
  run: PodmanRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: PodmanRunner = async (argv, opts) => {
    calls.push({ argv, opts });
    return reply(argv);
  };
  return { run, calls };
}

function listingReply(listing: string) {
  return (argv: string[]): ExecResult => {
    if (
      argv[0] === "container" &&
      argv.includes("{{.NetworkSettings.SandboxKey}}")
    )
      return ok("/run/user/1000/netns/netns-0123\n");
    if (argv[0] === "unshare") return ok(listing);
    return { exitCode: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
  };
}

/** The fixture listing with `edit` applied to its parsed form. */
function editedListing(
  edit: (items: Record<string, unknown>[]) => void,
): string {
  const parsed = JSON.parse(EGRESS_FIXTURE_LISTING);
  edit(parsed.nftables);
  return JSON.stringify(parsed);
}

describe("egress ruleset", () => {
  const ruleset = podmanEgressRuleset(INPUT);
  const lines = ruleset.split("\n").map((l) => l.trim());

  test("filters output in its own table and refuses the blocked ranges", () => {
    expect(
      ruleset.startsWith(
        "table inet opensession\ndelete table inet opensession\ntable inet opensession {",
      ),
    ).toBe(true);
    expect(ruleset).toContain(
      "type filter hook output priority filter; policy accept;",
    );
    expect(lines).toContain('oif "lo" accept');
    for (const range of [
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ])
      expect(ruleset).toContain(range);
    expect(lines).toContain(
      "meta nfproto ipv6 counter reject with icmpx admin-prohibited",
    );
    expect(lines).toContain(
      "ip daddr @blocked4 counter reject with icmpx admin-prohibited",
    );
  });

  test("every refusal is admin-prohibited, never a reset or a silent drop", () => {
    const rejects = lines.filter((l) => l.includes("reject"));
    expect(rejects.length).toBeGreaterThan(0);
    for (const line of rejects)
      expect(line.endsWith("reject with icmpx admin-prohibited")).toBe(true);
    expect(ruleset).not.toContain("tcp reset");
    expect(ruleset).not.toMatch(/\bdrop\b/);
  });

  test("the callback port is allowed before the rest of the callback address is refused", () => {
    const accept = lines.indexOf(
      "ip daddr 203.0.113.7 tcp dport 443 counter accept",
    );
    const refuse = lines.indexOf(
      "ip daddr 203.0.113.7 counter reject with icmpx admin-prohibited",
    );
    const blocked = lines.indexOf(
      "ip daddr @blocked4 counter reject with icmpx admin-prohibited",
    );
    expect(accept).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(accept);
    expect(blocked).toBeGreaterThan(refuse);
  });

  test("host addresses and the callback address are in the refused host set; IPv6 is ignored", () => {
    expect(lines).toContain("elements = { 10.1.2.3, 100.64.1.2, 203.0.113.7 }");
    expect(ruleset).not.toContain("fd00::1");
    expect(lines).toContain(
      "ip daddr @hostaddrs4 counter reject with icmpx admin-prohibited",
    );
  });

  test("operator extra host addresses join the refused host set", () => {
    const extra = podmanEgressRuleset({
      ...INPUT,
      extraHostAddresses: ["198.51.100.20", "fd00::2", "10.1.2.3"],
    });
    expect(extra.split("\n").map((l) => l.trim())).toContain(
      "elements = { 10.1.2.3, 100.64.1.2, 198.51.100.20, 203.0.113.7 }",
    );
    expect(extra).not.toContain("fd00::2");
    expect(
      expectedEgressListing({
        ...INPUT,
        extraHostAddresses: ["198.51.100.20"],
      }),
    ).toContain(
      'set inet opensession hostaddrs4 type="ipv4_addr" flags= ' +
        "elem=10.1.2.3,100.64.1.2,198.51.100.20,203.0.113.7",
    );
    expect(() =>
      podmanEgressRuleset({ ...INPUT, extraHostAddresses: ["198.51.100.20;"] }),
    ).toThrow("invalid extra host address");
    expect(() =>
      podmanEgressRuleset({ ...INPUT, extraHostAddresses: ["1.1.1.1"] }),
    ).toThrow("DNS resolver 1.1.1.1");
  });

  test("DNS reaches only the configured resolvers", () => {
    expect(lines).toContain("elements = { 1.1.1.1, 9.9.9.9 }");
    const allow = lines.indexOf(
      "meta l4proto { tcp, udp } th dport 53 ip daddr @resolvers4 counter accept",
    );
    const refuse = lines.indexOf(
      "meta l4proto { tcp, udp } th dport 53 counter reject with icmpx admin-prohibited",
    );
    expect(allow).toBeGreaterThan(-1);
    expect(refuse).toBe(allow + 1);
  });

  test("a callback on a private, tailnet or loopback address is refused", () => {
    for (const address of [
      "10.0.0.4",
      "100.101.0.5",
      "127.0.0.1",
      "169.254.169.254",
    ])
      expect(() =>
        podmanEgressRuleset({
          ...INPUT,
          callback: { addresses: [address], port: 443 },
        }),
      ).toThrow("callback base URL resolves to a private or host address");
  });

  test("bad inputs widen nothing: they throw", () => {
    expect(() =>
      podmanEgressRuleset({
        ...INPUT,
        callback: { addresses: ["fd00::2"], port: 443 },
      }),
    ).toThrow("no IPv4 address");
    expect(() =>
      podmanEgressRuleset({
        ...INPUT,
        callback: { addresses: ["203.0.113.7"], port: 0 },
      }),
    ).toThrow();
    expect(() =>
      podmanEgressRuleset({
        ...INPUT,
        callback: { addresses: ["203.0.113.7; flush ruleset"], port: 443 },
      }),
    ).toThrow();
    expect(() =>
      podmanEgressRuleset({ ...INPUT, hostAddresses: ["lo"] }),
    ).toThrow();
    expect(() => podmanEgressRuleset({ ...INPUT, dns: [] })).toThrow();
    expect(() =>
      podmanEgressRuleset({ ...INPUT, dns: ["169.254.169.254"] }),
    ).toThrow();
    expect(() =>
      podmanEgressRuleset({ ...INPUT, dns: ["100.100.100.100"] }),
    ).toThrow();
  });

  test("blocked ranges are matched by prefix", () => {
    expect(BLOCKED_IPV4_RANGES).toContain("100.64.0.0/10");
    expect(ipv4InBlockedRange("100.127.255.255")).toBe(true);
    expect(ipv4InBlockedRange("100.128.0.1")).toBe(false);
    expect(ipv4InBlockedRange("172.31.0.1")).toBe(true);
    expect(ipv4InBlockedRange("172.32.0.1")).toBe(false);
    expect(ipv4InBlockedRange("203.0.113.7")).toBe(false);
    expect(ipv4InBlockedRange("255.255.255.255")).toBe(true);
  });
});

describe("egress input", () => {
  test("resolves the callback host now and reads the host's addresses", async () => {
    const looked: string[] = [];
    const input = await resolveEgressInput(
      "https://ingress.example.test/base",
      ["1.1.1.1"],
      async (host) => {
        looked.push(host);
        return ["203.0.113.9"];
      },
      () => ["10.1.2.3", "fd00::1"],
    );
    expect(looked).toEqual(["ingress.example.test"]);
    expect(input).toEqual({
      callback: { addresses: ["203.0.113.9"], port: 443 },
      hostAddresses: ["10.1.2.3", "fd00::1"],
      dns: ["1.1.1.1"],
    });
    expect(
      await resolveEgressInput(
        "https://203.0.113.9/",
        ["1.1.1.1"],
        undefined,
        () => [],
        ["198.51.100.20"],
      ),
    ).toEqual({
      callback: { addresses: ["203.0.113.9"], port: 443 },
      hostAddresses: [],
      extraHostAddresses: ["198.51.100.20"],
      dns: ["1.1.1.1"],
    });
  });

  test("keeps an explicit port and skips DNS for an IP literal", async () => {
    const input = await resolveEgressInput(
      "http://203.0.113.9:8443",
      ["1.1.1.1"],
      async () => {
        throw new Error("no lookup expected");
      },
      () => [],
    );
    expect(input.callback).toEqual({ addresses: ["203.0.113.9"], port: 8443 });
    expect(
      (
        await resolveEgressInput(
          "http://203.0.113.9",
          [],
          async () => [],
          () => [],
        )
      ).callback.port,
    ).toBe(80);
  });

  test("refuses other schemes", async () => {
    await expect(
      resolveEgressInput(
        "ftp://example.test",
        ["1.1.1.1"],
        async () => [],
        () => [],
      ),
    ).rejects.toThrow("http(s)");
  });
});

describe("egress install", () => {
  test("enters the infra container's namespace and feeds the ruleset on stdin", async () => {
    const { run, calls } = fakeRunner(listingReply(""));
    const ruleset = podmanEgressRuleset(INPUT);
    const netns = await installEgressRules(
      run,
      "opensession-sbx-a-infra",
      ruleset,
    );
    expect(netns).toBe("/run/user/1000/netns/netns-0123");
    expect(calls.map((c) => c.argv)).toEqual([
      [
        "container",
        "inspect",
        "--format",
        "{{.NetworkSettings.SandboxKey}}",
        "opensession-sbx-a-infra",
      ],
      [
        "unshare",
        "nsenter",
        "--net=/run/user/1000/netns/netns-0123",
        "nft",
        "-f",
        "-",
      ],
    ]);
    expect(calls[1]!.opts?.stdin).toBe(ruleset);
  });

  test("an nft failure rejects with its stderr", async () => {
    const { run } = fakeRunner((argv) =>
      argv[0] === "unshare"
        ? { exitCode: 1, stdout: "", stderr: "Error: Operation not permitted" }
        : ok("/run/user/1000/netns/netns-0123"),
    );
    await expect(
      installEgressRules(
        run,
        "opensession-sbx-a-infra",
        podmanEgressRuleset(INPUT),
      ),
    ).rejects.toThrow("Operation not permitted");
  });

  test("a stopped infra (no namespace) rejects before nft runs", async () => {
    const { run, calls } = fakeRunner(() => ok("\n"));
    await expect(
      installEgressRules(
        run,
        "opensession-sbx-a-infra",
        podmanEgressRuleset(INPUT),
      ),
    ).rejects.toThrow("no network namespace");
    expect(calls).toHaveLength(1);
    const traversal = fakeRunner(() => ok("/run/../etc/netns"));
    await expect(
      installEgressRules(traversal.run, "opensession-sbx-a-infra", "x"),
    ).rejects.toThrow("no network namespace");
  });
});

describe("egress verify", () => {
  test("the captured nft 1.0.9 listing matches its policy", async () => {
    const { run, calls } = fakeRunner(listingReply(EGRESS_FIXTURE_LISTING));
    await verifyEgressRules(
      run,
      "opensession-sbx-a-infra",
      EGRESS_FIXTURE_INPUT,
    );
    expect(calls.at(-1)!.argv).toEqual([
      "unshare",
      "nsenter",
      "--net=/run/user/1000/netns/netns-0123",
      "nft",
      "-j",
      "list",
      "ruleset",
    ]);
  });

  test("handles and counter values do not matter", async () => {
    const listing = editedListing((items) => {
      for (const item of items) {
        const body = Object.values(item)[0] as Record<string, unknown>;
        if (typeof body.handle === "number") body.handle += 100;
      }
    }).replaceAll('"packets": 0', '"packets": 99');
    const { run } = fakeRunner(listingReply(listing));
    await verifyEgressRules(
      run,
      "opensession-sbx-a-infra",
      EGRESS_FIXTURE_INPUT,
    );
  });

  test("a missing rule rejects and names it", async () => {
    const listing = editedListing((items) => {
      const index = items.findIndex((item) =>
        JSON.stringify(item).includes("@blocked4"),
      );
      items.splice(index, 1);
    });
    const { run } = fakeRunner(listingReply(listing));
    await expect(
      verifyEgressRules(run, "opensession-sbx-a-infra", EGRESS_FIXTURE_INPUT),
    ).rejects.toThrow(/missing rule .*@blocked4/);
  });

  test("an empty namespace rejects", async () => {
    const { run } = fakeRunner(
      listingReply('{"nftables": [{"metainfo": {"version": "1.0.9"}}]}'),
    );
    await expect(
      verifyEgressRules(run, "opensession-sbx-a-infra", EGRESS_FIXTURE_INPUT),
    ).rejects.toThrow("missing table inet opensession");
  });

  test("a dormant table rejects", async () => {
    const dormant = editedListing((items) => {
      const table = items.find((item) => "table" in item) as {
        table: Record<string, unknown>;
      };
      table.table.flags = ["dormant"];
    });
    await expect(
      verifyEgressRules(
        fakeRunner(listingReply(dormant)).run,
        "opensession-sbx-a-infra",
        EGRESS_FIXTURE_INPUT,
      ),
    ).rejects.toThrow("table inet opensession flags=dormant");
  });

  test("an extra table or reordered rules reject", async () => {
    const extra = editedListing((items) => {
      items.push({ table: { family: "ip", name: "other", handle: 9 } });
    });
    await expect(
      verifyEgressRules(
        fakeRunner(listingReply(extra)).run,
        "opensession-sbx-a-infra",
        EGRESS_FIXTURE_INPUT,
      ),
    ).rejects.toThrow("unexpected table ip other");

    const reordered = editedListing((items) => {
      const rules = items.filter((item) => "rule" in item);
      const first = items.indexOf(rules[2]!);
      const second = items.indexOf(rules[3]!);
      [items[first], items[second]] = [items[second]!, items[first]!];
    });
    await expect(
      verifyEgressRules(
        fakeRunner(listingReply(reordered)).run,
        "opensession-sbx-a-infra",
        EGRESS_FIXTURE_INPUT,
      ),
    ).rejects.toThrow("out of order");
  });

  test("a different callback address in the policy rejects", async () => {
    const { run } = fakeRunner(listingReply(EGRESS_FIXTURE_LISTING));
    await expect(
      verifyEgressRules(run, "opensession-sbx-a-infra", {
        ...EGRESS_FIXTURE_INPUT,
        callback: { addresses: ["203.0.113.8"], port: 443 },
      }),
    ).rejects.toThrow("do not match");
  });

  test("an nft error or non-JSON output rejects", async () => {
    const failing = fakeRunner((argv) =>
      argv[0] === "unshare"
        ? {
            exitCode: 1,
            stdout: "",
            stderr: "Error: No such file or directory",
          }
        : ok("/run/user/1000/netns/netns-0123"),
    );
    await expect(
      verifyEgressRules(
        failing.run,
        "opensession-sbx-a-infra",
        EGRESS_FIXTURE_INPUT,
      ),
    ).rejects.toThrow("No such file");
    await expect(
      verifyEgressRules(
        fakeRunner(listingReply("table inet opensession {")).run,
        "opensession-sbx-a-infra",
        EGRESS_FIXTURE_INPUT,
      ),
    ).rejects.toThrow("not JSON");
  });

  test("the workload's own namespace is verified through its pid", async () => {
    const { run, calls } = fakeRunner((argv) =>
      argv[0] === "container" ? ok("4242\n") : ok(EGRESS_FIXTURE_LISTING),
    );
    const netns = await workloadNetnsPath(run, "opensession-sbx-a-ws");
    expect(netns).toBe("/proc/4242/ns/net");
    await verifyEgressRulesAt(run, netns, EGRESS_FIXTURE_INPUT);
    expect(calls[0]!.argv).toEqual([
      "container",
      "inspect",
      "--format",
      "{{.State.Pid}}",
      "opensession-sbx-a-ws",
    ]);
    expect(calls[1]!.argv[2]).toBe("--net=/proc/4242/ns/net");

    const stopped = fakeRunner(() => ok("0\n"));
    await expect(
      workloadNetnsPath(stopped.run, "opensession-sbx-a-ws"),
    ).rejects.toThrow("not running");
  });

  test("the normaliser refuses entries it cannot read", () => {
    expect(() => normalizeNftListing("{}")).toThrow();
    expect(() =>
      normalizeNftListing('{"nftables": [{"a": {}, "b": {}}]}'),
    ).toThrow();
  });
});
