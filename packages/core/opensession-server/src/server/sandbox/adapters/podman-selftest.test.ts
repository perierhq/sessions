import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../provider";
import type { RemoteDriver, RemoteExecOpts } from "./bootstrap";
import {
  hostControlCheck,
  isolationScript,
  isolationTargets,
  runIsolationSelfTest,
  type IsolationTarget,
} from "./podman-selftest";

const OPTIONS = {
  callbackBaseUrl: "https://ingress.example.test/",
  callbackAddresses: ["203.0.113.7"],
  hostAddresses: ["10.1.2.3"],
  tailnetAddresses: ["100.64.1.2"],
  appPort: 3850,
  loopbackPorts: [3860],
  hostPaths: ["/srv/opensession-state"],
  full: true,
};

function names(targets: IsolationTarget[]): string[] {
  return targets.map((t) => t.name);
}

function find(targets: IsolationTarget[], name: string): IsolationTarget {
  const target = targets.find((t) => t.name === name);
  if (!target) throw new Error(`no target ${name}`);
  return target;
}

/** What a correctly isolated container prints for each target. */
function goodAnswer(t: IsolationTarget): string {
  if (t.expect === "filtered") return "unreachable";
  if (t.expect === "blocked") return "refused";
  if (t.expect === "host") return "remote:unreachable";
  if (t.expect === "absent") return t.kind === "dns" ? "unresolved" : "absent";
  if (t.expect === "equal") return t.value ?? "";
  return t.kind === "dns" ? "resolved" : "http:200";
}

function rows(
  targets: IsolationTarget[],
  override: Record<string, string> = {},
): string {
  return targets
    .map((t) => `${t.name}\t${override[t.name] ?? goodAnswer(t)}\n`)
    .join("");
}

function fakeDriver(reply: (cmd: string) => ExecResult): {
  driver: RemoteDriver;
  calls: { cmd: string; opts?: RemoteExecOpts }[];
} {
  const calls: { cmd: string; opts?: RemoteExecOpts }[] = [];
  const driver: RemoteDriver = {
    async exec(cmd, opts) {
      calls.push({ cmd, opts });
      return reply(cmd);
    },
    async execBackground() {
      throw new Error("not used");
    },
    async writeFile() {
      throw new Error("not used");
    },
    async ensureStarted() {},
  };
  return { driver, calls };
}

describe("isolation targets", () => {
  test("the full list covers the host, tailnet, metadata, DNS, files and privileges", () => {
    const targets = isolationTargets(OPTIONS);
    const list = names(targets);
    for (const name of ["tcp:127.0.0.1:3850", "tcp:127.0.0.1:3860"])
      expect(find(targets, name).expect).toBe("blocked");
    for (const name of ["tcp:10.1.2.3:22", "tcp:10.1.2.3:3850"])
      expect(find(targets, name).expect).toBe("host");
    for (const name of [
      "tcp:100.64.1.2:3850",
      "tcp:203.0.113.7:22",
      "tcp:169.254.169.254:80",
      "tcp:169.254.1.1:53",
      "tcp:169.254.1.2:22",
      "tcp:100.100.100.100:53",
    ])
      expect(find(targets, name).expect).toBe("filtered");
    expect(find(targets, "http:https://github.com/").expect).toBe("reachable");
    expect(find(targets, "callback").expect).toBe("reachable");
    expect(find(targets, "callback").target).toBe(
      "https://ingress.example.test/",
    );
    expect(find(targets, "dns:github.com").expect).toBe("reachable");
    expect(find(targets, "dns:host.containers.internal").expect).toBe("absent");
    for (const path of [
      "/etc/opensession",
      "/run/user",
      "/srv/opensession-state",
    ])
      expect(find(targets, `file:${path}`).expect).toBe("absent");
    expect(find(targets, "proc:CapEff")).toMatchObject({
      expect: "equal",
      value: "0000000000000000",
    });
    expect(find(targets, "proc:uid")).toMatchObject({
      expect: "equal",
      value: "1000",
    });
    expect(find(targets, "proc:NoNewPrivs").value).toBe("1");
    expect(new Set(list).size).toBe(list.length);
  });

  test("operator extra host addresses are probed as filtered", () => {
    const targets = isolationTargets({
      ...OPTIONS,
      extraHostAddresses: ["198.51.100.20", "fd00::2"],
    });
    expect(find(targets, "tcp:198.51.100.20:22").expect).toBe("filtered");
    expect(find(targets, "tcp:198.51.100.20:3850").expect).toBe("filtered");
    expect(names(targets).some((n) => n.includes("fd00::2"))).toBe(false);
    expect(() =>
      isolationTargets({ ...OPTIONS, extraHostAddresses: ["1.2.3.4;id"] }),
    ).toThrow();
  });

  test("the network half leaves out file and process checks", () => {
    const targets = isolationTargets({ ...OPTIONS, full: false });
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(["tcp", "http", "dns"]).toContain(t.kind);
    expect(names(targets)).toContain("tcp:169.254.169.254:80");
    expect(names(targets)).toContain("callback");
  });

  test("the callback port itself is not probed as blocked", () => {
    const targets = isolationTargets({
      ...OPTIONS,
      callbackBaseUrl: "https://203.0.113.7:22/",
    });
    expect(names(targets)).not.toContain("tcp:203.0.113.7:22");
  });

  test("IPv6 and loopback host addresses are not turned into probes", () => {
    const targets = isolationTargets({
      ...OPTIONS,
      hostAddresses: ["10.1.2.3", "fd00::1", "127.0.0.1"],
    });
    expect(
      names(targets).filter(
        (n) => n.endsWith(":22") && n.startsWith("tcp:10."),
      ),
    ).toEqual(["tcp:10.1.2.3:22"]);
    expect(names(targets).some((n) => n.includes("fd00"))).toBe(false);
  });

  test("anything that would reach the script unvalidated is refused", () => {
    expect(() =>
      isolationTargets({ ...OPTIONS, hostAddresses: ["10.1.2.3;id"] }),
    ).toThrow();
    expect(() => isolationTargets({ ...OPTIONS, appPort: 70000 })).toThrow();
    expect(() =>
      isolationTargets({ ...OPTIONS, callbackBaseUrl: "ftp://example.test" }),
    ).toThrow();
    expect(() =>
      isolationTargets({ ...OPTIONS, hostPaths: ["/tmp/$(id)"] }),
    ).toThrow();
    expect(() =>
      isolationScript([
        { name: "x", kind: "tcp", target: "1.2.3.4:5; id", expect: "blocked" },
      ]),
    ).toThrow();
  });
});

describe("isolation script", () => {
  const targets = isolationTargets(OPTIONS);

  test("re-runs itself under /bin/bash with a cleared env and a fixed PATH", () => {
    const script = isolationScript(targets);
    expect(script.split("\n")[0]).toBe(
      "exec /usr/bin/env -i /bin/bash --noprofile --norc -c " +
        "'PATH=/usr/sbin:/usr/bin:/sbin:/bin; hash -r",
    );
    expect(script.endsWith("'\n")).toBe(true);
  });

  test("calls every tool by absolute path", () => {
    // `echo timeout` is a probe answer, not a call.
    const script = isolationScript(targets).replace(/echo [a-z]+/g, "echo");
    for (const tool of ["timeout", "bash", "curl", "getent", "id", "awk"])
      expect(script).not.toMatch(
        new RegExp(`(^|[\\s;(|"$])${tool}(\\s|$)`, "m"),
      );
    for (const path of [
      "/usr/bin/timeout",
      "/bin/bash",
      "/usr/bin/curl",
      "/usr/bin/getent",
      "/usr/bin/id",
      "/usr/bin/awk",
    ])
      expect(script).toContain(path);
  });

  test("runs end to end without the caller's env", async () => {
    const script = isolationScript([
      { name: "file:/tmp", kind: "file", target: "/tmp", expect: "absent" },
      {
        name: "file:/no/such/path",
        kind: "file",
        target: "/no/such/path",
        expect: "absent",
      },
    ]);
    const proc = Bun.spawn(["/bin/bash", "-c", script], {
      env: { PATH: "/nonexistent", MARK: "leak" },
      stdout: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe(
      "file:/tmp\tpresent\nfile:/no/such/path\tabsent\n",
    );
    expect(await proc.exited).toBe(0);
  });
});

describe("isolation self-test", () => {
  const targets = isolationTargets(OPTIONS);

  test("runs one exec and passes when every target answers as expected", async () => {
    const { driver, calls } = fakeDriver(() => ({
      exitCode: 0,
      stdout: rows(targets),
      stderr: "",
    }));
    const result = await runIsolationSelfTest(driver, targets);
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(targets.length);
    const script = calls[0]!.cmd;
    expect(script).toContain("probe_tcp 169.254.169.254 80");
    expect(script).toContain("probe_http https://github.com/");
    expect(script).toContain("/dev/tcp/");
  });

  test("an open blocked target fails and is reported", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 0,
      stdout: rows(targets, { "tcp:169.254.169.254:80": "open" }),
      stderr: "",
    }));
    const result = await runIsolationSelfTest(driver, targets);
    expect(result.ok).toBe(false);
    expect(result.results.filter((r) => !r.pass)).toEqual([
      {
        name: "tcp:169.254.169.254:80",
        expect: "filtered",
        got: "open",
        pass: false,
      },
    ]);
  });

  test("a host address is blocked only when the namespace holds it", async () => {
    const script = isolationScript(targets);
    expect(script).toContain("probe_host_tcp 10.1.2.3 22");
    expect(script).toContain("/proc/net/fib_trie");
    const cases: [string, boolean, string][] = [
      ["local:refused", true, "blocked"],
      ["local:unreachable", true, "blocked"],
      ["local:open", false, "blocked"],
      ["remote:unreachable", true, "filtered"],
      ["remote:refused", false, "filtered"],
      ["remote:timeout", false, "filtered"],
      ["refused", false, "host"],
    ];
    for (const [got, pass, expect_] of cases) {
      const { driver } = fakeDriver(() => ({
        exitCode: 0,
        stdout: rows(targets, { "tcp:10.1.2.3:22": got }),
        stderr: "",
      }));
      const result = await runIsolationSelfTest(driver, targets);
      expect(result.ok).toBe(pass);
      expect(result.results.find((r) => r.name === "tcp:10.1.2.3:22")).toEqual({
        name: "tcp:10.1.2.3:22",
        expect: expect_ as never,
        got,
        pass,
      });
    }
  });

  test("a filtered target must be refused by the firewall, not just closed", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 0,
      stdout: rows(targets, { "tcp:100.64.1.2:3850": "refused" }),
      stderr: "",
    }));
    const result = await runIsolationSelfTest(driver, targets);
    expect(result.ok).toBe(false);
    expect(result.results.find((r) => !r.pass)?.name).toBe(
      "tcp:100.64.1.2:3850",
    );
  });

  test("an unreachable callback, a present file or a capability fails", async () => {
    const overrides: Record<string, string>[] = [
      { callback: "failed" },
      { "file:/run/user": "present" },
      { "proc:CapEff": "00000000a80425fb" },
      { "dns:host.containers.internal": "resolved" },
    ];
    for (const override of overrides) {
      const { driver } = fakeDriver(() => ({
        exitCode: 0,
        stdout: rows(targets, override),
        stderr: "",
      }));
      expect((await runIsolationSelfTest(driver, targets)).ok).toBe(false);
    }
  });

  test("missing rows fail: a timeout is never a pass", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 124,
      stdout: rows(targets.slice(0, 3)),
      stderr: "timed out",
    }));
    const result = await runIsolationSelfTest(driver, targets);
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(targets.length);
    expect(
      result.results.filter((r) => r.got.startsWith("missing")),
    ).toHaveLength(targets.length - 3);
  });

  test("a failed exec fails even when every row passed", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 1,
      stdout: rows(targets),
      stderr: "killed",
    }));
    const result = await runIsolationSelfTest(driver, targets);
    expect(result.results.every((r) => r.pass)).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("exit 1: killed");
  });

  test("an exec that throws fails closed", async () => {
    const driver: RemoteDriver = {
      ...fakeDriver(() => ({ exitCode: 0, stdout: "", stderr: "" })).driver,
      async exec() {
        throw new Error("container gone");
      },
    };
    const result = await runIsolationSelfTest(driver, targets);
    expect(result.ok).toBe(false);
    expect(result.results.every((r) => r.got.startsWith("error"))).toBe(true);
  });

  test("an empty target list is not a pass", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    expect((await runIsolationSelfTest(driver, [])).ok).toBe(false);
  });

  test("duplicate rows or names are refused", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 0,
      stdout:
        rows(targets) +
        rows(targets.slice(0, 1), { [targets[0]!.name]: "open" }),
      stderr: "",
    }));
    expect((await runIsolationSelfTest(driver, targets)).ok).toBe(false);
    await expect(
      runIsolationSelfTest(driver, [targets[0]!, targets[0]!]),
    ).rejects.toThrow("duplicate");
  });
});

describe("counter proof", () => {
  const targets = isolationTargets(OPTIONS);
  const ruleFor = (address: string, port: number): string | undefined => {
    if (address === "203.0.113.7") return `callback-reject:${address}`;
    if (port === 53) return "dns-reject";
    if (/^(10|100|127|169)\./.test(address)) return "blocked4";
    return "hostaddrs4";
  };
  const filteredRules = () => {
    const counts = new Map<string, number>();
    for (const t of targets)
      if (t.expect === "filtered" || t.expect === "host") {
        const [a, p] = t.target.split(":");
        const key = ruleFor(a!, Number(p));
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    return counts;
  };

  function proof(after: (before: Map<string, number>) => Map<string, number>) {
    let reads = 0;
    const before = new Map([
      ["blocked4", 5],
      ["dns-reject", 0],
      ["callback-reject:203.0.113.7", 0],
      ["hostaddrs4", 0],
    ]);
    return {
      read: async () => (reads++ === 0 ? before : after(before)),
      ruleFor,
      reads: () => reads,
    };
  }

  test("passes when each expected reject counter rose by its probes", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 0,
      stdout: rows(targets),
      stderr: "",
    }));
    const counters = proof((before) => {
      const next = new Map(before);
      for (const [key, n] of filteredRules())
        next.set(key, (before.get(key) ?? 0) + n);
      return next;
    });
    const result = await runIsolationSelfTest(driver, targets, { counters });
    expect(counters.reads()).toBe(2);
    expect(result.ok).toBe(true);
    const rows_ = result.results.filter((r) => r.name.startsWith("nft:"));
    expect(rows_.map((r) => r.name).sort()).toEqual(
      [...filteredRules().keys()].map((k) => `nft:${k}`).sort(),
    );
    expect(rows_.every((r) => r.pass && r.expect === "counted")).toBe(true);
  });

  test("a counter that did not rise fails: the refusal came from elsewhere", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 0,
      stdout: rows(targets),
      stderr: "",
    }));
    const counters = proof((before) => {
      const next = new Map(before);
      for (const [key, n] of filteredRules())
        if (key !== "blocked4") next.set(key, (before.get(key) ?? 0) + n);
      return next;
    });
    const result = await runIsolationSelfTest(driver, targets, { counters });
    expect(result.ok).toBe(false);
    expect(result.results.find((r) => r.name === "nft:blocked4")).toMatchObject(
      { expect: "counted", got: "packets 5 -> 5", pass: false },
    );
  });

  test("a counter read that fails, or a target no rule covers, fails", async () => {
    const { driver } = fakeDriver(() => ({
      exitCode: 0,
      stdout: rows(targets),
      stderr: "",
    }));
    const broken = {
      read: async (): Promise<Map<string, number>> => {
        throw new Error("nft gone");
      },
      ruleFor,
    };
    const failed = await runIsolationSelfTest(driver, targets, {
      counters: broken,
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("nft gone");

    const uncovered = await runIsolationSelfTest(driver, targets, {
      counters: {
        read: async () => new Map<string, number>(),
        ruleFor: () => undefined,
      },
    });
    expect(uncovered.ok).toBe(false);
    expect(
      uncovered.results.find((r) => r.name === "nft:tcp:169.254.169.254:80"),
    ).toMatchObject({ got: "no reject rule covers it", pass: false });
  });
});

describe("host control", () => {
  test("drops blocked targets the host cannot reach and keeps filtered ones", async () => {
    const targets = isolationTargets(OPTIONS);
    const probed: string[] = [];
    const { targets: kept, notLiveOnHost } = await hostControlCheck(
      targets,
      async (host, port) => {
        probed.push(`${host}:${port}`);
        return host === "127.0.0.1" && port === 3860;
      },
    );
    expect(probed).toContain("127.0.0.1:3850");
    expect(probed).toContain("169.254.169.254:80");
    expect(names(kept)).not.toContain("tcp:127.0.0.1:3850");
    expect(names(kept)).toContain("tcp:127.0.0.1:3860");
    expect(names(kept)).toContain("tcp:169.254.169.254:80");
    expect(names(kept)).toContain("callback");
    expect(names(notLiveOnHost)).toContain("tcp:127.0.0.1:3850");
    expect(names(notLiveOnHost)).toContain("tcp:169.254.169.254:80");
  });
});
