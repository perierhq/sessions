// The read-only host commands incident agents may run on a granted host.
// A command is an argv, never a shell string: the caller quotes every word,
// so `;`, `|`, `$(...)` and backticks are inert data. This table decides
// which programs and flags may run at all. Runner hosts run commands as the
// Runner's own user, so the list is defence in depth, not isolation.
// Recursive grep runs with secret-shaped files and directories excluded.

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

// `=` counts as a boundary too, so `--file=/srv/.env` is caught.
const SECRET_PATH =
  /(^|[/=])\.env(\.|$)|\.(pem|key|p12|pfx)$|(^|[/=])id_(rsa|dsa|ecdsa|ed25519)|(^|[/=])\.ssh(\/|$)|\/etc\/(shadow|gshadow|sudoers)|\/proc\/[^/]+\/environ|(^|[/=])\.(netrc|pgpass|npmrc|git-credentials)$|(^|[/=])(credentials|secrets?)(\.|\/|$)/i;

const FOLLOWING = "Following output is not allowed";

const refuse = (reason: string): ReadOnlyCheck => ({ ok: false, reason });

/** A short-flag cluster (`-fn`) that contains one of `letters`. */
function shortClusterHas(arg: string, letters: string): boolean {
  if (!/^-[^-]/.test(arg)) return false;
  return [...arg.slice(1)].some((ch) => letters.includes(ch));
}

const withFlag = (args: string[], flag: string): string[] =>
  args.includes(flag) ? args : [...args, flag];

const firstNonFlag = (args: string[]): number =>
  args.findIndex((a) => !a.startsWith("-"));

function checkTail(args: string[]): ReadOnlyCheck | null {
  for (const a of args)
    if (shortClusterHas(a, "fF") || a.startsWith("--follow") || a === "--retry")
      return refuse(FOLLOWING);
  return null;
}

const JOURNALCTL_REFUSED = [
  "--rotate",
  "--flush",
  "--sync",
  "--relinquish-var",
  "--smart-relinquish-var",
  "--setup-keys",
  "--update-catalog",
  // Writes the cursor back to the named file.
  "--cursor-file",
];

function checkJournalctl(args: string[]): ReadOnlyCheck {
  for (const a of args) {
    if (shortClusterHas(a, "f") || a.startsWith("--follow"))
      return refuse(FOLLOWING);
    const flag = a.split("=")[0];
    if (flag.startsWith("--vacuum-") || JOURNALCTL_REFUSED.includes(flag))
      return refuse(`journalctl ${flag} is not allowed`);
  }
  return { ok: true, argv: ["journalctl", ...withFlag(args, "--no-pager")] };
}

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

/** Property names `systemctl show` was asked for, or null when none. */
function showProperties(args: string[]): string[] | null {
  const out: string[] = [];
  let named = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let value: string | undefined;
    if (a === "-p" || a === "--property") value = args[++i];
    else if (a.startsWith("--property=")) value = a.slice("--property=".length);
    else if (/^-p./.test(a)) value = a.slice(2);
    else continue;
    named = true;
    out.push(...(value ?? "").split(","));
  }
  return named ? out : null;
}

function checkSystemctl(args: string[]): ReadOnlyCheck {
  const index = firstNonFlag(args);
  if (index >= 0) {
    const sub = args[index];
    if (!SYSTEMCTL_SUBCOMMANDS.includes(sub))
      return refuse(`systemctl ${sub} is not allowed`);
    if (sub === "show") {
      // Unit properties include Environment=, which carries secrets.
      const props = showProperties(args);
      if (!props || props.some((p) => /environment/i.test(p) || !p.trim()))
        return refuse(
          "systemctl show needs --property naming properties other than Environment",
        );
    }
  }
  return { ok: true, argv: ["systemctl", ...withFlag(args, "--no-pager")] };
}

const DOCKER_SUBCOMMANDS = [
  "ps",
  "logs",
  "stats",
  "top",
  "images",
  "version",
  "info",
];
const COMPOSE_SUBCOMMANDS = ["ps", "logs", "top", "images"];

function checkDockerLogs(args: string[]): ReadOnlyCheck | null {
  for (const a of args)
    if (shortClusterHas(a, "f") || a.startsWith("--follow"))
      return refuse(FOLLOWING);
  return null;
}

function checkDocker(args: string[]): ReadOnlyCheck {
  const sub = args[0];
  if (sub === undefined) return refuse("docker needs a subcommand");
  // Global flags (-H, --context, --config) would point docker elsewhere.
  if (sub.startsWith("-")) return refuse(`docker ${sub} is not allowed`);
  if (sub === "compose") {
    const next = args[1];
    if (next === undefined || !COMPOSE_SUBCOMMANDS.includes(next))
      return refuse(`docker compose ${next ?? ""} is not allowed`.trim());
    if (next === "logs") {
      const follow = checkDockerLogs(args.slice(2));
      if (follow) return follow;
    }
    return { ok: true, argv: ["docker", ...args] };
  }
  if (!DOCKER_SUBCOMMANDS.includes(sub))
    return refuse(`docker ${sub} is not allowed`);
  if (sub === "logs") {
    const follow = checkDockerLogs(args.slice(1));
    if (follow) return follow;
  }
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
];

// Names an --include glob must not match.
const SECRET_NAME_SAMPLES = [
  ".env",
  ".env.production",
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

// Long options grep accepts here, and whether each takes a value. GNU getopt
// accepts unique prefixes, so a prefix is resolved against this table; an
// unknown or ambiguous one is refused.
const GREP_LONG_OPTIONS: Record<string, boolean> = {
  "after-context": true,
  "before-context": true,
  context: true,
  "binary-files": true,
  devices: true,
  directories: true,
  exclude: true,
  "exclude-from": true,
  "exclude-dir": true,
  file: true,
  "group-separator": true,
  include: true,
  label: true,
  "max-count": true,
  regexp: true,
  "basic-regexp": false,
  "extended-regexp": false,
  "fixed-strings": false,
  "perl-regexp": false,
  binary: false,
  "byte-offset": false,
  color: false,
  colour: false,
  count: false,
  "dereference-recursive": false,
  "files-with-matches": false,
  "files-without-match": false,
  "ignore-case": false,
  "no-ignore-case": false,
  "initial-tab": false,
  "invert-match": false,
  "line-buffered": false,
  "line-number": false,
  "line-regexp": false,
  "no-filename": false,
  "no-group-separator": false,
  "no-messages": false,
  null: false,
  "null-data": false,
  "only-matching": false,
  quiet: false,
  recursive: false,
  silent: false,
  text: false,
  "with-filename": false,
  "word-regexp": false,
};
const GREP_SHORT_WITH_VALUE = "ABCDdefm";
const GREP_FOLLOW_SHORT = "RS";

function resolveGrepLong(name: string): string | null {
  if (name in GREP_LONG_OPTIONS) return name;
  const matches = Object.keys(GREP_LONG_OPTIONS).filter((o) =>
    o.startsWith(name),
  );
  // A prefix that could name the link-following option is read as it, so an
  // ambiguous one is refused below rather than guessed.
  if (matches.includes("dereference-recursive")) return "dereference-recursive";
  return matches.length === 1 ? matches[0] : null;
}

const FOLLOWING_LINKS = "Following links in a recursive search is not allowed";
const SECRET_FILES = "Reading secret-shaped files is not allowed";

function directoriesRecurse(value: string): boolean {
  return value !== "read" && value !== "skip";
}

function checkGrep(args: string[]): ReadOnlyCheck {
  const options: string[] = [];
  const operands: string[] = [];
  let recursive = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const raw = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const name = resolveGrepLong(raw);
      if (!name) return refuse(`grep --${raw} is not allowed`);
      options.push(a);
      let value: string | undefined;
      if (GREP_LONG_OPTIONS[name]) {
        if (eq >= 0) value = a.slice(eq + 1);
        else {
          if (i + 1 >= args.length)
            return refuse(`grep --${raw} needs a value`);
          value = args[++i];
          options.push(value);
        }
      }
      if (name === "dereference-recursive") return refuse(FOLLOWING_LINKS);
      if (name === "recursive") recursive = true;
      if (name === "directories" && directoriesRecurse(value ?? ""))
        recursive = true;
      if (name === "include" && globMatchesSecret(value ?? ""))
        return refuse(SECRET_FILES);
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      options.push(a);
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (GREP_FOLLOW_SHORT.includes(ch)) return refuse(FOLLOWING_LINKS);
        if (ch === "r") recursive = true;
        if (GREP_SHORT_WITH_VALUE.includes(ch)) {
          let value = a.slice(j + 1);
          if (!value) {
            if (i + 1 >= args.length)
              return refuse(`grep -${ch} needs a value`);
            value = args[++i];
            options.push(value);
          }
          if (ch === "d" && directoriesRecurse(value)) recursive = true;
          break;
        }
      }
      continue;
    }
    operands.push(a);
  }
  if (!recursive) return { ok: true, argv: ["grep", ...args] };
  return {
    ok: true,
    argv: [
      "grep",
      ...options,
      ...GREP_SECRET_FILE_GLOBS.map((g) => `--exclude=${g}`),
      ...GREP_SECRET_DIR_GLOBS.map((g) => `--exclude-dir=${g}`),
      "--",
      ...operands,
    ],
  };
}

const HOSTNAME_FLAGS = [
  "-f",
  "--fqdn",
  "--long",
  "-s",
  "--short",
  "-i",
  "--ip-address",
  "-I",
  "--all-ip-addresses",
  "-d",
  "--domain",
  "-A",
  "--all-fqdns",
  "-a",
  "--alias",
];

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
  if (args.some((a) => SECRET_PATH.test(a)))
    return refuse("Reading secret-shaped files is not allowed");

  switch (program) {
    case "tail":
      return checkTail(args) ?? { ok: true, argv: [program, ...args] };
    case "ps":
      if (args.some((a) => !a.startsWith("-") && a.includes("e")))
        return refuse("ps environment output is not allowed");
      break;
    case "hostname":
      for (const a of args)
        if (!HOSTNAME_FLAGS.includes(a))
          return refuse(`hostname ${a} is not allowed`);
      break;
    case "date":
      for (const a of args)
        // A bare positional (MMDDhhmm...) sets the clock as well.
        if (
          shortClusterHas(a, "s") ||
          a.startsWith("--set") ||
          (!a.startsWith("-") && !a.startsWith("+"))
        )
          return refuse(`date ${a} is not allowed`);
      break;
    case "ss":
      for (const a of args)
        if (
          shortClusterHas(a, "KD") ||
          a.startsWith("--kill") ||
          a.startsWith("--diag")
        )
          return refuse(`ss ${a} is not allowed`);
      break;
    case "grep":
      return checkGrep(args);
    case "journalctl":
      return checkJournalctl(args);
    case "systemctl":
      return checkSystemctl(args);
    case "docker":
      return checkDocker(args);
  }
  return { ok: true, argv: [program, ...args] };
}
