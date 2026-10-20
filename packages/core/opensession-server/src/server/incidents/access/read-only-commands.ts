// The read-only host commands incident agents may run on a granted host.
// A command is an argv, never a shell string: the caller quotes every word,
// so `;`, `|`, `$(...)` and backticks are inert data. This table decides
// which programs may run and, per program, the exact options each may take.
// Runner hosts run commands as the Runner's own user, so the list is defence
// in depth, not isolation.
// Recursive grep runs with secret-shaped files and directories excluded, and
// only over absolute paths that contain no secret tree.

import { posix } from "node:path";

export const READ_ONLY_PROGRAMS: readonly string[] = [
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "stat",
  "du",
  "df",
  "free",
  "uptime",
  "uname",
  "hostname",
  "date",
  "ps",
  "ss",
  "grep",
  "journalctl",
  "systemctl",
  "docker",
];

export const MAX_HOST_ARGS = 32;
export const MAX_HOST_ARG_CHARS = 1024;
export const MAX_HOST_ARGS_TOTAL = 4096;

export type ReadOnlyCheck =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

// Secret-shaped paths. `=` counts as a boundary too, so `--file=/srv/.env` is
// caught, and a path without its leading slash (`etc/...`, read from a `/`
// working directory) is caught like the absolute one.
const SECRET_PATHS: readonly RegExp[] = [
  // `.env`, `.env.production`, `.env-local` and `.envrc`.
  /(^|[/=])\.env(\.|-|rc$|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|[/=])id_(rsa|dsa|ecdsa|ed25519)/i,
  // Key and token stores in a home directory (`~/.docker/config.json`,
  // `/root/.kube/config`, ...).
  /(^|[/=])\.(ssh|gnupg|aws|kube|docker|password-store)(\/|$)/i,
  /(^|[/=])etc\/(shadow|gshadow|sudoers)/i,
  // Any process's environment, memory and open files: /proc/<pid>, self,
  // thread-self and task/<tid> alike.
  /(^|[/=])proc\/(.*\/)?(environ|mem|fd|fdinfo|map_files)(\/|$)/i,
  // Unit files and drop-ins carry Environment= lines; /run holds transient
  // units and systemd credentials; /var/lib/docker holds container configs
  // with their environment.
  /(^|[/=])etc\/systemd\/system(\/|$)/i,
  /(^|[/=])(var\/)?run\/(systemd|credentials)(\/|$)/i,
  /(^|[/=])var\/lib\/docker(\/|$)/i,
  /(^|[/=])\.(netrc|pgpass|npmrc|git-credentials)$/i,
  /(^|[/=])(credentials|secrets?)(\.|\/|$)/i,
  // Sessions' own state (`~/.opensession`, `~/.opensession-dev`, ...).
  /(^|[/=])\.opensession[^/]*(\/|$)/i,
  // Raw devices, except /dev/null. Anchored at the root (or a run of `..`
  // from an unknown working directory), so a project's own `dev/` stays
  // readable.
  /(^|=)(\/|(\.\.\/)+)?dev\/(?!null$)/,
  // Kernel memory and firmware tables.
  /(^|[/=])proc\/kcore$/i,
  /(^|[/=])sys\/firmware(\/|$)/i,
  // System-wide environment, and the GitHub CLI's token file.
  /(^|[/=])etc\/environment(\.d)?(\/|$)/i,
  /(^|[/=])\.config\/gh\/hosts\.ya?ml$/i,
];

const SECRET_FILES = "Reading secret-shaped files is not allowed";

/** The word as given, normalised (`.`, `//`, `..`), and the value after
 *  `=` normalised on its own. */
function pathForms(word: string): string[] {
  const forms = [word, posix.normalize(word)];
  const eq = word.indexOf("=");
  if (eq >= 0 && eq + 1 < word.length)
    forms.push(posix.normalize(word.slice(eq + 1)));
  return forms;
}

function secretShaped(word: string): boolean {
  return pathForms(word).some((form) =>
    SECRET_PATHS.some((re) => re.test(form)),
  );
}

const FOLLOWING = "Following output is not allowed";

const refuse = (reason: string): ReadOnlyCheck => ({ ok: false, reason });

// Options are an exact allowlist per program. GNU getopt expands any
// unambiguous prefix of a long option (`--foll` is `--follow`), so a name is
// compared whole and anything not listed is refused, never resolved. Short
// clusters are read letter by letter the way getopt reads them: a letter that
// takes a value ends the cluster, and takes the next word when the cluster
// ends with it. `optional` values ride only on the same word (`-n5`,
// `--lines=5`), as getopt reads optional arguments.
type Arity = "flag" | "value" | "optional";

interface OptionTable {
  short: Record<string, Arity>;
  long: Record<string, Arity>;
  /** Refusals with a specific reason (by letter or long name). */
  refused?: Record<string, string>;
  /** A bare `-NUM` (head and tail line counts). */
  numeric?: boolean;
}

interface ParsedOption {
  name: string;
  value?: string;
}

interface ParsedArgs {
  options: ParsedOption[];
  /** The option words as given, values included, in order. */
  optionWords: string[];
  operands: string[];
}

type ParseResult = ParsedArgs | { error: string };

const isParseError = (r: ParseResult): r is { error: string } => "error" in r;

const flags = (letters: string): Record<string, Arity> =>
  Object.fromEntries([...letters].map((ch) => [ch, "flag" as const]));
const values = (letters: string): Record<string, Arity> =>
  Object.fromEntries([...letters].map((ch) => [ch, "value" as const]));
const longFlags = (names: string[]): Record<string, Arity> =>
  Object.fromEntries(names.map((n) => [n, "flag" as const]));
const longValues = (names: string[]): Record<string, Arity> =>
  Object.fromEntries(names.map((n) => [n, "value" as const]));

function parseArgs(
  program: string,
  args: string[],
  table: OptionTable,
): ParseResult {
  const options: ParsedOption[] = [];
  const optionWords: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const reason = table.refused?.[`--${name}`];
      if (reason) return { error: reason };
      const arity = Object.hasOwn(table.long, name)
        ? table.long[name]
        : undefined;
      if (!arity) return { error: `${program} --${name} is not allowed` };
      optionWords.push(a);
      if (arity === "flag") {
        if (eq >= 0) return { error: `${program} --${name} takes no value` };
        options.push({ name });
      } else if (eq >= 0) options.push({ name, value: a.slice(eq + 1) });
      else if (arity === "optional") options.push({ name });
      else {
        if (i + 1 >= args.length)
          return { error: `${program} --${name} needs a value` };
        const value = args[++i];
        optionWords.push(value);
        options.push({ name, value });
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (table.numeric && /^-\d+$/.test(a)) {
        optionWords.push(a);
        options.push({ name: "#", value: a.slice(1) });
        continue;
      }
      optionWords.push(a);
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        const reason = table.refused?.[`-${ch}`];
        if (reason) return { error: reason };
        const arity = Object.hasOwn(table.short, ch)
          ? table.short[ch]
          : undefined;
        if (!arity) return { error: `${program} -${ch} is not allowed` };
        if (arity === "flag") {
          options.push({ name: ch });
          continue;
        }
        const rest = a.slice(j + 1);
        if (rest) options.push({ name: ch, value: rest });
        else if (arity === "optional") options.push({ name: ch });
        else {
          if (i + 1 >= args.length)
            return { error: `${program} -${ch} needs a value` };
          const value = args[++i];
          optionWords.push(value);
          options.push({ name: ch, value });
        }
        break;
      }
      continue;
    }
    operands.push(a);
  }
  // A value glued to its option (`-r.env`) is a path of its own.
  for (const o of options)
    if (o.value !== undefined && secretShaped(o.value))
      return { error: SECRET_FILES };
  return { options, optionWords, operands };
}

const has = (parsed: ParsedArgs, ...names: string[]): boolean =>
  parsed.options.some((o) => names.includes(o.name));

const withFlag = (args: string[], flag: string): string[] =>
  args.includes(flag) ? args : [...args, flag];

function checked(
  program: string,
  args: string[],
  table: OptionTable,
  more?: (parsed: ParsedArgs) => ReadOnlyCheck | null,
): ReadOnlyCheck {
  const parsed = parseArgs(program, args, table);
  if (isParseError(parsed)) return refuse(parsed.error);
  return more?.(parsed) ?? { ok: true, argv: [program, ...args] };
}

const noOperands =
  (program: string) =>
  (parsed: ParsedArgs): ReadOnlyCheck | null =>
    parsed.operands.length
      ? refuse(`${program} ${parsed.operands[0]} is not allowed`)
      : null;

const CAT: OptionTable = {
  short: flags("AbeEnstTuv"),
  long: longFlags([
    "show-all",
    "number-nonblank",
    "show-ends",
    "number",
    "squeeze-blank",
    "show-tabs",
    "show-nonprinting",
  ]),
};

const HEAD_TAIL_LONG = {
  ...longValues(["bytes", "lines"]),
  ...longFlags(["quiet", "silent", "verbose", "zero-terminated"]),
};

const HEAD: OptionTable = {
  short: { ...values("cn"), ...flags("qvz") },
  long: HEAD_TAIL_LONG,
  numeric: true,
};

// No -f, -F, -s, --follow, --retry, --pid or --sleep-interval: they follow.
const TAIL: OptionTable = {
  short: { ...values("cn"), ...flags("qvz") },
  long: HEAD_TAIL_LONG,
  refused: {
    "-f": FOLLOWING,
    "-F": FOLLOWING,
    "--follow": FOLLOWING,
    "--retry": FOLLOWING,
  },
  numeric: true,
};

// No --files0-from: it names the files to read from inside another file.
const WC: OptionTable = {
  short: flags("cmlLw"),
  long: {
    ...longFlags(["bytes", "chars", "lines", "max-line-length", "words"]),
    total: "value",
  },
};

const LS: OptionTable = {
  short: {
    ...flags("aAbBcCdDfFgGhHiklLmnNopqQrRsStuUvxXZ1"),
    ...values("wTI"),
  },
  long: {
    ...longFlags([
      "all",
      "almost-all",
      "author",
      "escape",
      "ignore-backups",
      "directory",
      "dired",
      "file-type",
      "full-time",
      "group-directories-first",
      "no-group",
      "human-readable",
      "si",
      "dereference-command-line",
      "dereference-command-line-symlink-to-dir",
      "inode",
      "kibibytes",
      "dereference",
      "numeric-uid-gid",
      "literal",
      "hide-control-chars",
      "show-control-chars",
      "quote-name",
      "reverse",
      "recursive",
      "size",
      "context",
      "zero",
    ]),
    ...longValues([
      "format",
      "hide",
      "indicator-style",
      "ignore",
      "quoting-style",
      "sort",
      "time",
      "time-style",
      "tabsize",
      "width",
      "block-size",
    ]),
    classify: "optional",
    color: "optional",
    hyperlink: "optional",
  },
};

const STAT: OptionTable = {
  short: { ...flags("Lft"), ...values("c") },
  long: {
    ...longFlags(["dereference", "file-system", "terse"]),
    ...longValues(["format", "printf", "cached"]),
  },
};

// No --files0-from and no -X/--exclude-from: both read another file.
const DU: OptionTable = {
  short: { ...flags("abchkmsxlLDPS0"), ...values("dBt") },
  long: {
    ...longFlags([
      "all",
      "apparent-size",
      "bytes",
      "total",
      "human-readable",
      "si",
      "summarize",
      "one-file-system",
      "count-links",
      "dereference",
      "dereference-args",
      "no-dereference",
      "separate-dirs",
      "null",
      "inodes",
    ]),
    ...longValues([
      "max-depth",
      "block-size",
      "threshold",
      "time-style",
      "exclude",
    ]),
    time: "optional",
  },
};

const DF: OptionTable = {
  short: { ...flags("ahHiklPT"), ...values("xtB") },
  long: {
    ...longFlags([
      "all",
      "human-readable",
      "si",
      "inodes",
      "local",
      "portability",
      "print-type",
      "total",
      "no-sync",
    ]),
    ...longValues(["type", "exclude-type", "block-size"]),
    output: "optional",
  },
};

// No -s/--seconds or -c/--count: they repeat.
const FREE: OptionTable = {
  short: flags("bkmghwtlv"),
  long: longFlags([
    "bytes",
    "kilo",
    "mega",
    "giga",
    "tera",
    "peta",
    "kibi",
    "mebi",
    "gibi",
    "tebi",
    "pebi",
    "human",
    "wide",
    "total",
    "lohi",
    "committed",
    "si",
  ]),
};

const UPTIME: OptionTable = {
  short: flags("ps"),
  long: longFlags(["pretty", "since"]),
};

const UNAME: OptionTable = {
  short: flags("asnrvmpio"),
  long: longFlags([
    "all",
    "kernel-name",
    "nodename",
    "kernel-release",
    "kernel-version",
    "machine",
    "processor",
    "hardware-platform",
    "operating-system",
  ]),
};

// Any operand, -b, -F and -y set the name.
const HOSTNAME: OptionTable = {
  short: flags("aAdfiIs"),
  long: longFlags([
    "alias",
    "all-fqdns",
    "domain",
    "fqdn",
    "long",
    "ip-address",
    "all-ip-addresses",
    "short",
  ]),
};

// -s/--set and a bare MMDDhhmm operand set the clock; -f reads a file.
const DATE: OptionTable = {
  short: { ...flags("uR"), ...values("dr"), I: "optional" },
  long: {
    ...longFlags(["utc", "universal", "rfc-email", "debug"]),
    ...longValues(["date", "rfc-3339", "reference"]),
    "iso-8601": "optional",
  },
};

// procps ps: UNIX options take a dash, BSD options do not, and BSD `e`
// prints every process's environment.
const PS_UNIX: OptionTable = {
  short: { ...flags("AadefFHjlLMNTwcyPZ"), ...values("oOpquUgGCst") },
  long: {
    ...longFlags([
      "forest",
      "headers",
      "no-headers",
      "cumulative",
      "deselect",
      "context",
    ]),
    ...longValues([
      "format",
      "sort",
      "pid",
      "ppid",
      "quick-pid",
      "user",
      "User",
      "group",
      "Group",
      "sid",
      "tty",
      "cols",
      "columns",
      "lines",
      "rows",
      "width",
    ]),
  },
};
const PS_BSD_LETTERS = "auxwfjlrmvSchHT";
const PS_FORMAT_OPTIONS = ["o", "O", "format"];

function checkPs(args: string[]): ReadOnlyCheck {
  const parsed = parseArgs("ps", args, PS_UNIX);
  if (isParseError(parsed)) return refuse(parsed.error);
  for (const o of parsed.options)
    if (PS_FORMAT_OPTIONS.includes(o.name) && /env/i.test(o.value ?? ""))
      return refuse("ps environment output is not allowed");
  // Words without a dash: a bare pid list, or a BSD option cluster.
  for (const word of parsed.operands) {
    if (/^\d+(,\d+)*$/.test(word)) continue;
    for (const ch of word) {
      if (ch === "e") return refuse("ps environment output is not allowed");
      if (!PS_BSD_LETTERS.includes(ch))
        return refuse(`ps ${ch} is not allowed`);
    }
  }
  return { ok: true, argv: ["ps", ...args] };
}

// No -K/--kill, -D/--diag (writes a file), -F/--filter (reads one),
// -N/--net (another namespace) or -E/--events (follows).
const SS: OptionTable = {
  short: { ...flags("alnrtuwxpeomis460HObMZz"), ...values("fA") },
  long: {
    ...longFlags([
      "all",
      "listening",
      "numeric",
      "resolve",
      "tcp",
      "udp",
      "raw",
      "unix",
      "packet",
      "processes",
      "extended",
      "options",
      "memory",
      "info",
      "summary",
      "ipv4",
      "ipv6",
      "no-header",
      "oneline",
      "context",
      "contexts",
    ]),
    ...longValues(["family", "query", "socket"]),
  },
};

// No -f/--follow; no --rotate, --flush, --sync, --vacuum-*, --setup-keys,
// --update-catalog, --relinquish-var or --cursor-file (they write); no -M,
// -D, -i, --root, --image or --namespace (another journal).
const JOURNALCTL: OptionTable = {
  short: {
    ...flags("aeklmqrxN"),
    ...values("utTpgSUoFc"),
    n: "optional",
    b: "optional",
  },
  long: {
    ...longFlags([
      "all",
      "pager-end",
      "dmesg",
      "full",
      "no-full",
      "reverse",
      "quiet",
      "merge",
      "utc",
      "catalog",
      "no-hostname",
      "no-pager",
      "list-boots",
      "fields",
      "show-cursor",
      "system",
      "user",
      "no-tail",
      "disk-usage",
    ]),
    ...longValues([
      "unit",
      "user-unit",
      "identifier",
      "exclude-identifier",
      "priority",
      "facility",
      "grep",
      "since",
      "until",
      "output",
      "output-fields",
      "field",
      "cursor",
      "after-cursor",
    ]),
    lines: "optional",
    boot: "optional",
    "case-sensitive": "optional",
  },
  refused: { "-f": FOLLOWING, "--follow": FOLLOWING },
};

const SYSTEMCTL_SUBCOMMANDS = [
  "status",
  "show",
  "is-active",
  "is-failed",
  "is-enabled",
  "list-units",
  "list-timers",
  "list-unit-files",
];

// The unit properties `systemctl show` may print: status and resource use.
// Others carry the command lines, environment and credentials of a unit
// (ExecStart, Environment, LoadCredential, ...).
export const SYSTEMCTL_SHOW_PROPERTIES: readonly string[] = [
  "ActiveState",
  "SubState",
  "LoadState",
  "MainPID",
  "NRestarts",
  "Result",
  "ActiveEnterTimestamp",
  "ExecMainStatus",
  "MemoryCurrent",
  "CPUUsageNSec",
];

// Options after the subcommand. No -H/--host, -M/--machine, --root or
// --image (another system), and no -r/--recursive (local containers).
const SYSTEMCTL: OptionTable = {
  short: { ...flags("alq"), ...values("pPtno") },
  long: {
    ...longFlags([
      "all",
      "full",
      "value",
      "quiet",
      "no-legend",
      "no-pager",
      "plain",
      "failed",
      "user",
      "system",
    ]),
    ...longValues(["property", "type", "state", "lines", "output"]),
  },
};

function checkSystemctl(args: string[]): ReadOnlyCheck {
  const sub = args[0];
  if (sub === undefined) return refuse("systemctl needs a subcommand");
  // getopt permutes: a verb after an option could be an option's value
  // (`-p status restart`), so the verb must come first.
  if (sub.startsWith("-"))
    return refuse("systemctl needs its subcommand first");
  if (!SYSTEMCTL_SUBCOMMANDS.includes(sub))
    return refuse(`systemctl ${sub} is not allowed`);
  const parsed = parseArgs("systemctl", args.slice(1), SYSTEMCTL);
  if (isParseError(parsed)) return refuse(parsed.error);
  if (sub === "show") {
    const props = parsed.options.flatMap((o) =>
      o.name === "p" || o.name === "property"
        ? (o.value ?? "").split(",")
        : o.name === "P"
          ? [o.value ?? ""]
          : [],
    );
    if (
      !props.length ||
      props.some((p) => !SYSTEMCTL_SHOW_PROPERTIES.includes(p))
    )
      return refuse(
        `systemctl show needs --property naming only ${SYSTEMCTL_SHOW_PROPERTIES.join(", ")}`,
      );
  }
  return { ok: true, argv: ["systemctl", ...withFlag(args, "--no-pager")] };
}

// docker subcommands and the options each may take after it. Global flags
// (-H, --context, --config) must not appear: the subcommand comes first.
// No `logs --details`: it adds the container's log attributes, which can
// carry its environment.
const DOCKER_LOGS: OptionTable = {
  short: { ...flags("t"), ...values("n") },
  long: {
    ...longFlags(["timestamps"]),
    ...longValues(["since", "until", "tail"]),
  },
  refused: { "-f": FOLLOWING, "--follow": FOLLOWING },
};
const DOCKER_SUBCOMMANDS: Record<string, OptionTable> = {
  ps: {
    short: { ...flags("alqs"), ...values("fn") },
    long: {
      ...longFlags(["all", "latest", "no-trunc", "quiet", "size"]),
      ...longValues(["filter", "format", "last"]),
    },
  },
  logs: DOCKER_LOGS,
  stats: {
    short: flags("a"),
    long: {
      ...longFlags(["all", "no-stream", "no-trunc"]),
      ...longValues(["format"]),
    },
  },
  // `docker top <container> [ps options]` passes the rest to ps, where `e`
  // prints the environment: only the container is allowed.
  top: { short: {}, long: {} },
  images: {
    short: { ...flags("aq"), ...values("f") },
    long: {
      ...longFlags(["all", "digests", "no-trunc", "quiet"]),
      ...longValues(["filter", "format"]),
    },
  },
  version: { short: values("f"), long: longValues(["format"]) },
  info: { short: values("f"), long: longValues(["format"]) },
};
const COMPOSE_SUBCOMMANDS: Record<string, OptionTable> = {
  ps: {
    short: flags("aq"),
    long: {
      ...longFlags(["all", "quiet", "services", "no-trunc", "orphans"]),
      ...longValues(["format", "filter", "status"]),
    },
  },
  logs: {
    short: flags("t"),
    long: {
      ...longFlags(["timestamps", "no-color", "no-log-prefix"]),
      ...longValues(["tail", "since", "until", "index"]),
    },
    refused: { "-f": FOLLOWING, "--follow": FOLLOWING },
  },
  top: { short: {}, long: {} },
  images: {
    short: flags("q"),
    long: { ...longFlags(["quiet"]), ...longValues(["format"]) },
  },
};
const DOCKER_NO_OPERANDS = ["ps", "images", "version", "info"];
const DOCKER_ONE_OPERAND = ["logs", "top"];

function checkDockerArgs(
  label: string,
  sub: string,
  rest: string[],
  table: OptionTable,
  compose: boolean,
): ReadOnlyCheck | null {
  const parsed = parseArgs(label, rest, table);
  if (isParseError(parsed)) return refuse(parsed.error);
  if (!compose && DOCKER_NO_OPERANDS.includes(sub) && parsed.operands.length)
    return refuse(`${label} ${parsed.operands[0]} is not allowed`);
  if (!compose && DOCKER_ONE_OPERAND.includes(sub)) {
    if (parsed.operands.length !== 1)
      return refuse(`${label} needs exactly one container`);
  }
  return null;
}

function checkDocker(args: string[]): ReadOnlyCheck {
  const sub = args[0];
  if (sub === undefined) return refuse("docker needs a subcommand");
  if (sub.startsWith("-")) return refuse(`docker ${sub} is not allowed`);
  if (sub === "compose") {
    const next = args[1];
    if (next === undefined || !Object.hasOwn(COMPOSE_SUBCOMMANDS, next))
      return refuse(`docker compose ${next ?? ""} is not allowed`.trim());
    const problem = checkDockerArgs(
      `docker compose ${next}`,
      next,
      args.slice(2),
      COMPOSE_SUBCOMMANDS[next],
      true,
    );
    return problem ?? { ok: true, argv: ["docker", ...args] };
  }
  if (!Object.hasOwn(DOCKER_SUBCOMMANDS, sub))
    return refuse(`docker ${sub} is not allowed`);
  const problem = checkDockerArgs(
    `docker ${sub}`,
    sub,
    args.slice(1),
    DOCKER_SUBCOMMANDS[sub],
    false,
  );
  if (problem) return problem;
  if (sub === "stats")
    return { ok: true, argv: ["docker", ...withFlag(args, "--no-stream")] };
  return { ok: true, argv: ["docker", ...args] };
}

// Recursive grep: every run excludes secret-shaped files and directories,
// appended after the caller's own options (grep applies the last matching
// --include/--exclude), then `--` so the operands stay operands even where
// getopt does not permute. The caller may not include a secret-shaped name,
// and may not follow links, which would read a target under another name.
export const GREP_SECRET_FILE_GLOBS: readonly string[] = [
  ".env",
  ".env.*",
  ".env-*",
  ".envrc",
  ".opensession*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_*",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".git-credentials",
  "credentials",
  "credentials.*",
  "secret",
  "secret.*",
  "secrets",
  "secrets.*",
  "environ",
  "shadow",
  "gshadow",
  "sudoers",
];
export const GREP_SECRET_DIR_GLOBS: readonly string[] = [
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".password-store",
  "credentials",
  "secret",
  "secrets",
  // Sessions' own state.
  ".opensession*",
  // ~/.config/gh holds the GitHub CLI's token.
  "gh",
  // Unit trees reached through a link the search follows on the command
  // line (`/var/run` is `/run` on most systems).
  "systemd",
];

// Names an --include glob must not match.
const SECRET_NAME_SAMPLES = [
  ".env",
  ".env.production",
  ".env-local",
  ".envrc",
  ".opensession",
  "server.pem",
  "tls.key",
  "cert.p12",
  "cert.pfx",
  "id_rsa",
  "id_ed25519",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "credentials.yaml",
  "secret",
  "secrets",
  "secrets.yaml",
  "secrets.json",
  "secret.txt",
  "environ",
  "shadow",
  "sudoers",
];

function globRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (ch === "\\" && i + 1 < glob.length) {
      out += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  try {
    return new RegExp(`^${out}$`, "i");
  } catch {
    // A glob we cannot read is treated as matching everything.
    return /.*/;
  }
}

function globMatchesSecret(glob: string): boolean {
  const re = globRegExp(glob);
  return SECRET_NAME_SAMPLES.some((name) => re.test(name));
}

// grep's options. Not here: -f/--file and --exclude-from (they read another
// file), -R, -S and --dereference-recursive (follow links), -L (some greps
// read it as following links).
const FOLLOWING_LINKS = "Following links in a recursive search is not allowed";

const GREP: OptionTable = {
  short: { ...flags("EFGPiyvwxcoqsbHhnTZzalIUr"), ...values("ABCDdem") },
  long: {
    ...longValues([
      "after-context",
      "before-context",
      "context",
      "binary-files",
      "devices",
      "directories",
      "exclude",
      "exclude-dir",
      "group-separator",
      "include",
      "label",
      "max-count",
      "regexp",
    ]),
    ...longFlags([
      "basic-regexp",
      "extended-regexp",
      "fixed-strings",
      "perl-regexp",
      "binary",
      "byte-offset",
      "count",
      "files-with-matches",
      "ignore-case",
      "no-ignore-case",
      "initial-tab",
      "invert-match",
      "line-buffered",
      "line-number",
      "line-regexp",
      "no-filename",
      "no-group-separator",
      "no-messages",
      "null",
      "null-data",
      "only-matching",
      "quiet",
      "recursive",
      "silent",
      "text",
      "with-filename",
      "word-regexp",
    ]),
    color: "optional",
    colour: "optional",
  },
  refused: {
    "-R": FOLLOWING_LINKS,
    "-S": FOLLOWING_LINKS,
    "--dereference-recursive": FOLLOWING_LINKS,
  },
};

// getopt's argmatch accepts any unambiguous prefix of an action, so only the
// two non-recursive actions spelled out read as non-recursive.
function directoriesRecurse(value: string): boolean {
  return value !== "read" && value !== "skip";
}

// Trees a recursive search may not reach, as directories that contain them.
// Their own paths are secret-shaped already.
const SECRET_TREES = [
  "/etc/systemd/system",
  "/run/systemd",
  "/run/credentials",
  "/var/lib/docker",
  "/var/run/systemd",
  "/var/run/credentials",
  "/proc",
  "/dev",
  "/sys/firmware",
];

/** Why a recursive search may not run over these paths, or null. The
 *  working directory on a host is not the agent's to choose, so the paths
 *  must be absolute. */
function recursiveTargetProblem(paths: string[]): string | null {
  if (!paths.length) return "A recursive search needs absolute paths to search";
  for (const raw of paths) {
    if (!raw.startsWith("/"))
      return "A recursive search needs absolute paths to search";
    const path = posix.normalize(raw).replace(/\/+$/, "") || "/";
    for (const tree of SECRET_TREES)
      if (
        path === "/" ||
        tree === path ||
        tree.startsWith(`${path}/`) ||
        path.startsWith(`${tree}/`)
      )
        return `A recursive search may not cover ${tree}`;
  }
  return null;
}

function checkGrep(args: string[]): ReadOnlyCheck {
  const parsed = parseArgs("grep", args, GREP);
  if (isParseError(parsed)) return refuse(parsed.error);
  let recursive = false;
  for (const o of parsed.options) {
    if (o.name === "r" || o.name === "recursive") recursive = true;
    if (
      (o.name === "d" || o.name === "directories") &&
      directoriesRecurse(o.value ?? "")
    )
      recursive = true;
    if (o.name === "include" && globMatchesSecret(o.value ?? ""))
      return refuse(SECRET_FILES);
  }
  if (!recursive) return { ok: true, argv: ["grep", ...args] };
  const problem = recursiveTargetProblem(
    // Without -e the first operand is the pattern.
    has(parsed, "e", "regexp") ? parsed.operands : parsed.operands.slice(1),
  );
  if (problem) return refuse(problem);
  return {
    ok: true,
    argv: [
      "grep",
      ...parsed.optionWords,
      ...GREP_SECRET_FILE_GLOBS.map((g) => `--exclude=${g}`),
      ...GREP_SECRET_DIR_GLOBS.map((g) => `--exclude-dir=${g}`),
      "--",
      ...parsed.operands,
    ],
  };
}

export function checkReadOnlyCommand(
  program: string,
  args: string[],
): ReadOnlyCheck {
  if (!READ_ONLY_PROGRAMS.includes(program))
    return refuse(`${program} is not on the read-only list`);
  if (args.length > MAX_HOST_ARGS) return refuse("Too many arguments");
  let total = 0;
  for (const a of args) {
    if (typeof a !== "string") return refuse("Arguments must be text");
    if (/[\0\r\n]/.test(a))
      return refuse("Arguments cannot contain line breaks");
    if (a.length > MAX_HOST_ARG_CHARS) return refuse("Argument too long");
    total += a.length;
  }
  if (total > MAX_HOST_ARGS_TOTAL) return refuse("Arguments too long");
  if (args.some(secretShaped)) return refuse(SECRET_FILES);

  switch (program) {
    case "cat":
      return checked(program, args, CAT);
    case "head":
      return checked(program, args, HEAD);
    case "tail":
      return checked(program, args, TAIL);
    case "wc":
      return checked(program, args, WC);
    case "ls":
      return checked(program, args, LS);
    case "stat":
      return checked(program, args, STAT);
    case "du":
      return checked(program, args, DU);
    case "df":
      return checked(program, args, DF);
    case "free":
      return checked(program, args, FREE, noOperands(program));
    case "uptime":
      return checked(program, args, UPTIME, noOperands(program));
    case "uname":
      return checked(program, args, UNAME, noOperands(program));
    case "hostname":
      return checked(program, args, HOSTNAME, noOperands(program));
    case "date":
      return checked(program, args, DATE, (parsed) => {
        // A bare MMDDhhmm... operand sets the clock; +FORMAT prints.
        const bad = parsed.operands.find((o) => !o.startsWith("+"));
        return bad === undefined ? null : refuse(`date ${bad} is not allowed`);
      });
    case "ps":
      return checkPs(args);
    case "ss":
      return checked(program, args, SS);
    case "grep":
      return checkGrep(args);
    case "journalctl":
      return checked(program, args, JOURNALCTL, () => ({
        ok: true,
        argv: ["journalctl", ...withFlag(args, "--no-pager")],
      }));
    case "systemctl":
      return checkSystemctl(args);
    case "docker":
      return checkDocker(args);
  }
  return refuse(`${program} is not on the read-only list`);
}
