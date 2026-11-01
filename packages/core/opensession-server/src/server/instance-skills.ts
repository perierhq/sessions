/**
 * The instance skills store: `SKILL.md` skills kept on this server, created,
 * uploaded and edited from Settings → Skills, and loaded by every session
 * next to the ones a project's checkout carries (skill-paths.ts).
 *
 * A skill is a plain folder, `<instanceSkillsDir>/<name>/SKILL.md` plus any
 * files it references, the same layout as a checkout's `.agents/skills`, so
 * the engine loads it with no translation. Nothing here keeps a second copy
 * or an index: the folder is the record.
 *
 * Every write is staged and renamed into place, so a turn that starts while
 * a skill is being saved sees the old file or the new one, never half of
 * either. Staging folders start with a dot, which the engine and the listing
 * both skip. All filesystem work is async: these run on the gateway.
 */

import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_UPLOAD_MAX_BYTES,
  skillNameProblem,
  type InstanceSkillDetail,
  type SkillFileInfo,
  type SkillSummary,
} from "../shared/instance-skills";
import { SHIPPED_SKILLS_DIR, instanceSkillsDir } from "./skill-paths";
import { looksLikeZip, readZip, ZipError } from "./zip-read";

export class SkillStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const SKILL_FILE = "SKILL.md";
const MAX_PATH_LENGTH = 300;
const MAX_PATH_DEPTH = 8;
/** Files an archive or a Finder copy carries that are never part of a skill. */
const JUNK_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

// ── SKILL.md ─────────────────────────────────────────────────────────────────

export interface ParsedSkillMarkdown {
  /** The frontmatter `name`, when it sets one. */
  name?: string;
  description: string;
}

/**
 * Check a SKILL.md the way the engine reads it: YAML frontmatter between
 * `---` lines with a non-empty `description`, and a valid `name` when one is
 * given (the folder name is used otherwise). Throws a SkillStoreError that
 * names the problem, because a skill the engine refuses is silently missing
 * from every session.
 */
export function parseSkillMarkdown(text: string): ParsedSkillMarkdown {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---"))
    throw new SkillStoreError(
      "SKILL.md must start with frontmatter: a --- line, name and description, then ---.",
    );
  const end = normalized.indexOf("\n---", 3);
  if (end === -1)
    throw new SkillStoreError("SKILL.md frontmatter has no closing --- line.");
  let data: unknown;
  try {
    data = Bun.YAML.parse(normalized.slice(4, end));
  } catch (error) {
    throw new SkillStoreError(
      `SKILL.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fm = (data && typeof data === "object" ? data : {}) as Record<
    string,
    unknown
  >;
  const description =
    typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description)
    throw new SkillStoreError(
      "SKILL.md needs a description: it is how an agent knows when to use the skill.",
    );
  if (description.length > SKILL_DESCRIPTION_MAX)
    throw new SkillStoreError(
      `The description is ${description.length} characters; the limit is ${SKILL_DESCRIPTION_MAX}.`,
    );
  if (fm.name !== undefined && typeof fm.name !== "string")
    throw new SkillStoreError("The frontmatter name must be text.");
  const name = typeof fm.name === "string" ? fm.name.trim() : undefined;
  if (name) {
    const problem = skillNameProblem(name);
    if (problem) throw new SkillStoreError(`Name "${name}": ${problem}`);
  }
  return { ...(name ? { name } : {}), description };
}

/** A YAML scalar for a one-line value: bare when that is unambiguous. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][^:#\n"'`{}[\]|>&*!%@]*$/.test(value) &&
    !/\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

export function skillTemplate(name: string, description: string): string {
  const title = name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return [
    "---",
    `name: ${name}`,
    `description: ${yamlScalar(description)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "Say when to use this skill, then the steps to follow. Put longer",
    "reference material in files next to this one and link them by relative",
    "path, so an agent reads them only when it needs them.",
    "",
  ].join("\n");
}

// ── Paths ────────────────────────────────────────────────────────────────────

function assertSkillName(name: string): void {
  const problem = skillNameProblem(name);
  if (problem) throw new SkillStoreError(problem);
}

/** A skill-relative path, `/`-separated, with nothing that could leave the
 *  folder. Backslashes from a Windows archive count as separators. */
export function normalizeSkillPath(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!path || path.length > MAX_PATH_LENGTH || path.includes("\0"))
    throw new SkillStoreError(`"${raw}" is not a valid file path.`);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    throw new SkillStoreError(`"${raw}" must be relative to the skill folder.`);
  const parts = path.split("/");
  if (parts.length > MAX_PATH_DEPTH)
    throw new SkillStoreError(`"${raw}" is nested too deeply.`);
  for (const part of parts)
    if (!part || part === "." || part === "..")
      throw new SkillStoreError(`"${raw}" is not a valid file path.`);
  return path;
}

function skillDir(name: string): string {
  assertSkillName(name);
  return join(instanceSkillsDir(), name);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function requireSkill(name: string): Promise<string> {
  const dir = skillDir(name);
  if (!(await exists(join(dir, SKILL_FILE))))
    throw new SkillStoreError(`No instance skill named ${name}.`, 404);
  return dir;
}

/** The absolute path for `rel` inside `dir`, refusing anything a symlink in
 *  the existing part of the path would carry outside it. */
async function containedPath(dir: string, rel: string): Promise<string> {
  const target = resolve(dir, rel);
  const realDir = await realpath(dir);
  let probe = dirname(target);
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== realDir && !real.startsWith(realDir + sep))
        throw new SkillStoreError(`"${rel}" is outside the skill folder.`);
      break;
    } catch (error) {
      if (error instanceof SkillStoreError) throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw new SkillStoreError(
        `"${rel}" is a link and cannot be edited here.`,
      );
  } catch (error) {
    if (error instanceof SkillStoreError) throw error;
  }
  return target;
}

async function writeAtomic(path: string, bytes: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** UTF-8 with no NUL bytes. `partial` allows a sequence cut at the end, for
 *  a sniff of a file's first bytes. */
function isText(bytes: Uint8Array, partial = false): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: partial,
    });
    return true;
  } catch {
    return false;
  }
}

async function sniffText(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buf = new Uint8Array(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return isText(buf.subarray(0, bytesRead), true);
  } finally {
    await handle.close();
  }
}

/** Our own temp files (`.<name>.<uuid>.tmp`), never part of a skill. */
const OWN_TMP_RE = /^\..+\.[0-9a-f-]{36}\.tmp$/;

// ── Reading ──────────────────────────────────────────────────────────────────

interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
  abs: string;
}

/** Regular files under a skill folder, skipping our own dot-prefixed temp
 *  files. Symlinks are listed by nobody: we never write one. */
async function walkSkill(dir: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  async function visit(abs: string, rel: string, depth: number) {
    if (depth > MAX_PATH_DEPTH || out.length >= SKILL_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= SKILL_MAX_FILES) return;
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(childAbs, childRel, depth + 1);
      else if (entry.isFile() && !OWN_TMP_RE.test(entry.name)) {
        const info = await stat(childAbs);
        out.push({
          path: childRel,
          size: info.size,
          mtimeMs: info.mtimeMs,
          abs: childAbs,
        });
      }
    }
  }
  await visit(dir, "", 1);
  return out;
}

function sortFiles<T extends { path: string }>(files: T[]): T[] {
  return files.sort((a, b) =>
    a.path === SKILL_FILE
      ? -1
      : b.path === SKILL_FILE
        ? 1
        : a.path.localeCompare(b.path),
  );
}

/** name/description off a SKILL.md, leniently: a listing shows a broken
 *  skill rather than hiding it, so it can be found and fixed. */
function describe(text: string, fallbackName: string) {
  try {
    const parsed = parseSkillMarkdown(text);
    return {
      name: parsed.name || fallbackName,
      description: parsed.description,
    };
  } catch (error) {
    return {
      name: fallbackName,
      description:
        error instanceof SkillStoreError
          ? error.message
          : "Unreadable SKILL.md",
    };
  }
}

/** Skill folders under a root, the way the engine globs `**\/SKILL.md`:
 *  nested groups count, dot-folders and node_modules do not. */
async function scanRoot(
  root: string,
  depth = 4,
): Promise<Array<{ dir: string; folder: string; text: string }>> {
  const out: Array<{ dir: string; folder: string; text: string }> = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const dir = join(root, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = (await stat(dir)).isDirectory();
      } catch {}
    }
    if (!isDir) continue;
    try {
      const text = await readFile(join(dir, SKILL_FILE), "utf8");
      out.push({ dir, folder: entry.name, text });
      continue;
    } catch {}
    if (depth > 1) out.push(...(await scanRoot(dir, depth - 1)));
  }
  return out;
}

async function sameDir(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Instance skills, then the shipped set, each by name. */
export async function listSkills(): Promise<SkillSummary[]> {
  const root = instanceSkillsDir();
  const instance: SkillSummary[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    let text: string;
    try {
      text = await readFile(join(dir, SKILL_FILE), "utf8");
    } catch {
      continue;
    }
    const files = await walkSkill(dir);
    const updated = Math.max(0, ...files.map((file) => file.mtimeMs));
    instance.push({
      // The folder is the handle every edit uses; a frontmatter name that
      // differs from it is renamed on save, so the two agree in practice.
      name: entry.name,
      description: describe(text, entry.name).description,
      origin: "instance",
      fileCount: files.length,
      updatedAt: new Date(updated).toISOString(),
    });
  }

  const shipped: SkillSummary[] = [];
  if (!(await sameDir(SHIPPED_SKILLS_DIR, root))) {
    const seen = new Set<string>();
    for (const found of await scanRoot(SHIPPED_SKILLS_DIR)) {
      const { name, description } = describe(found.text, found.folder);
      if (seen.has(name)) continue;
      seen.add(name);
      shipped.push({ name, description, origin: "shipped" });
    }
  }
  const shippedNames = new Set(shipped.map((skill) => skill.name));
  for (const skill of instance)
    if (shippedNames.has(skill.name)) skill.replacesShipped = true;

  const byName = (a: SkillSummary, b: SkillSummary) =>
    a.name.localeCompare(b.name);
  return [...instance.sort(byName), ...shipped.sort(byName)];
}

export async function readInstanceSkill(
  name: string,
): Promise<InstanceSkillDetail> {
  const dir = await requireSkill(name);
  const walked = await walkSkill(dir);
  const files: SkillFileInfo[] = [];
  for (const file of walked)
    files.push({
      path: file.path,
      size: file.size,
      text: file.size <= SKILL_FILE_MAX_BYTES && (await sniffText(file.abs)),
    });
  const text = await readFile(join(dir, SKILL_FILE), "utf8");
  return {
    name,
    description: describe(text, name).description,
    files: sortFiles(files),
    updatedAt: new Date(
      Math.max(0, ...walked.map((file) => file.mtimeMs)),
    ).toISOString(),
    dir,
  };
}

export async function readInstanceSkillFile(
  name: string,
  rawPath: string,
): Promise<string> {
  const dir = await requireSkill(name);
  const path = await containedPath(dir, normalizeSkillPath(rawPath));
  let bytes: Uint8Array;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > SKILL_FILE_MAX_BYTES)
      throw new SkillStoreError("This file is too large to open here.", 413);
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof SkillStoreError) throw error;
    throw new SkillStoreError(`${rawPath} does not exist.`, 404);
  }
  if (!isText(bytes))
    throw new SkillStoreError(
      "This file is not text and cannot be opened here.",
      415,
    );
  return new TextDecoder().decode(bytes);
}

// ── Writing ──────────────────────────────────────────────────────────────────

export async function createInstanceSkill(
  name: string,
  description: string,
): Promise<InstanceSkillDetail> {
  assertSkillName(name);
  const oneLine = description.replace(/\s+/g, " ").trim();
  const text = skillTemplate(name, oneLine);
  parseSkillMarkdown(text);
  const dir = skillDir(name);
  if (await exists(dir))
    throw new SkillStoreError(
      `An instance skill named ${name} already exists.`,
      409,
    );
  await mkdir(instanceSkillsDir(), { recursive: true });
  const staging = join(instanceSkillsDir(), `.new-${randomUUID()}`);
  try {
    await mkdir(staging);
    await writeFile(join(staging, SKILL_FILE), text);
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (await exists(dir))
      throw new SkillStoreError(
        `An instance skill named ${name} already exists.`,
        409,
      );
    throw error;
  }
  return readInstanceSkill(name);
}

/**
 * Save one file. Saving SKILL.md checks it first, and a frontmatter `name`
 * that differs from the folder renames the skill, since the engine would
 * load it under the new name anyway. Returns the skill's name after the save.
 */
export async function writeInstanceSkillFile(
  name: string,
  rawPath: string,
  content: string,
): Promise<{ name: string }> {
  const dir = await requireSkill(name);
  const rel = normalizeSkillPath(rawPath);
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > SKILL_FILE_MAX_BYTES)
    throw new SkillStoreError(
      "This file is larger than the per-file limit.",
      413,
    );
  if (
    rel !== SKILL_FILE &&
    !(await exists(join(dir, rel))) &&
    (await walkSkill(dir)).length >= SKILL_MAX_FILES
  )
    throw new SkillStoreError(
      `A skill holds at most ${SKILL_MAX_FILES} files.`,
    );

  let next = name;
  if (rel === SKILL_FILE) {
    const parsed = parseSkillMarkdown(content);
    if (parsed.name && parsed.name !== name) {
      next = parsed.name;
      if (await exists(skillDir(next)))
        throw new SkillStoreError(
          `An instance skill named ${next} already exists. Pick another name.`,
          409,
        );
    }
  }
  const target = await containedPath(dir, rel);
  if (await exists(target)) {
    const info = await lstat(target);
    if (info.isDirectory())
      throw new SkillStoreError(`${rel} is a folder.`, 409);
  }
  await writeAtomic(target, bytes);
  if (next !== name) await rename(dir, skillDir(next));
  return { name: next };
}

export async function deleteInstanceSkillFile(
  name: string,
  rawPath: string,
): Promise<void> {
  const dir = await requireSkill(name);
  const rel = normalizeSkillPath(rawPath);
  if (rel === SKILL_FILE)
    throw new SkillStoreError(
      "A skill cannot lose its SKILL.md. Delete the skill instead.",
    );
  const target = await containedPath(dir, rel);
  const info = await lstat(target).catch(() => null);
  if (!info || info.isDirectory())
    throw new SkillStoreError(`${rel} does not exist.`, 404);
  await rm(target);
  // Drop folders the removal emptied, up to (not including) the skill root.
  let parent = dirname(target);
  while (parent !== dir && parent.startsWith(dir + sep)) {
    if ((await readdir(parent)).length) break;
    await rm(parent, { recursive: true });
    parent = dirname(parent);
  }
}

export async function deleteInstanceSkill(name: string): Promise<void> {
  const dir = await requireSkill(name);
  // Out of the loaded set in one rename, then removed at leisure.
  const trash = join(instanceSkillsDir(), `.trash-${randomUUID()}`);
  await rename(dir, trash);
  await rm(trash, { recursive: true, force: true });
}

// ── Import ───────────────────────────────────────────────────────────────────

export interface UploadedFile {
  /** The file's name, or its path inside a picked folder. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Turn an upload into one skill's files: a zip or `.skill` archive, a lone
 * markdown file (taken as SKILL.md), or the files of a picked folder. The
 * skill's root is the folder holding the shallowest SKILL.md; anything
 * outside it is dropped, so a zip of `my-skill/` and a zip of its contents
 * both work.
 */
async function unpackUpload(
  upload: UploadedFile[],
): Promise<{ files: UploadedFile[]; folder: string }> {
  let entries = upload;
  if (
    upload.length === 1 &&
    (/\.(zip|skill)$/i.test(upload[0].path) || looksLikeZip(upload[0].bytes))
  ) {
    try {
      entries = await readZip(upload[0].bytes, {
        maxEntries: SKILL_MAX_FILES * 2,
        maxEntryBytes: SKILL_FILE_MAX_BYTES,
        maxTotalBytes: SKILL_UPLOAD_MAX_BYTES,
      });
    } catch (error) {
      if (error instanceof ZipError) throw new SkillStoreError(error.message);
      throw error;
    }
  } else if (upload.length === 1 && /\.md$/i.test(upload[0].path)) {
    const stem = basename(upload[0].path.replace(/\\/g, "/")).replace(
      /\.md$/i,
      "",
    );
    return {
      files: [{ path: SKILL_FILE, bytes: upload[0].bytes }],
      folder: /^skill$/i.test(stem) ? "" : stem,
    };
  }

  const kept = entries
    .map((entry) => ({ ...entry, path: entry.path.replace(/\\/g, "/") }))
    .filter(
      (entry) =>
        !entry.path.split("/").includes("__MACOSX") &&
        !JUNK_NAMES.has(posix.basename(entry.path)),
    );
  const skillFiles = kept
    .filter(
      (entry) =>
        posix.basename(entry.path).toUpperCase() === SKILL_FILE.toUpperCase(),
    )
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  if (!skillFiles.length)
    throw new SkillStoreError(
      "No SKILL.md in the upload. A skill is a folder with a SKILL.md at its top.",
    );
  const depth = skillFiles[0].path.split("/").length;
  if (skillFiles.filter((f) => f.path.split("/").length === depth).length > 1)
    throw new SkillStoreError(
      "The upload holds more than one skill. Upload them one at a time.",
    );
  const rootDir = posix.dirname(skillFiles[0].path);
  const prefix = rootDir === "." ? "" : `${rootDir}/`;
  const files = kept
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => {
      const rel = entry.path.slice(prefix.length);
      return {
        path: rel.toUpperCase() === SKILL_FILE.toUpperCase() ? SKILL_FILE : rel,
        bytes: entry.bytes,
      };
    });
  return { files, folder: rootDir === "." ? "" : posix.basename(rootDir) };
}

/**
 * Add a skill from an upload. Without `replace`, a name that is already
 * taken answers 409 so the person can choose; with it, the old folder is
 * swapped out in one rename.
 */
export async function importInstanceSkill(
  upload: UploadedFile[],
  opts: { replace?: boolean; name?: string } = {},
): Promise<{ name: string; replaced: boolean }> {
  if (!upload.length) throw new SkillStoreError("Choose a file to upload.");
  const { files, folder } = await unpackUpload(upload);
  if (files.length > SKILL_MAX_FILES)
    throw new SkillStoreError(
      `A skill holds at most ${SKILL_MAX_FILES} files.`,
    );
  let total = 0;
  const paths = new Set<string>();
  for (const file of files) {
    file.path = normalizeSkillPath(file.path);
    if (paths.has(file.path))
      throw new SkillStoreError(`${file.path} appears twice in the upload.`);
    paths.add(file.path);
    if (file.bytes.length > SKILL_FILE_MAX_BYTES)
      throw new SkillStoreError(
        `${file.path} is larger than the per-file limit.`,
        413,
      );
    total += file.bytes.length;
  }
  if (total > SKILL_UPLOAD_MAX_BYTES)
    throw new SkillStoreError(
      "The skill is larger than the upload limit.",
      413,
    );
  // A file and a folder of the same name cannot both exist on disk.
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/")))
        throw new SkillStoreError(
          `${parts.slice(0, i).join("/")} is both a file and a folder.`,
        );
  }

  const skillMd = files.find((file) => file.path === SKILL_FILE)!;
  if (!isText(skillMd.bytes))
    throw new SkillStoreError("SKILL.md is not text.");
  const parsed = parseSkillMarkdown(new TextDecoder().decode(skillMd.bytes));
  const name = parsed.name || opts.name || folder;
  if (!name)
    throw new SkillStoreError(
      "Add a name to the SKILL.md frontmatter, or upload the skill's folder.",
    );
  const problem = skillNameProblem(name);
  if (problem)
    throw new SkillStoreError(
      parsed.name
        ? `Name "${name}": ${problem}`
        : `The folder name "${name}" is not a valid skill name: ${problem}`,
    );

  const root = instanceSkillsDir();
  const target = join(root, name);
  const taken = await exists(target);
  if (taken && !opts.replace)
    throw new SkillStoreError(
      `An instance skill named ${name} already exists.`,
      409,
    );

  await mkdir(root, { recursive: true });
  const staging = join(root, `.upload-${randomUUID()}`);
  const trash = join(root, `.trash-${randomUUID()}`);
  try {
    for (const file of files) {
      const abs = join(staging, ...file.path.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.bytes);
    }
    if (taken) await rename(target, trash);
    try {
      await rename(staging, target);
    } catch (error) {
      if (taken) await rename(trash, target).catch(() => {});
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(trash, { recursive: true, force: true });
  }
  return { name, replaced: taken };
}
