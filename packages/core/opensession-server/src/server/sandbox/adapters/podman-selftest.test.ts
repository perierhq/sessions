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
    for (const name of [
      "tcp:127.0.0.1:3850",
      "tcp:127.0.0.1:3860",
      "tcp:10.1.2.3:22",
    ])
      expect(find(targets, name).expect).toBe("blocked");
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
