import {
  openSync,
  readSync,
  closeSync,
  realpathSync,
  constants as fsConstants,
} from "fs";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "fs/promises";
import { basename, dirname, join, resolve, sep } from "path";
import { SHIPPED_SKILLS_DIR } from "./skill-paths";

// ── Guarded local tools (the containment invariant) ──────────────────────────
//
// Pi's built-in fs tools run in-process with no path containment and their
// rg/fd children inherit process.env (the server env). We never activate the
// built-ins; the model gets same-name customTools overrides instead: pi's own
// tool factories (createReadToolDefinition & co) wrapped with the guarded
// operations below — identical schema/description/truncation behavior, ours
// only where the filesystem or a subprocess is touched.

/** Directory roots no tool may touch even when a symlink or bind mount would
 *  bring them under the workspace realpath check. /proc/self/environ is the
 *  server-env exfiltration vector that motivated the guard. */
const BLOCKED_PATH_ROOTS = ["/proc", "/sys", "/dev"];

/**
 * Realpath-based workspace containment: resolve `rawPath`, symlink-resolve it
 * through its nearest EXISTING ancestor (so not-yet-created write targets are
 * checked too — a symlinked parent can't smuggle them out), and require the
 * result to sit under `realRoot`. Throws with a model-facing message on
 * escape. Returns the fully-resolved path it validated.
 */
export function assertContainedPiPath(
  rawPath: string,
  realRoot: string,
): string {
  const resolved = resolve(rawPath);
  let probe = resolved;
  const pendingSuffix: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = realpathSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        real = probe;
        break;
      }
      pendingSuffix.unshift(basename(probe));
      probe = parent;
    }
  }
  const full = pendingSuffix.length ? join(real, ...pendingSuffix) : real;
  for (const blocked of BLOCKED_PATH_ROOTS) {
    if (full === blocked || full.startsWith(blocked + sep)) {
      throw new Error(`Path is not accessible to this session: ${rawPath}`);
    }
  }
  if (full !== realRoot && !full.startsWith(realRoot + sep)) {
    throw new Error(
      `Path is outside the session workspace (${rawPath}). ` +
        "Local file tools are contained to the session's working directory.",
    );
  }
  return full;
}

/** Magic-byte image sniff for the guarded read tool (pi's default detector is
 *  not importable standalone; same formats: png/jpeg/gif/webp/bmp). */
function sniffImageMime(path: string): string | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(16);
      const n = readSync(fd, buf, 0, 16, 0);
      if (n < 4) return undefined;
      if (
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47
      )
        return "image/png";
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return "image/jpeg";
      if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
      if (
        n >= 12 &&
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WEBP"
      )
        return "image/webp";
      if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The guarded operations pi's read/ls/find/edit/write factories accept —
 * every path realpath-contained to `cwd` before any fs call. `find.glob`
 * replaces the factory's default fd SUBPROCESS entirely (pi only uses fd when
 * no custom glob is provided), walking with Bun.Glob in-process instead:
 * no child, no env, `followSymlinks: false` so a symlinked dir can't be
 * traversed out of. Exported for the containment unit tests.
 */
export function makeGuardedToolOps(cwd: string) {
  let realRoot: string;
  try {
    realRoot = realpathSync(cwd);
  } catch {
    realRoot = resolve(cwd);
  }
  const guard = (p: string) => assertContainedPiPath(p, realRoot);
  const exists = async (p: string) => {
    guard(p);
    try {
      await fsAccess(p, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  return {
    guard,
    read: {
      readFile: async (p: string) => {
        guard(p);
        return fsReadFile(p);
      },
      access: async (p: string) => {
        guard(p);
        await fsAccess(p, fsConstants.R_OK);
      },
      detectImageMimeType: async (p: string) => {
        guard(p);
        return sniffImageMime(p);
      },
    },
    ls: {
      exists,
      stat: async (p: string) => {
        guard(p);
        return fsStat(p);
      },
      readdir: async (p: string) => {
        guard(p);
        return fsReaddir(p);
      },
    },
    find: {
      exists,
      glob: async (
        pattern: string,
        searchPath: string,
        options: { ignore: string[]; limit: number },
      ): Promise<string[]> => {
        guard(searchPath);
        // fd (pi's default) matches bare patterns against basenames while
        // globbing relative paths — mirror that with a `**/` prefix.
        const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
        const limit = Math.max(1, options.limit || 1000);
        const ignore = (options.ignore || []).map((ig) => new Bun.Glob(ig));
        const out: string[] = [];
        const scanner = new Bun.Glob(effective);
        for await (const rel of scanner.scan({
          cwd: searchPath,
          dot: true,
          onlyFiles: false,
          followSymlinks: false,
        })) {
          if (ignore.some((ig) => ig.match(rel))) continue;
          out.push(join(searchPath, rel));
          if (out.length >= limit) break;
        }
        return out.sort();
      },
    },
    edit: {
      readFile: async (p: string) => {
        guard(p);
        return fsReadFile(p);
      },
      writeFile: async (p: string, content: string) => {
        guard(p);
        await fsWriteFile(p, content, "utf-8");
      },
      access: async (p: string) => {
        guard(p);
        await fsAccess(p, fsConstants.R_OK | fsConstants.W_OK);
      },
    },
    write: {
      writeFile: async (p: string, content: string) => {
        guard(p);
        await fsWriteFile(p, content, "utf-8");
      },
      mkdir: async (dir: string) => {
        guard(dir);
        await fsMkdir(dir, { recursive: true });
      },
    },
  };
}

/** The skills this server ships, which a Sandbox run may read from here
 *  (they exist nowhere else; remote-workspace.ts). */
export function shippedSkillRoots(): string[] {
  const roots = [resolve(SHIPPED_SKILLS_DIR)];
  try {
    roots.push(realpathSync(SHIPPED_SKILLS_DIR));
  } catch {}
  return [...new Set(roots)];
}

const GREP_DEFAULT_LIMIT = 100;
const GREP_OUTPUT_CAP = 50 * 1024;

/**
 * Guarded grep execute: pi's grep factory hard-codes an rg spawn that
 * inherits process.env and takes an uncontained search path, so unlike the
 * other fs tools its execute is replaced wholesale (the tool keeps pi's
 * name/schema/description via the factory's definition). rg runs with the
 * run's minimal env, cwd-contained, match-capped, byte-capped. Exported for
 * the containment unit tests.
 */
export function makeGuardedGrepExecute(
  cwd: string,
  env: Record<string, string>,
  guard: (p: string) => string,
) {
  return async function execute(
    _toolCallId: string,
    params: {
      pattern?: unknown;
      path?: unknown;
      glob?: unknown;
      ignoreCase?: unknown;
      literal?: unknown;
      context?: unknown;
      limit?: unknown;
    },
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: undefined;
  }> {
    const pattern = String(params?.pattern ?? "");
    if (!pattern) throw new Error("grep: pattern is required");
    if (signal?.aborted) throw new Error("Operation aborted");
    const rawPath =
      typeof params?.path === "string" && params.path ? params.path : ".";
    const searchPath = resolve(cwd, rawPath);
    guard(searchPath);
    const rgPath = Bun.which("rg");
    if (!rgPath) throw new Error("ripgrep (rg) is not available on this host");
    const st = await fsStat(searchPath).catch(() => null);
    if (!st) throw new Error(`Path not found: ${searchPath}`);
    const isDir = st.isDirectory();

    const args = [
      "--line-number",
      "--color=never",
      "--hidden",
      "--with-filename",
    ];
    if (params?.ignoreCase) args.push("--ignore-case");
    if (params?.literal) args.push("--fixed-strings");
    if (typeof params?.glob === "string" && params.glob)
      args.push("--glob", params.glob);
    const ctxN = Number(params?.context);
    if (Number.isFinite(ctxN) && ctxN > 0)
      args.push("--context", String(Math.floor(ctxN)));
    const limit = Math.max(1, Number(params?.limit) || GREP_DEFAULT_LIMIT);
    // Directory searches run from the search root with "." so rg prints
    // workspace-relative paths (pi's output shape); file targets run from the
    // file's dir with its basename for the same reason.
    args.push("--", pattern, isDir ? "." : basename(searchPath));

    const proc = Bun.spawn([rgPath, ...args], {
      cwd: isDir ? searchPath : dirname(searchPath),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const onAbort = () => {
      try {
        proc.kill();
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let out = "";
    let stderr = "";
    let matches = 0;
    let matchLimitReached = false;
    try {
      const dec = new TextDecoder();
      // stderr drains concurrently: a stderr flood (permission errors on a
      // big tree) must not fill its pipe and block rg while stdout is open.
      const errDrain = (async () => {
        const errReader = proc.stderr.getReader();
        try {
          while (true) {
            const { done, value } = await errReader.read();
            if (done) break;
            if (value && stderr.length < 8_192) {
              stderr += dec.decode(value, { stream: true });
            }
          }
        } finally {
          errReader.releaseLock();
        }
      })();
      const reader = proc.stdout.getReader();
      try {
        let buffered = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, nl);
            buffered = buffered.slice(nl + 1);
            if (/^(.+?):(\d+):/.test(line)) {
              if (matches >= limit) continue;
              matches++;
              if (matches >= limit) matchLimitReached = true;
            } else if (matches >= limit) {
              continue;
            }
            out += `${line}\n`;
            if (matchLimitReached || out.length > GREP_OUTPUT_CAP * 2) {
              try {
                proc.kill();
              } catch {}
            }
          }
        }
        if (buffered && matches < limit) out += buffered;
      } finally {
        reader.releaseLock();
      }
      await errDrain;
      const code = await proc.exited;
      if (signal?.aborted) throw new Error("Operation aborted");
      if (code !== 0 && code !== 1 && !matchLimitReached && !matches) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    let text = out.trimEnd();
    if (!text)
      return {
        content: [{ type: "text", text: "No matches found" }],
        details: undefined,
      };
    if (text.length > GREP_OUTPUT_CAP) {
      text = `${text.slice(0, GREP_OUTPUT_CAP)}\n\n[Truncated: 50KB limit reached]`;
    }
    if (matchLimitReached) {
      text += `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`;
    }
    return { content: [{ type: "text", text }], details: undefined };
  };
}
