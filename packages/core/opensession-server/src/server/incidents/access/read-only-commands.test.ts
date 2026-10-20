import { expect, test } from "bun:test";
import {
  GREP_SECRET_DIR_GLOBS,
  GREP_SECRET_FILE_GLOBS,
  checkReadOnlyCommand,
} from "./read-only-commands";

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

// Recursive grep runs only with secret-shaped files and directories excluded,
// and the caller cannot override the exclusions.
const forced = [
  ...GREP_SECRET_FILE_GLOBS.map((g) => `--exclude=${g}`),
  ...GREP_SECRET_DIR_GLOBS.map((g) => `--exclude-dir=${g}`),
];
test.each([
  [["-r", "KEY", "/srv/app"], ["-r"], ["KEY", "/srv/app"]],
  [["-rn", "KEY", "/srv/app"], ["-rn"], ["KEY", "/srv/app"]],
  [
    ["--recursive", "-e", "KEY", "/srv"],
    ["--recursive", "-e", "KEY"],
    ["/srv"],
  ],
  [["--recur", "KEY", "/srv"], ["--recur"], ["KEY", "/srv"]],
  [
    ["-d", "recurse", "KEY", "/srv"],
    ["-d", "recurse"],
    ["KEY", "/srv"],
  ],
  [["--directories=recurse", "KEY"], ["--directories=recurse"], ["KEY"]],
  [["KEY", "-r", "/srv"], ["-r"], ["KEY", "/srv"]],
  [["-r", "--", "-KEY", "/srv"], ["-r"], ["-KEY", "/srv"]],
  [
    ["-ri", "--include=*.log", "KEY", "/srv"],
    ["-ri", "--include=*.log"],
    ["KEY", "/srv"],
  ],
])("recursive grep %j gets forced exclusions", (args, options, operands) => {
  expect(checkReadOnlyCommand("grep", args)).toEqual({
    ok: true,
    argv: ["grep", ...options, ...forced, "--", ...operands],
  });
});
test("the forced exclusions cover the secret-shaped names", () => {
  for (const glob of [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_*",
    ".git-credentials",
    "credentials",
    "credentials.*",
  ])
    expect(GREP_SECRET_FILE_GLOBS).toContain(glob);
  for (const dir of [".git", ".ssh"])
    expect(GREP_SECRET_DIR_GLOBS).toContain(dir);
});
test.each([
  [["-R", "KEY", "/srv"], "Following links"],
  [["-Rn", "KEY", "/srv"], "Following links"],
  [["--dereference-recursive", "KEY", "/srv"], "Following links"],
  [["--deref", "KEY", "/srv"], "Following links"],
  [["-rS", "KEY", "/srv"], "Following links"],
  [["-r", "--include=.env*", "KEY", "/srv"], "secret-shaped"],
  [["-r", "--include", "*.yaml", "KEY", "/srv"], "secret-shaped"],
  [["-r", "--incl=id_*", "KEY", "/srv"], "secret-shaped"],
  [["-r", "--include=*", "KEY", "/srv"], "secret-shaped"],
  [["--include=credentials*", "KEY", "/srv/a.log"], "secret-shaped"],
  [["-r", "--frobnicate", "KEY", "/srv"], "grep --frobnicate is not allowed"],
  [["-r", "-e"], "grep -e needs a value"],
])("refuses grep %j", (args, reason) => {
  const out = checkReadOnlyCommand("grep", args);
  expect(out.ok).toBe(false);
  expect(!out.ok && out.reason).toContain(reason);
});
test("a pattern that only looks like a flag does not make grep recursive", () => {
  expect(
    checkReadOnlyCommand("grep", ["-e", "-r", "/var/log/app.log"]),
  ).toEqual({
    ok: true,
    argv: ["grep", "-e", "-r", "/var/log/app.log"],
  });
  expect(checkReadOnlyCommand("grep", ["-eRROR", "/var/log/app.log"])).toEqual({
    ok: true,
    argv: ["grep", "-eRROR", "/var/log/app.log"],
  });
});
