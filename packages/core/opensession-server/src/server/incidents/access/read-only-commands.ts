// The read-only host commands incident agents may run on a granted host.
// A command is an argv, never a shell string: the caller quotes every word,
// so `;`, `|`, `$(...)` and backticks are inert data. This table decides
// which programs and flags may run at all. Runner hosts run commands as the
// Runner's own user, so the list is defence in depth, not isolation.

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
    case "journalctl":
      return checkJournalctl(args);
    case "systemctl":
      return checkSystemctl(args);
    case "docker":
      return checkDocker(args);
  }
  return { ok: true, argv: [program, ...args] };
}
