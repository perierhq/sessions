import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deflateRawSync } from "zlib";
import {
  createInstanceSkill,
  deleteInstanceSkill,
  deleteInstanceSkillFile,
  importInstanceSkill,
  listSkills,
  normalizeSkillPath,
  parseSkillMarkdown,
  readInstanceSkill,
  readInstanceSkillFile,
  SkillStoreError,
  writeInstanceSkillFile,
} from "./instance-skills";
import {
  instanceSkillsDir,
  skillSearchPaths,
  SHIPPED_SKILLS_DIR,
} from "./skill-paths";
import { invalidateSkillIndex, searchSkills } from "./skills";
import { readZip } from "./zip-read";
import { handleInstanceSkillsRoutes } from "./routes/instance-skills";
import type { RouteContext } from "./routes/context";

const enc = new TextEncoder();
let root: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OPENSESSION_STATE_DIR;
  root = mkdtempSync(join(tmpdir(), "instance-skills-"));
  process.env.OPENSESSION_STATE_DIR = root;
  invalidateSkillIndex();
});

afterEach(() => {
  if (previous === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function skillMd(name: string | null, description = "Does a thing.") {
  return `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\n\n# Body\n`;
}

/** A zip with stored or deflated entries, enough for the reader's tests. */
function makeZip(
  entries: Array<{ path: string; text: string; store?: boolean }>,
) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.path);
    const raw = enc.encode(entry.text);
    const data = entry.store ? raw : new Uint8Array(deflateRawSync(raw));
    const crc = Bun.hash.crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, entry.store ? 0 : 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(10, entry.store ? 0 : 8, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    const localBytes = new Uint8Array([
      ...new Uint8Array(local.buffer),
      ...name,
      ...data,
    ]);
    locals.push(localBytes);
    centrals.push(new Uint8Array([...new Uint8Array(central.buffer), ...name]));
    offset += localBytes.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("SKILL.md checks", () => {
  test("accepts the engine's shape and reports what is missing", () => {
    expect(parseSkillMarkdown(skillMd("demo"))).toEqual({
      name: "demo",
      description: "Does a thing.",
    });
    expect(parseSkillMarkdown(skillMd(null))).toEqual({
      description: "Does a thing.",
    });
    expect(() => parseSkillMarkdown("# no frontmatter")).toThrow("frontmatter");
    expect(() => parseSkillMarkdown("---\nname: demo\n---\n")).toThrow(
      "description",
    );
    expect(() => parseSkillMarkdown(skillMd("Bad_Name"))).toThrow("lowercase");
    expect(() =>
      parseSkillMarkdown("---\ndescription: [unclosed\n---\n"),
    ).toThrow("YAML");
  });

  test("paths stay inside the skill folder", () => {
    expect(normalizeSkillPath("./scripts\\run.py")).toBe("scripts/run.py");
    for (const bad of ["../x", "/etc/passwd", "a//b", "a/./b", "C:/x", ""])
      expect(() => normalizeSkillPath(bad)).toThrow(SkillStoreError);
  });
});

describe("instance skills store", () => {
  test("create, edit, add a file, list, delete", async () => {
    const created = await createInstanceSkill(
      "release-notes",
      "Write release notes: from merged PRs.",
    );
    expect(created.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    const text = await readInstanceSkillFile("release-notes", "SKILL.md");
    expect(parseSkillMarkdown(text).description).toBe(
      "Write release notes: from merged PRs.",
    );

    await writeInstanceSkillFile(
      "release-notes",
      "references/style.md",
      "Short lines.\n",
    );
    const detail = await readInstanceSkill("release-notes");
    expect(detail.files).toEqual([
      { path: "SKILL.md", size: expect.any(Number), text: true },
      { path: "references/style.md", size: 13, text: true },
    ]);

    await expect(createInstanceSkill("release-notes", "again")).rejects.toThrow(
      "already exists",
    );
    await expect(
      writeInstanceSkillFile("release-notes", "SKILL.md", "nope"),
    ).rejects.toThrow("frontmatter");

    await deleteInstanceSkillFile("release-notes", "references/style.md");
    expect(
      existsSync(join(instanceSkillsDir(), "release-notes", "references")),
    ).toBe(false);
    await expect(
      deleteInstanceSkillFile("release-notes", "SKILL.md"),
    ).rejects.toThrow("Delete the skill");

    const listed = await listSkills();
    expect(listed.filter((s) => s.origin === "instance")).toEqual([
      expect.objectContaining({ name: "release-notes", fileCount: 1 }),
    ]);

    await deleteInstanceSkill("release-notes");
    expect(existsSync(join(instanceSkillsDir(), "release-notes"))).toBe(false);
    await expect(readInstanceSkill("release-notes")).rejects.toThrow(
      "No instance skill",
    );
  });

  test("a new frontmatter name renames the skill", async () => {
    await createInstanceSkill("draft", "A draft.");
    const result = await writeInstanceSkillFile(
      "draft",
      "SKILL.md",
      skillMd("final"),
    );
    expect(result).toEqual({ name: "final" });
    expect(existsSync(join(instanceSkillsDir(), "final", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(instanceSkillsDir(), "draft"))).toBe(false);

    await createInstanceSkill("other", "Other.");
    await expect(
      writeInstanceSkillFile("other", "SKILL.md", skillMd("final")),
    ).rejects.toThrow("already exists");
  });

  test("a symlink cannot carry a write outside the folder", async () => {
    await createInstanceSkill("linked", "Linked.");
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      symlinkSync(outside, join(instanceSkillsDir(), "linked", "out"));
      await expect(
        writeInstanceSkillFile("linked", "out/x.md", "x"),
      ).rejects.toThrow("outside");
      expect(existsSync(join(outside, "x.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("binary files are listed but not opened", async () => {
    await createInstanceSkill("assets", "Assets.");
    writeFileSync(
      join(instanceSkillsDir(), "assets", "logo.png"),
      new Uint8Array([0x89, 0x50, 0, 1]),
    );
    const detail = await readInstanceSkill("assets");
    expect(detail.files.find((f) => f.path === "logo.png")?.text).toBe(false);
    await expect(readInstanceSkillFile("assets", "logo.png")).rejects.toThrow(
      "not text",
    );
  });
});

describe("uploads", () => {
  test("a zip of the skill's folder", async () => {
    const zip = makeZip([
      { path: "pdf-tools/SKILL.md", text: skillMd(null, "Work with PDFs.") },
      {
        path: "pdf-tools/scripts/split.py",
        text: "print('hi')\n",
        store: true,
      },
      { path: "__MACOSX/pdf-tools/._SKILL.md", text: "junk" },
      { path: "pdf-tools/.DS_Store", text: "junk" },
    ]);
    const result = await importInstanceSkill([
      { path: "pdf-tools.skill", bytes: zip },
    ]);
    expect(result).toEqual({ name: "pdf-tools", replaced: false });
    const detail = await readInstanceSkill("pdf-tools");
    expect(detail.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "scripts/split.py",
    ]);
    expect(
      readFileSync(
        join(instanceSkillsDir(), "pdf-tools", "scripts", "split.py"),
        "utf8",
      ),
    ).toBe("print('hi')\n");
  });

  test("a zip of the folder's contents takes the frontmatter name", async () => {
    const zip = makeZip([{ path: "SKILL.md", text: skillMd("flat") }]);
    expect(
      await importInstanceSkill([{ path: "whatever.zip", bytes: zip }]),
    ).toEqual({
      name: "flat",
      replaced: false,
    });
  });

  test("a lone markdown file and a picked folder", async () => {
    expect(
      await importInstanceSkill([
        { path: "triage.md", bytes: enc.encode(skillMd(null)) },
      ]),
    ).toEqual({ name: "triage", replaced: false });
    expect(
      await importInstanceSkill([
        { path: "folder-skill/SKILL.md", bytes: enc.encode(skillMd(null)) },
        { path: "folder-skill/notes/a.md", bytes: enc.encode("a") },
      ]),
    ).toEqual({ name: "folder-skill", replaced: false });
    expect(
      existsSync(join(instanceSkillsDir(), "folder-skill", "notes", "a.md")),
    ).toBe(true);
  });

  test("a taken name asks first, then replaces the whole folder", async () => {
    await createInstanceSkill("dup", "Old.");
    await writeInstanceSkillFile("dup", "old.md", "old");
    const upload = [
      { path: "dup/SKILL.md", bytes: enc.encode(skillMd("dup", "New.")) },
    ];
    await expect(importInstanceSkill(upload)).rejects.toMatchObject({
      status: 409,
    });
    expect(await importInstanceSkill(upload, { replace: true })).toEqual({
      name: "dup",
      replaced: true,
    });
    const detail = await readInstanceSkill("dup");
    expect(detail.description).toBe("New.");
    expect(detail.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  test("refuses uploads that are not one valid skill", async () => {
    await expect(
      importInstanceSkill([{ path: "x/readme.txt", bytes: enc.encode("x") }]),
    ).rejects.toThrow("No SKILL.md");
    await expect(
      importInstanceSkill([
        { path: "a/SKILL.md", bytes: enc.encode(skillMd(null)) },
        { path: "b/SKILL.md", bytes: enc.encode(skillMd(null)) },
      ]),
    ).rejects.toThrow("more than one skill");
    await expect(
      importInstanceSkill([
        { path: "SKILL.md", bytes: enc.encode(skillMd(null)) },
      ]),
    ).rejects.toThrow("Add a name");
    await expect(
      importInstanceSkill([{ path: "x.zip", bytes: enc.encode("not a zip") }]),
    ).rejects.toThrow("not a zip");
    // Nothing half-written is left behind for the engine to load.
    expect(skillSearchPaths(undefined)).not.toContain(instanceSkillsDir());
  });

  test("the zip reader caps what an entry may inflate to", async () => {
    const zip = makeZip([{ path: "big.txt", text: "a".repeat(10_000) }]);
    await expect(
      readZip(zip, { maxEntries: 10, maxEntryBytes: 100, maxTotalBytes: 1000 }),
    ).rejects.toThrow("per-file limit");
  });
});

describe("loading", () => {
  test("every session loads instance skills, after the checkout's and before the shipped set", async () => {
    await createInstanceSkill("house-style", "How we write.");
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      mkdirSync(join(ws, ".agents", "skills"), { recursive: true });
      expect(skillSearchPaths(ws)).toEqual([
        join(ws, ".agents", "skills"),
        instanceSkillsDir(),
        ...(existsSync(SHIPPED_SKILLS_DIR) ? [SHIPPED_SKILLS_DIR] : []),
      ]);
      expect(skillSearchPaths(ws, { projectOnly: true })).toEqual([
        join(ws, ".agents", "skills"),
      ]);

      const { skills } = loadSkills({
        cwd: ws,
        agentDir: join(ws, ".pi"),
        skillPaths: skillSearchPaths(ws),
        includeDefaults: false,
      });
      expect(skills.find((s) => s.name === "house-style")?.description).toBe(
        "How we write.",
      );

      const menu = searchSkills(ws, "house-style");
      expect(menu.filter((s) => s.name === "house-style")).toEqual([
        {
          name: "house-style",
          description: "How we write.",
          source: "instance",
        },
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("routes", () => {
  function ctx(
    method: string,
    path: string,
    init: { body?: BodyInit; json?: unknown; automation?: boolean } = {},
  ): RouteContext {
    const url = new URL(`http://localhost/backstage${path}`);
    const req = new Request(url, {
      method,
      ...(init.json !== undefined
        ? {
            body: JSON.stringify(init.json),
            headers: { "content-type": "application/json" },
          }
        : init.body !== undefined
          ? { body: init.body }
          : {}),
    });
    return {
      req,
      url,
      path: url.pathname.replace(/^\/backstage/, ""),
      publicPrefix: "/backstage",
      authUser: init.automation
        ? ({
            login: "automation",
            name: "Automation",
            automation: true,
          } as RouteContext["authUser"])
        : null,
    };
  }

  test("create, upload, edit, delete over HTTP", async () => {
    let res = (await handleInstanceSkillsRoutes(
      ctx("POST", "/api/instance-skills", {
        json: { name: "via-http", description: "Made over HTTP." },
      }),
    ))!;
    expect(res.status).toBe(201);

    const form = new FormData();
    form.append("file", new File([skillMd(null)], "uploaded/SKILL.md"));
    form.append("file", new File(["x"], "uploaded/notes.md"));
    res = (await handleInstanceSkillsRoutes(
      ctx("POST", "/api/instance-skills/upload", { body: form }),
    ))!;
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "uploaded", replaced: false });

    res = (await handleInstanceSkillsRoutes(
      ctx("PUT", "/api/instance-skills/via-http/file", {
        json: { path: "SKILL.md", content: skillMd("renamed", "Edited.") },
      }),
    ))!;
    expect(await res.json()).toEqual({ name: "renamed" });

    res = (await handleInstanceSkillsRoutes(
      ctx("GET", "/api/instance-skills"),
    ))!;
    const body = (await res.json()) as {
      skills: Array<{ name: string; origin: string }>;
    };
    expect(
      body.skills.filter((s) => s.origin === "instance").map((s) => s.name),
    ).toEqual(["renamed", "uploaded"]);

    res = (await handleInstanceSkillsRoutes(
      ctx(
        "GET",
        "/api/instance-skills/uploaded/file?path=..%2F..%2Fconfig.json",
      ),
    ))!;
    expect(res.status).toBe(400);

    res = (await handleInstanceSkillsRoutes(
      ctx("DELETE", "/api/instance-skills/uploaded"),
    ))!;
    expect(res.status).toBe(200);
    res = (await handleInstanceSkillsRoutes(
      ctx("GET", "/api/instance-skills/uploaded"),
    ))!;
    expect(res.status).toBe(404);
  });

  test("automations cannot write", async () => {
    const res = (await handleInstanceSkillsRoutes(
      ctx("POST", "/api/instance-skills", {
        json: { name: "sneaky", description: "x" },
        automation: true,
      }),
    ))!;
    expect(res.status).toBe(403);
    expect(existsSync(join(instanceSkillsDir(), "sneaky"))).toBe(false);
  });
});
