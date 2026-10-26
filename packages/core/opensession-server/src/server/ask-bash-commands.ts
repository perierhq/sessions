/**
 * Read-only checks for the ask-mode bash commands a glob cannot judge.
 *
 * ASK_BASH_PERMISSIONS (runner-shared.ts) is a flat glob list, and a glob
 * cannot tell `sed -n 1,5p` from `sed -n 1,5w out`, `sort -u` from
 * `sort -o out`, or `cd <own worktree>` from `cd /`. PR reviews lost a
 * third of their bash calls to that: `cd` into the session's own worktree,
 * `git -C <worktree> diff`, `sed -n 1,40p`, `awk 'NR<=30'`. These checks
 * read the words of one pipeline segment and answer:
 *
 * - "allow": the segment is a read this module understands,
 * - "deny" (with a reason): it could write, run a program, or leave the
 *   workspace,
 * - a rewritten segment for the glob list to judge (`cd` is gone,
 *   `git -C <workspace>` becomes `git`),
 * - null: not ours, the glob list decides.
 *
 * Fail closed: a word whose value depends on the environment (`$X`, a
 * leading `~`) is not literal, and any doubt is a deny. Command and process
 * substitution and file redirection never reach here; askBashDenyReason
 * refuses them first.
 */
import { resolve, sep } from "node:path";

export type AskSegmentVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "rewrite"; segment: string }
  | null;

interface Word {
  value: string;
  /** No expansion: no `$` outside single quotes, no leading unquoted `~`. */
  literal: boolean;
  /** Written without any quoting, so shell syntax in it is syntax. */
  bare: boolean;
}

/** Shell words of one segment, quotes removed. */
export function segmentWords(segment: string): Word[] {
  const words: Word[] = [];
  let value = "";
  let literal = true;
  let bare = true;
  let started = false;
  let quote: "'" | '"' | null = null;
  const flush = () => {
    if (started) words.push({ value, literal, bare });
    value = "";
    literal = true;
    bare = true;
    started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < segment.length) value += segment[++i];
      else {
        if (ch === "$") literal = false;
        value += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    started = true;
    if (ch === "'" || ch === '"') {
      quote = ch;
      bare = false;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      value += segment[++i];
      bare = false;
      continue;
    }
    if (ch === "$" || (ch === "~" && value === "")) literal = false;
    value += ch;
  }
  flush();
  return words;
}

/** Redirections askBashDenyReason already let through (fd dups, /dev/null,
 *  input): not operands. */
function withoutRedirections(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.value;
    if (!words[i]!.bare) {
      out.push(words[i]!);
      continue;
    }
    if (/^\d*>&\d+$/.test(w) || /^(?:\d*|&)>>?\/dev\/null$/.test(w)) continue;
    if (/^(?:\d*|&)>>?$/.test(w) || /^\d*<$/.test(w)) {
      i++;
      continue;
    }
    if (/^\d*</.test(w)) continue;
    out.push(words[i]!);
  }
  return out;
}

/** Where `cd` and `git -C` may go: the session's working directory and its
 *  scratch dir. Relative paths resolve against the working directory. */
export interface AskRoots {
  workspace?: string;
  scratchDir?: string;
}

function within(roots: AskRoots, path: string): boolean {
  if (!roots.workspace) return false;
  const full = resolve(roots.workspace, path);
  return [roots.workspace, roots.scratchDir].some((root) => {
    if (!root) return false;
    const base = resolve(root);
    return full === base || full.startsWith(base + sep);
  });
}

function joinWords(words: Word[]): string {
  return words
    .map((w) =>
      /^[\w@%+=:,./-]+$/.test(w.value)
        ? w.value
        : `'${w.value.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

function cdVerdict(words: Word[], roots: AskRoots): AskSegmentVerdict {
  const target = words[1];
  const where = roots.workspace
    ? ` Commands already run in ${roots.workspace}; use paths relative to it, or absolute paths inside it.`
    : "";
  if (
    words.length !== 2 ||
    !target?.literal ||
    target.value === "-" ||
    !within(roots, target.value)
  )
    return {
      kind: "deny",
      reason: `"${joinWords(words)}" leaves the session workspace.${where}`,
    };
  return { kind: "allow" };
}

/** `git -C <workspace path>` and `git --no-pager` read like plain `git`. */
function gitVerdict(words: Word[], roots: AskRoots): AskSegmentVerdict {
  const rest = words.slice(1);
  let changed = false;
  while (rest.length) {
    const w = rest[0]!.value;
    if (w === "--no-pager") {
      rest.shift();
      changed = true;
      continue;
    }
    if (w === "-C") {
      const path = rest[1];
      if (!path?.literal || !within(roots, path.value))
        return {
          kind: "deny",
          reason: `"git -C ${path?.value ?? ""}" is outside the session workspace.`,
        };
      rest.splice(0, 2);
      changed = true;
      continue;
    }
    break;
  }
  if (rest[0]?.value === "tag") return gitTagVerdict(rest.slice(1));
  return changed
    ? { kind: "rewrite", segment: `git ${joinWords(rest)}`.trim() }
    : null;
}

const GIT_TAG_WRITE_FLAGS = new Set([
  "-a",
  "--annotate",
  "-s",
  "--sign",
  "-u",
  "--local-user",
  "-f",
  "--force",
  "-d",
  "--delete",
  "-m",
  "--message",
  "-F",
  "--file",
  "-e",
  "--edit",
  "--create-reflog",
  "--cleanup",
  "--trailer",
]);

/** `git tag` lists unless it names a tag to create; with `-l`/`--list`,
 *  or a filter that implies listing, the names are patterns. */
const GIT_TAG_LIST_FLAGS = new Set([
  "-l",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);

function gitTagVerdict(args: Word[]): AskSegmentVerdict {
  const deny: AskSegmentVerdict = {
    kind: "deny",
    reason: "git tag that creates or deletes a tag is not read-only.",
  };
  const list = args.some((a) => GIT_TAG_LIST_FLAGS.has(a.value.split("=")[0]!));
  for (const { value } of args) {
    if (value.startsWith("--")) {
      if (GIT_TAG_WRITE_FLAGS.has(value.split("=")[0]!)) return deny;
    } else if (value.startsWith("-") && value !== "-") {
      if (/^-n\d*$/.test(value)) continue;
      if (shortFlags(value).some((f) => "asufdmFe".includes(f))) return deny;
    } else if (!list) return deny;
  }
  return { kind: "allow" };
}

/** Options of a short-option cluster, e.g. `-nE` → ["n", "E"]. */
function shortFlags(word: string): string[] {
  return /^-[a-zA-Z]+$/.test(word) ? word.slice(1).split("") : [];
}

/**
 * Whether a sed script only prints, deletes from the stream or substitutes:
 * every command is `p`, `d` or `s<d>re<d>repl<d>` with flags among
 * g, i, I, m, M, p and digits, each behind an optional line, `$` or /regex/
 * address or range. Anything else (`w` writes a file, `e` and the `s///e`
 * flag run a command, `r`/`R` read one, `q` with an exit code) is not
 * read-only by this check.
 */
export function sedScriptReadOnly(script: string): boolean {
  let i = 0;
  const n = script.length;
  const space = () => {
    while (i < n && /[ \t]/.test(script[i]!)) i++;
  };
  /** Text up to an unescaped `delim`, consuming the delimiter. */
  const delimited = (delim: string): boolean => {
    while (i < n && script[i] !== delim) {
      if (script[i] === "\n") return false;
      i += script[i] === "\\" ? 2 : 1;
    }
    if (i >= n) return false;
    i++;
    return true;
  };
  const address = (): boolean => {
    if (/\d/.test(script[i] ?? "")) {
      while (/\d/.test(script[i] ?? "")) i++;
      return true;
    }
    if (script[i] === "$") {
      i++;
      return true;
    }
    if (script[i] === "/") {
      i++;
      if (!delimited("/")) return false;
      if (script[i] === "I") i++;
      return true;
    }
    return true;
  };
  while (i < n) {
    space();
    if (i >= n) break;
    if (script[i] === ";" || script[i] === "\n") {
      i++;
      continue;
    }
    if (!address()) return false;
    space();
    if (script[i] === ",") {
      i++;
      space();
      if (!address()) return false;
      space();
    }
    const command = script[i++];
    if (command === "s") {
      const delim = script[i++];
      if (!delim || delim === "\n" || delim === "\\") return false;
      if (!delimited(delim) || !delimited(delim)) return false;
      while (i < n && /[gimIM0-9p]/.test(script[i]!)) i++;
    } else if (command !== "p" && command !== "d") return false;
    space();
    if (i < n && script[i] !== ";" && script[i] !== "\n") return false;
  }
  return true;
}

/** sed with options that only shape reading and a sedScriptReadOnly
 *  script. GNU sed takes options anywhere on the line, so every word is
 *  checked. */
function sedVerdict(words: Word[]): AskSegmentVerdict {
  const deny: AskSegmentVerdict = {
    kind: "deny",
    reason:
      "sed is allowed only to print, delete or substitute on stdout (`sed -n '<range>p'`, `sed 's/a/b/'`), never with -i, w or e.",
  };
  const scripts: Word[] = [];
  const operands: Word[] = [];
  let options = true;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const w = word.value;
    if (!options || w === "-" || !w.startsWith("-")) {
      operands.push(word);
      continue;
    }
    if (w === "--") {
      options = false;
      continue;
    }
    if (w === "-e" || w === "--expression") {
      const script = words[++i];
      if (!script) return deny;
      scripts.push(script);
      continue;
    }
    if (w.startsWith("--expression=")) {
      scripts.push({ ...word, value: w.slice("--expression=".length) });
      continue;
    }
    if (
      [
        "--quiet",
        "--silent",
        "--regexp-extended",
        "--separate",
        "--unbuffered",
        "--null-data",
      ].includes(w)
    )
      continue;
    const flags = shortFlags(w);
    if (!flags.length || flags.some((f) => !"nErsuz".includes(f))) return deny;
  }
  if (!scripts.length) {
    const script = operands.shift();
    if (!script) return deny;
    scripts.push(script);
  }
  for (const script of scripts)
    if (!script.literal || !sedScriptReadOnly(script.value)) return deny;
  return { kind: "allow" };
}

/** awk options that only set data: -F, -v. Everything else (-f program
 *  file, -i include, -l load, -o/-p/-d write a file) is refused. */
function awkVerdict(words: Word[]): AskSegmentVerdict {
  const deny = (why: string): AskSegmentVerdict => ({
    kind: "deny",
    reason: `awk ${why} is not read-only.`,
  });
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i]!.value;
    if (w === "--") {
      i++;
      break;
    }
    if (w === "-F" || w === "-v") {
      i++;
      continue;
    }
    if (/^-[Fv]./.test(w)) continue;
    if (w.startsWith("-")) return deny(`option ${w}`);
    break;
  }
  const program = words[i];
  if (!program) return deny("without a program");
  if (!program.literal) return deny("with a program from a variable");
  // String literals are data; what is left is code.
  const code = program.value.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/\bsystem\s*\(/.test(code)) return deny("system()");
  if (code.includes("@")) return deny("@load/@include");
  if (code.replace(/\|\|/g, "").includes("|")) return deny("a pipe");
  // Output redirection: `>` after print/printf in the same statement.
  for (const m of code.matchAll(/\bprintf?\b([^;}\n]*)/g))
    if (m[1]!.includes(">")) return deny("output redirection");
  return { kind: "allow" };
}

/** sort writes only through -o/--output, and runs a program through
 *  --compress-program. */
function sortVerdict(words: Word[]): AskSegmentVerdict {
  for (const { value: w } of words.slice(1)) {
    if (w === "--") break;
    if (
      w.startsWith("--output") ||
      w.startsWith("--compress-program") ||
      (/^-[a-zA-Z]+$/.test(w) &&
        w
          .slice(1)
          .split(/[tkST]/)[0]!
          .includes("o"))
    )
      return { kind: "deny", reason: "sort -o writes a file." };
  }
  return { kind: "allow" };
}

/** uniq's second operand is an output file. */
function uniqVerdict(words: Word[]): AskSegmentVerdict {
  let operands = 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!.value;
    if (w === "-f" || w === "-s" || w === "-w") {
      i++;
      continue;
    }
    if (w.startsWith("-") && w !== "-") continue;
    operands++;
  }
  return operands <= 1
    ? { kind: "allow" }
    : { kind: "deny", reason: "uniq with an output file writes it." };
}

const FIND_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

function findVerdict(words: Word[]): AskSegmentVerdict {
  const action = words.find((w) => FIND_ACTIONS.has(w.value));
  return action
    ? {
        kind: "deny",
        reason: `find ${action.value} runs a command or writes a file.`,
      }
    : null;
}

/**
 * The verdict for one pipeline segment, or null to let the glob list
 * decide. Without a workspace, `cd` and `git -C` stay refused.
 */
export function askSegmentVerdict(
  segment: string,
  roots: AskRoots = {},
): AskSegmentVerdict {
  const words = withoutRedirections(segmentWords(segment));
  const name = words[0]?.value;
  if (!name || !words[0]!.literal) return null;
  switch (name) {
    case "cd":
      return cdVerdict(words, roots);
    case "git":
      return gitVerdict(words, roots);
    case "sed":
      return sedVerdict(words);
    case "awk":
    case "gawk":
    case "mawk":
      return awkVerdict(words);
    case "sort":
      return sortVerdict(words);
    case "uniq":
      return uniqVerdict(words);
    case "find":
      return findVerdict(words);
    default:
      return null;
  }
}
