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
  ["systemctl", ["show", "app"], "naming only ActiveState"],
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
test("systemctl show allows only listed status properties", () => {
  expect(
    checkReadOnlyCommand("systemctl", [
      "show",
      "--property=ActiveState,SubState,LoadState,MainPID,NRestarts,Result",
      "-p",
      "ActiveEnterTimestamp,ExecMainStatus,MemoryCurrent,CPUUsageNSec",
      "app",
    ]).ok,
  ).toBe(true);
  expect(
    checkReadOnlyCommand("systemctl", ["show", "-P", "MainPID", "app"]).ok,
  ).toBe(true);
  for (const props of [
    "ExecStart",
    "LoadCredential",
    "SetCredential",
    "EnvironmentFiles",
    "ActiveState,ExecStartPre",
    "activestate",
    "ActiveState,",
  ]) {
    const out = checkReadOnlyCommand("systemctl", [
      "show",
      `--property=${props}`,
      "app",
    ]);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain("ActiveState");
  }
  expect(
    checkReadOnlyCommand("systemctl", ["show", "-P", "ExecStart", "app"]).ok,
  ).toBe(false);
  expect(checkReadOnlyCommand("systemctl", ["show", "app"]).ok).toBe(false);
});
test("docker logs --details is refused", () => {
  expect(checkReadOnlyCommand("docker", ["logs", "--details", "app"])).toEqual({
    ok: false,
    reason: "docker logs --details is not allowed",
  });
  expect(
    checkReadOnlyCommand("docker", ["logs", "--tail", "50", "app"]).ok,
  ).toBe(true);
});
test("systemctl show is allowed for listed properties, never the environment", () => {
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
  [
    ["-d", "recurse", "KEY", "/srv"],
    ["-d", "recurse"],
    ["KEY", "/srv"],
  ],
  [
    ["--directories=recurse", "KEY", "/srv"],
    ["--directories=recurse"],
    ["KEY", "/srv"],
  ],
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
  [["--deref", "KEY", "/srv"], "grep --deref is not allowed"],
  [["-rS", "KEY", "/srv"], "Following links"],
  [["-r", "--include=.env*", "KEY", "/srv"], "secret-shaped"],
  [["-r", "--include", "*.yaml", "KEY", "/srv"], "secret-shaped"],
  [["-r", "--incl=id_*", "KEY", "/srv"], "grep --incl is not allowed"],
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

// Options are an exact allowlist per program: GNU getopt would expand an
// unambiguous prefix (`--foll` is `--follow`), so a prefix is refused rather
// than resolved, and every short letter of a cluster must be allowed.
test.each([
  ["systemctl", ["-p", "status", "restart", "app"]],
  ["systemctl", ["--no-pager", "status", "app"]],
  ["systemctl", ["-H", "prod", "status", "app"]],
  ["systemctl", ["status", "-H", "prod", "app"]],
  ["systemctl", ["status", "--host=prod", "app"]],
  ["systemctl", ["status", "-M", "box", "app"]],
  ["systemctl", ["status", "--machine", "box", "app"]],
  ["systemctl", ["status", "--root=/mnt", "app"]],
  ["systemctl", ["list-units", "--image=/tmp/img"]],
  ["systemctl", ["show", "-p", "MainPID", "--prop=Environment", "app"]],
  ["systemctl", ["show", "-p", "MainPID", "-pEnvironment", "app"]],
  ["systemctl", ["show", "-pMainPID,Environment", "app"]],
  ["systemctl", ["show", "-P", "Environment", "app"]],
  ["systemctl", ["status", "-r", "app"]],
  ["tail", ["--f", "/var/log/syslog"]],
  ["tail", ["--fo", "/var/log/syslog"]],
  ["tail", ["--re", "/var/log/syslog"]],
  ["tail", ["--follow=name", "/var/log/syslog"]],
  ["tail", ["-qF", "/var/log/syslog"]],
  ["tail", ["-s", "1", "/var/log/syslog"]],
  ["tail", ["--pid=1", "/var/log/syslog"]],
  ["journalctl", ["--foll"]],
  ["journalctl", ["--rot"]],
  ["journalctl", ["--cursor-f=x"]],
  ["journalctl", ["-u", "app", "-ef"]],
  ["journalctl", ["--vac=1s"]],
  ["journalctl", ["-M", "box"]],
  ["journalctl", ["--directory=/tmp/j"]],
  ["journalctl", ["--file=/tmp/j.journal"]],
  ["date", ["--se=2020-01-01"]],
  ["date", ["--set=2020-01-01"]],
  ["date", ["-us", "2020-01-01"]],
  ["date", ["--file=/tmp/dates"]],
  ["ss", ["--ki"]],
  ["ss", ["-tK"]],
  ["ss", ["-D", "/tmp/dump"]],
  ["ss", ["-F", "/tmp/filter"]],
  ["ss", ["-N", "other"]],
  ["ss", ["-E"]],
  ["cat", ["-X", "/var/log/a.log"]],
  ["cat", ["--number-non", "/var/log/a.log"]],
  ["head", ["--lin=5", "/var/log/a.log"]],
  ["ls", ["--hel"]],
  ["du", ["--files0-from=/tmp/list"]],
  ["du", ["--files0-from", "/tmp/list"]],
  ["du", ["-X", "/tmp/patterns", "/var/log"]],
  ["wc", ["--files0-from=/tmp/list"]],
  ["free", ["-s", "1"]],
  ["free", ["-c", "5"]],
  ["uname", ["-a", "x"]],
  ["uptime", ["--sin"]],
  ["hostname", ["-F", "/tmp/name"]],
  ["hostname", ["-b"]],
  ["hostname", ["--fq"]],
  ["ps", ["axe"]],
  ["ps", ["-ef", "e"]],
  ["ps", ["--for", "pid"]],
  ["ps", ["-o", "pid,environ"]],
  ["docker", ["logs", "--follow=true", "app"]],
  ["docker", ["logs", "-tf", "app"]],
  ["docker", ["logs", "--foll", "app"]],
  ["docker", ["ps", "--context", "other"]],
  ["docker", ["top", "app", "eww"]],
  ["docker", ["top", "app", "-e"]],
  ["docker", ["info", "--config", "/tmp/c"]],
  ["docker", ["compose", "logs", "-f"]],
  ["docker", ["compose", "ps", "--project-directory", "/srv"]],
  ["grep", ["--recur", "KEY", "/srv"]],
  ["grep", ["--incl=*.log", "KEY", "/srv/a.log"]],
  ["grep", ["-f", "/tmp/patterns", "/srv/a.log"]],
  ["grep", ["--file=/tmp/patterns", "/srv/a.log"]],
  ["grep", ["-rL", "KEY", "/srv"]],
  ["grep", ["-X", "KEY", "/srv/a.log"]],
])("refuses options outside the allowlist: %s %j", (program, args) => {
  expect(checkReadOnlyCommand(program, args).ok).toBe(false);
});

test.each([
  [
    "systemctl",
    ["show", "-p", "MainPID", "--property=ActiveState", "app"],
    [
      "systemctl",
      "show",
      "-p",
      "MainPID",
      "--property=ActiveState",
      "app",
      "--no-pager",
    ],
  ],
  [
    "systemctl",
    ["status", "--no-pager", "-n", "20", "app"],
    ["systemctl", "status", "--no-pager", "-n", "20", "app"],
  ],
  [
    "systemctl",
    ["list-units", "--all", "--type=service"],
    ["systemctl", "list-units", "--all", "--type=service", "--no-pager"],
  ],
  ["tail", ["-n200", "/var/log/a.log"], ["tail", "-n200", "/var/log/a.log"]],
  ["tail", ["-50", "/var/log/a.log"], ["tail", "-50", "/var/log/a.log"]],
  [
    "tail",
    ["--lines=5", "-q", "/var/log/a.log"],
    ["tail", "--lines=5", "-q", "/var/log/a.log"],
  ],
  // -n takes the next word as its value, even one that looks like a flag.
  [
    "tail",
    ["-n", "-f", "/var/log/a.log"],
    ["tail", "-n", "-f", "/var/log/a.log"],
  ],
  [
    "head",
    ["-c", "100", "/var/log/a.log"],
    ["head", "-c", "100", "/var/log/a.log"],
  ],
  ["cat", ["-An", "/var/log/a.log"], ["cat", "-An", "/var/log/a.log"]],
  [
    "ls",
    ["-lah", "--sort=time", "/var/log"],
    ["ls", "-lah", "--sort=time", "/var/log"],
  ],
  [
    "du",
    ["-sh", "--max-depth=1", "/var/log"],
    ["du", "-sh", "--max-depth=1", "/var/log"],
  ],
  ["df", ["-hT"], ["df", "-hT"]],
  ["free", ["-m"], ["free", "-m"]],
  ["uname", ["-a"], ["uname", "-a"]],
  ["uptime", ["-p"], ["uptime", "-p"]],
  ["hostname", ["-f"], ["hostname", "-f"]],
  ["date", ["-u", "+%s"], ["date", "-u", "+%s"]],
  [
    "date",
    ["--date=@0", "--iso-8601=seconds"],
    ["date", "--date=@0", "--iso-8601=seconds"],
  ],
  ["ps", ["-eo", "pid,comm,args"], ["ps", "-eo", "pid,comm,args"]],
  ["ps", ["aux", "--sort=-pcpu"], ["ps", "aux", "--sort=-pcpu"]],
  ["ps", ["-ef"], ["ps", "-ef"]],
  [
    "ss",
    ["-tlnp", "state", "listening"],
    ["ss", "-tlnp", "state", "listening"],
  ],
  [
    "journalctl",
    ["-u", "app", "-n", "50", "-p", "err"],
    ["journalctl", "-u", "app", "-n", "50", "-p", "err", "--no-pager"],
  ],
  [
    "journalctl",
    ["--unit=app", "--lines=50", "-o", "json"],
    ["journalctl", "--unit=app", "--lines=50", "-o", "json", "--no-pager"],
  ],
  [
    "docker",
    ["logs", "-n", "50", "-t", "app"],
    ["docker", "logs", "-n", "50", "-t", "app"],
  ],
  [
    "docker",
    ["ps", "-a", "--format", "{{.Names}}"],
    ["docker", "ps", "-a", "--format", "{{.Names}}"],
  ],
  ["docker", ["top", "app"], ["docker", "top", "app"]],
  [
    "docker",
    ["compose", "logs", "--tail", "20", "web"],
    ["docker", "compose", "logs", "--tail", "20", "web"],
  ],
  [
    "grep",
    ["-in", "--color=never", "ERROR", "/var/log/a.log"],
    ["grep", "-in", "--color=never", "ERROR", "/var/log/a.log"],
  ],
])("allows listed options: %s %j", (program, args, argv) => {
  expect(checkReadOnlyCommand(program, args)).toEqual({ ok: true, argv });
});

test("refusals name the option that was refused", () => {
  expect(checkReadOnlyCommand("tail", ["--f", "/var/log/a"])).toEqual({
    ok: false,
    reason: "tail --f is not allowed",
  });
  expect(checkReadOnlyCommand("cat", ["-nX", "/var/log/a"])).toEqual({
    ok: false,
    reason: "cat -X is not allowed",
  });
  expect(checkReadOnlyCommand("tail", ["-n"])).toEqual({
    ok: false,
    reason: "tail -n needs a value",
  });
  expect(checkReadOnlyCommand("cat", ["--number=3", "/var/log/a"])).toEqual({
    ok: false,
    reason: "cat --number takes no value",
  });
  expect(checkReadOnlyCommand("systemctl", ["--no-pager", "status"])).toEqual({
    ok: false,
    reason: "systemctl needs its subcommand first",
  });
});

// Secret-shaped paths, after the path is normalised (`.`, `//`, `..`), for
// every program, in operands and in option values alike.
test.each([
  ["cat", ["/etc//shadow"]],
  ["cat", ["/etc/./shadow"]],
  ["cat", ["//etc/gshadow"]],
  ["cat", ["/etc/ssl/../shadow"]],
  ["cat", ["/proc/self/./environ"]],
  ["cat", ["/proc//1//environ"]],
  ["cat", ["/proc/1/task/../environ"]],
  ["cat", ["/proc/self/environ"]],
  ["cat", ["/proc/thread-self/environ"]],
  ["cat", ["/proc/1/task/12/environ"]],
  ["cat", ["/proc/self/task/12/environ"]],
  ["cat", ["/proc/1/mem"]],
  ["cat", ["/proc/self/fd/3"]],
  ["ls", ["/proc/1/map_files"]],
  ["cat", ["proc/1/environ"]],
  ["cat", ["/etc/systemd/system/app.service"]],
  ["cat", ["/etc/systemd/system/app.service.d/override.conf"]],
  ["ls", ["/etc/systemd/system"]],
  ["cat", ["etc/systemd/system/app.service"]],
  ["cat", ["/etc/systemd/./system/app.service"]],
  ["cat", ["/run/systemd/transient/app.service"]],
  ["cat", ["/run/credentials/app.service/token"]],
  ["cat", ["/var/run/credentials/app.service/token"]],
  ["cat", ["/var/lib/docker/containers/abc/config.v2.json"]],
  ["ls", ["/var/lib/docker"]],
  ["cat", ["~/.docker/config.json"]],
  ["cat", ["/root/.docker/config.json"]],
  ["ls", ["/root/.docker"]],
  ["cat", ["/home/deploy/.kube/config"]],
  ["cat", ["~/.kube/cache/discovery"]],
  ["ls", ["/root/.kube"]],
  ["cat", ["/home/deploy/.aws/credentials"]],
  ["date", ["-r.env"]],
  ["date", ["--reference=/etc//shadow"]],
  ["stat", ["-c", "%n", "/etc//shadow"]],
  ["journalctl", ["--since", "/proc/1/../1/environ"]],
  ["du", ["--files0-from=/tmp/list"]],
  ["wc", ["--files0-from=-"]],
])("refuses the secret-shaped path %s %j", (program, args) => {
  const out = checkReadOnlyCommand(program, args);
  expect(out.ok).toBe(false);
});
// Sessions' own state, raw devices and memory, firmware tables, and the
// other files that hold an environment or a token.
test.each([
  ["cat", ["/home/deploy/.opensession/state.json"]],
  ["ls", ["/home/deploy/.opensession"]],
  ["cat", ["/home/deploy/.opensession-dev/keychain.json"]],
  ["cat", [".opensession/deploy/current"]],
  ["cat", ["/srv/app/../../home/deploy/.opensession/x"]],
  ["grep", ["KEY", "--file=/root/.opensession/auth.json"]],
  ["cat", ["/dev/sda"]],
  ["cat", ["/dev/mem"]],
  ["head", ["-c", "64", "/dev/nvme0n1"]],
  ["cat", ["/dev/stdin"]],
  ["cat", ["/dev/shm/app.lock"]],
  ["cat", ["dev/sda"]],
  ["cat", ["//dev/sda"]],
  ["cat", ["/tmp/../dev/sda"]],
  ["cat", ["../../../dev/sda"]],
  ["date", ["--reference=/dev/sda"]],
  ["cat", ["/proc/kcore"]],
  ["cat", ["/proc/./kcore"]],
  ["ls", ["/sys/firmware"]],
  ["cat", ["/sys/firmware/acpi/tables/MSDM"]],
  ["cat", ["/sys/firmware/efi/efivars/x"]],
  ["cat", ["/srv/app/.envrc"]],
  ["cat", ["/srv/app/.env-production"]],
  ["cat", ["/srv/app/.env-local"]],
  ["cat", ["/etc/environment"]],
  ["cat", ["etc/environment"]],
  ["cat", ["/home/deploy/.config/gh/hosts.yml"]],
  ["cat", ["~/.config/gh/hosts.yml"]],
])(
  "refuses Sessions' state, devices and environment files: %s %j",
  (program, args) => {
    expect(checkReadOnlyCommand(program, args)).toEqual({
      ok: false,
      reason: "Reading secret-shaped files is not allowed",
    });
  },
);
test("/dev/null stays usable", () => {
  expect(checkReadOnlyCommand("cat", ["/dev/null"])).toEqual({
    ok: true,
    argv: ["cat", "/dev/null"],
  });
});
test("recursive grep skips Sessions' state and may not cover /dev", () => {
  expect(GREP_SECRET_DIR_GLOBS).toContain(".opensession*");
  for (const glob of [".envrc", ".env-*"])
    expect(GREP_SECRET_FILE_GLOBS).toContain(glob);
  for (const path of ["/dev", "/dev/disk", "/sys", "/sys/firmware/acpi"]) {
    const out = checkReadOnlyCommand("grep", ["-r", "KEY", path]);
    expect(out.ok).toBe(false);
  }
  expect(
    checkReadOnlyCommand("grep", ["-r", "--include=.envrc", "KEY", "/srv"]),
  ).toMatchObject({ ok: false });
});
test("paths that only look close stay readable", () => {
  for (const path of [
    "/var/log/systemd.log",
    "/etc/systemd/journald.conf",
    "/proc/loadavg",
    "/proc/1/status",
    "/var/lib/dockerd.log",
    "/srv/app/dev/notes.txt",
    "/srv/opensession.log",
    "/etc/environment.d.txt",
    "/srv/app/.environment-notes",
  ])
    expect(checkReadOnlyCommand("cat", [path])).toEqual({
      ok: true,
      argv: ["cat", path],
    });
});

// Recursive grep in every spelling goes through the forced exclusions, and
// only over absolute paths that do not contain a secret tree.
test.each([
  [["-ri", "KEY", "/srv/app"], ["-ri"], ["KEY", "/srv/app"]],
  [["-ir", "KEY", "/srv/app"], ["-ir"], ["KEY", "/srv/app"]],
  [["-nri", "KEY", "/srv/app"], ["-nri"], ["KEY", "/srv/app"]],
  [["-drecurse", "KEY", "/srv"], ["-drecurse"], ["KEY", "/srv"]],
  [
    ["--directories", "recurse", "KEY", "/srv"],
    ["--directories", "recurse"],
    ["KEY", "/srv"],
  ],
  [
    ["--directories=rec", "KEY", "/srv"],
    ["--directories=rec"],
    ["KEY", "/srv"],
  ],
  [
    ["-r", "-e", "KEY", "/srv", "/var/log"],
    ["-r", "-e", "KEY"],
    ["/srv", "/var/log"],
  ],
  [["-r", "KEY", "/srv/app/.."], ["-r"], ["KEY", "/srv/app/.."]],
])(
  "recursive grep spelling %j gets forced exclusions",
  (args, options, operands) => {
    expect(checkReadOnlyCommand("grep", args)).toEqual({
      ok: true,
      argv: ["grep", ...options, ...forced, "--", ...operands],
    });
  },
);
test("the forced exclusions skip systemd unit trees reached through a link", () => {
  expect(GREP_SECRET_DIR_GLOBS).toContain("systemd");
});
test.each([
  [["-r", "KEY"], "absolute paths"],
  [["-r", "KEY", "."], "absolute paths"],
  [["-r", "KEY", "srv/app"], "absolute paths"],
  [["-r", "-e", "KEY"], "absolute paths"],
  [["-r", "KEY", "/"], "may not cover"],
  [["-r", "KEY", "/etc"], "may not cover /etc/systemd/system"],
  [["-r", "KEY", "/etc/systemd"], "may not cover"],
  [["-r", "KEY", "/run"], "may not cover"],
  [["-r", "KEY", "/var/run"], "may not cover"],
  [["-r", "KEY", "/var"], "may not cover /var/lib/docker"],
  [["-r", "KEY", "/var/lib"], "may not cover"],
  [["-r", "KEY", "/srv/../etc"], "may not cover"],
  [["-r", "KEY", "//"], "may not cover"],
  [["-r", "KEY", "/proc/1"], "may not cover /proc"],
  [["-r", "KEY", "/srv", "/etc"], "may not cover"],
  [["-d", "recurse", "KEY", "/var"], "may not cover"],
  [["-r", "--include=*.env", "KEY", "/srv"], "secret-shaped"],
  [["-r", "--include=.git-credentials", "KEY", "/srv"], "secret-shaped"],
  [["-r", "--include", "id_rsa", "KEY", "/srv"], "secret-shaped"],
  [["-rL", "KEY", "/srv"], "grep -L is not allowed"],
  [["-r", "--dereference-recursive", "KEY", "/srv"], "Following links"],
])("refuses recursive grep %j", (args, reason) => {
  const out = checkReadOnlyCommand("grep", args);
  expect(out.ok).toBe(false);
  expect(!out.ok && out.reason).toContain(reason);
});
test("rg is not on the list in any spelling", () => {
  for (const args of [
    ["-r", "KEY", "/srv"],
    ["KEY", "/srv"],
    ["-L", "KEY"],
  ])
    expect(checkReadOnlyCommand("rg", args).ok).toBe(false);
});
