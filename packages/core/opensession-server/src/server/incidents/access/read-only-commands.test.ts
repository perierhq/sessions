import { expect, test } from "bun:test";
import { checkReadOnlyCommand } from "./read-only-commands";

test.each([
  ["cat", ["/var/log/app/error.log"], ["cat", "/var/log/app/error.log"]],
  [
    "tail",
    ["-n", "200", "/var/log/app/error.log"],
    ["tail", "-n", "200", "/var/log/app/error.log"],
  ],
  [
    "journalctl",
    ["-u", "app", "--since", "-1h"],
    ["journalctl", "-u", "app", "--since", "-1h", "--no-pager"],
  ],
  [
    "systemctl",
    ["status", "app"],
    ["systemctl", "status", "app", "--no-pager"],
  ],
  [
    "docker",
    ["logs", "--tail", "100", "app"],
    ["docker", "logs", "--tail", "100", "app"],
  ],
  ["docker", ["stats"], ["docker", "stats", "--no-stream"]],
  ["docker", ["compose", "ps"], ["docker", "compose", "ps"]],
  ["ps", ["aux"], ["ps", "aux"]],
  [
    "grep",
    ["-c", "403", "/var/log/app/access.log; rm -rf /"],
    ["grep", "-c", "403", "/var/log/app/access.log; rm -rf /"],
  ],
])("allows %s %j", (program, args, argv) => {
  expect(checkReadOnlyCommand(program, args)).toEqual({ ok: true, argv });
});
test.each([
  ["rm", ["-rf", "/"], "not on the read-only list"],
  ["/bin/cat", ["x"], "not on the read-only list"],
  ["bash", ["-c", "id"], "not on the read-only list"],
  ["cat", ["/srv/app/.env"], "secret-shaped"],
  ["cat", ["/srv/app/.env.production"], "secret-shaped"],
  ["grep", ["-r", "KEY", "/home/deploy/.ssh"], "secret-shaped"],
  ["cat", ["/proc/1/environ"], "secret-shaped"],
  ["tail", ["-f", "/var/log/syslog"], "Following output"],
  ["journalctl", ["--vacuum-time=1s"], "not allowed"],
  ["systemctl", ["restart", "app"], "systemctl restart"],
  ["systemctl", ["cat", "app"], "systemctl cat"],
  ["docker", ["inspect", "app"], "docker inspect"],
  ["docker", ["exec", "app", "sh"], "docker exec"],
  ["docker", ["compose", "config"], "docker compose config"],
  ["docker", ["logs", "-f", "app"], "Following output"],
  ["ps", ["auxe"], "environment"],
  ["hostname", ["evil"], "hostname"],
  ["date", ["-s", "2020-01-01"], "date"],
  ["cat", ["a\nb"], "line breaks"],
  // Beyond the plan's table: clusters and flags that write or follow.
  ["tail", ["-fn", "10", "/var/log/syslog"], "Following output"],
  ["journalctl", ["--cursor-file=/tmp/c"], "not allowed"],
  ["ss", ["-K", "dst", "10.0.0.1"], "ss -K"],
  ["systemctl", ["show", "app"], "Environment"],
  ["docker", ["-H", "tcp://x", "ps"], "docker -H"],
  ["grep", ["KEY", "--file=/srv/.env"], "secret-shaped"],
  ["date", ["010100002020"], "date"],
])("refuses %s %j", (program, args, reason) => {
  const out = checkReadOnlyCommand(program, args);
  expect(out.ok).toBe(false);
  expect(!out.ok && out.reason).toContain(reason);
});
test("caps", () => {
  expect(
    checkReadOnlyCommand(
      "cat",
      Array.from({ length: 33 }, (_, i) => `f${i}`),
    ),
  ).toEqual({ ok: false, reason: "Too many arguments" });
  expect(checkReadOnlyCommand("cat", ["x".repeat(1025)])).toEqual({
    ok: false,
    reason: "Argument too long",
  });
});
test("systemctl show is allowed for named properties other than the environment", () => {
  expect(
    checkReadOnlyCommand("systemctl", ["show", "-p", "ActiveState", "app"]),
  ).toEqual({
    ok: true,
    argv: ["systemctl", "show", "-p", "ActiveState", "app", "--no-pager"],
  });
  expect(
    checkReadOnlyCommand("systemctl", [
      "show",
      "--property=ActiveState,Environment",
      "app",
    ]).ok,
  ).toBe(false);
});
