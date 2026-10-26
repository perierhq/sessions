import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { useSupportTestKernel } from "../../support/testing/kernel-fixture";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import { KnowledgeService } from "../service";
import {
  DUPLICATE_NAMES_COPY,
  FILE_TYPES_COPY,
  FILE_TOO_BIG_COPY,
  fileText,
  importFiles,
  MAX_IMPORT_FILES,
  TOO_MANY_FILES_COPY,
  ZIP_COPY,
} from "./files";
import { __waitForJobForTest, listJobs } from "./jobs";
import { PDF_MAX_PAGES, pdfTextInChild } from "./pdf-text";
import { htmlToText } from "../../web-fetch";

const kernel = useSupportTestKernel();
const TODAY = "2026-10-26";
const ADA = { name: "Ada", email: "ada@example.test" };
const enc = (text: string) => new TextEncoder().encode(text);

const helloPdf = async () =>
  new Uint8Array(await readFile(join(import.meta.dir, "testdata/hello.pdf")));

const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

/** A PDF with one text line per page (uncompressed, Helvetica) and an
 *  info dictionary. */
function makePdf(pages: string[], info: Record<string, string> = {}) {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs: string[] = [];
  const font = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<</Type/Catalog/Pages 2 0 R>>");
  objs.push(`<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`);
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${esc(text)}) Tj ET`;
    objs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 ${font} 0 R>>>>/Contents ${4 + i * 2} 0 R>>`,
    );
    objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  });
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  const infoEntries = Object.entries(info)
    .map(([k, v]) => `/${k} (${esc(v)})`)
    .join("");
  objs.push(`<<${infoEntries}>>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R/Info ${objs.length} 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

const MARKDOWN = "# Exporting a project\n\nOpen the project, press Export.\n";
const HTML = `<!doctype html><html><head><title>Billing FAQ</title>
<style>p { color: red }</style></head><body><nav>Home · Docs</nav>
<h1>Billing FAQ</h1><p>Invoices go out on the <b>first</b> of the month.</p>
<script>alert(1)</script></body></html>`;

let service: KnowledgeService;

beforeEach(() => {
  service = new KnowledgeService({ base: join(kernel.root(), "memory") });
  __setKnowledgeServiceForTest(service);
});

afterEach(() => {
  __setKnowledgeServiceForTest(null);
  service.close();
});

const read = (path: string) => knowledgeRepo.call("read", "acme", path, TODAY);

async function finished(project: string, id: string) {
  await __waitForJobForTest(id);
  return (await listJobs(project)).find((j) => j.id === id)!;
}

describe("fileText", () => {
  test("Markdown keeps its text and takes the first heading as title", async () => {
    expect(await fileText("export.md", "text/markdown", enc(MARKDOWN))).toEqual(
      { title: "Exporting a project", text: MARKDOWN.trim() },
    );
    expect(
      await fileText("notes.markdown", "", enc("Plain notes, no heading.")),
    ).toEqual({ title: "notes", text: "Plain notes, no heading." });
    expect(await fileText("faq.txt", "text/plain", enc("Q? A."))).toEqual({
      title: "faq",
      text: "Q? A.",
    });
  });

  test("a PDF yields its text", async () => {
    const result = await fileText(
      "hello.pdf",
      "application/pdf",
      await helloPdf(),
    );
    expect("text" in result && result.text).toContain("Hello");
    expect("title" in result && result.title).toBe("hello");
  });

  test("an HTML export yields its text without tags", async () => {
    const result = await fileText("billing.html", "text/html", enc(HTML));
    if (!("text" in result)) throw new Error(result.error);
    expect(result.title).toBe("Billing FAQ");
    expect(result.text).toContain("Invoices go out on the first of the month.");
    expect(result.text).not.toMatch(/[<>]/);
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("color: red");
  });

  test("a zip, an oversize file and other types are refused", async () => {
    expect(await fileText("export.zip", "application/zip", enc("PK"))).toEqual({
      error: ZIP_COPY,
    });
    expect(ZIP_COPY).toBe("Unzip the export and upload the files");
    const big = new Uint8Array(11 * 1024 * 1024).fill(0x61);
    expect(await fileText("big.txt", "text/plain", big)).toEqual({
      error: FILE_TOO_BIG_COPY,
    });
    expect(await fileText("deck.docx", "", enc("x"))).toEqual({
      error: FILE_TYPES_COPY,
    });
  });

  test("a file that isn't what its name says, or has no text, is an error", async () => {
    expect(await fileText("fake.pdf", "application/pdf", enc("hello"))).toEqual(
      { error: expect.stringContaining("fake.pdf") },
    );
    expect(await fileText("empty.md", "", enc("  \n"))).toEqual({
      error: expect.stringContaining("empty.md"),
    });
    expect(
      await fileText("bin.txt", "", new Uint8Array([0xff, 0xfe, 0, 1])),
    ).toEqual({ error: expect.stringContaining("bin.txt") });
  });
});

describe("importFiles", () => {
  test("one commit by the uploader; items are reference with the original attached", async () => {
    const pdf = await helloPdf();
    const job = await importFiles(
      {
        project: "acme",
        by: ADA,
        files: [
          { name: "export.md", type: "text/markdown", bytes: enc(MARKDOWN) },
          { name: "hello.pdf", type: "application/pdf", bytes: pdf },
          { name: "billing.html", type: "text/html", bytes: enc(HTML) },
        ],
      },
      { today: () => TODAY },
    );
    expect(job.kind).toBe("files");
    const done = await finished("acme", job.id);
    expect(done.state).toBe("done");
    expect(done.total).toBe(3);
    expect(done.done).toBe(3);
    expect(done.created).toEqual({
      trusted: 0,
      reference: 3,
      suggestions: 0,
      skipped: 0,
    });

    const history = await knowledgeRepo.call("history", "acme", undefined, 10);
    const imports = history.filter((c) => c.subject.startsWith("Import files"));
    expect(imports).toHaveLength(1);
    expect(imports[0]!.author).toBe("Ada");
    expect(imports[0]!.subject).toBe("Import files: 3");

    const md = await read("sources/files/export.md");
    expect(md?.item).toMatchObject({
      title: "Exporting a project",
      kind: "answer",
      trust: "reference",
      status: "active",
      origin: "file",
      sources: ["file:export.md"],
      dependsOn: [],
      validAsOf: TODAY,
    });
    expect(md?.body.trim()).toBe(MARKDOWN.trim());
    expect(
      await knowledgeRepo.call(
        "readAttachment",
        "acme",
        "attachments/file+export/export.md",
      ),
    ).toEqual(enc(MARKDOWN));

    const hello = await read("sources/files/hello.md");
    expect(hello?.item.trust).toBe("reference");
    expect(hello?.item.sources).toEqual(["file:hello.pdf"]);
    expect(hello?.body).toContain("Hello");
    expect(
      await knowledgeRepo.call(
        "readAttachment",
        "acme",
        "attachments/file+hello/hello.pdf",
      ),
    ).toEqual(pdf);

    const billing = await read("sources/files/billing.md");
    expect(billing?.item.title).toBe("Billing FAQ");
    expect(billing?.body).not.toContain("<");
  });

  test("a file with a credential is skipped and counted, never stored", async () => {
    const job = await importFiles(
      {
        project: "acme",
        by: ADA,
        files: [
          { name: "ok.md", type: "", bytes: enc("# Ok\n\nFine.\n") },
          {
            name: "keys.md",
            type: "",
            bytes: enc(
              "# Keys\n\nghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n",
            ),
          },
        ],
      },
      { today: () => TODAY },
    );
    const done = await finished("acme", job.id);
    expect(done.state).toBe("done");
    expect(done.created.reference).toBe(1);
    expect(done.created.skipped).toBe(1);
    expect(done.skippedFiles).toEqual([
      { name: "keys.md", reason: '"keys.md" looks like it holds a credential' },
    ]);
    expect(await read("sources/files/keys.md")).toBeNull();
    expect(
      await knowledgeRepo.call(
        "readAttachment",
        "acme",
        "attachments/file+keys/keys.md",
      ),
    ).toBeNull();
    expect((await read("sources/files/ok.md"))?.item.title).toBe("Ok");
  });

  test("uploading the same file again replaces it; another name with the same slug doesn't", async () => {
    const first = await importFiles(
      {
        project: "acme",
        by: ADA,
        files: [
          { name: "guide.md", type: "", bytes: enc("# Guide\n\nOld.\n") },
        ],
      },
      { today: () => TODAY },
    );
    await finished("acme", first.id);
    const second = await importFiles(
      {
        project: "acme",
        by: ADA,
        files: [
          { name: "guide.md", type: "", bytes: enc("# Guide\n\nNew.\n") },
          { name: "Guide.txt", type: "", bytes: enc("Other guide.") },
        ],
      },
      { today: () => TODAY },
    );
    expect((await finished("acme", second.id)).state).toBe("done");
    expect((await read("sources/files/guide.md"))?.body.trim()).toBe(
      "# Guide\n\nNew.",
    );
    const other = await read("sources/files/guide-2.md");
    expect(other?.item.sources).toEqual(["file:Guide.txt"]);
    expect(
      await knowledgeRepo.call(
        "readAttachment",
        "acme",
        "attachments/file+guide-2/Guide.txt",
      ),
    ).toEqual(enc("Other guide."));
  });

  test("a zip, an 11 MB file, too many files or none are refused before any job", async () => {
    const start = (
      files: Array<{ name: string; type: string; bytes: Uint8Array }>,
    ) =>
      importFiles({ project: "acme", by: ADA, files }, { today: () => TODAY });
    await expect(
      start([
        { name: "notion.zip", type: "application/zip", bytes: enc("PK") },
      ]),
    ).rejects.toThrow(ZIP_COPY);
    await expect(
      start([
        {
          name: "big.pdf",
          type: "application/pdf",
          bytes: new Uint8Array(11 * 1024 * 1024),
        },
      ]),
    ).rejects.toThrow(FILE_TOO_BIG_COPY);
    await expect(
      start(
        Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => ({
          name: `n${i}.md`,
          type: "",
          bytes: enc("x"),
        })),
      ),
    ).rejects.toThrow(TOO_MANY_FILES_COPY);
    await expect(start([])).rejects.toThrow();
    expect(await listJobs("acme")).toEqual([]);
  });
});

describe("PDFs are read in a child process", () => {
  const sleeper = [process.execPath, "-e", "await Bun.sleep(20000)"];

  test("a credential on a page past the text an item holds skips the file", async () => {
    const pdf = makePdf(["a ".repeat(150_000), `token ${TOKEN}`]);
    expect(await fileText("long.pdf", "application/pdf", pdf)).toEqual({
      error: '"long.pdf" looks like it holds a credential',
    });
  });

  test("a credential in the metadata skips the file", async () => {
    const pdf = makePdf(["Hello there."], { Title: `Key ${TOKEN}` });
    expect(await fileText("meta.pdf", "application/pdf", pdf)).toEqual({
      error: '"meta.pdf" looks like it holds a credential',
    });
  });

  test("an ordinary PDF yields its text and says whether it was cut", async () => {
    const result = await pdfTextInChild(makePdf(["Hello there.", "Page 2."]));
    expect(result).toMatchObject({ cut: false, partial: false });
    expect("text" in result && result.text).toContain("Page 2.");
  });

  test("a child past its time is killed", async () => {
    const started = Date.now();
    expect(
      await pdfTextInChild(enc("%PDF-"), { argv: sleeper, timeoutMs: 300 }),
    ).toEqual({ error: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a child past its memory is killed", async () => {
    expect(
      await pdfTextInChild(enc("%PDF-"), { argv: sleeper, maxRssBytes: 1 }),
    ).toEqual({ error: "memory" });
  });

  test("the job's signal kills the child", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error("Cancelled.")), 200);
    await expect(
      pdfTextInChild(enc("%PDF-"), {
        argv: sleeper,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Cancelled.");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a PDF too long to check in full keeps its text but isn't attached", async () => {
    const pages = Array.from(
      { length: PDF_MAX_PAGES + 1 },
      (_, i) => `Page ${i + 1}.`,
    );
    const job = await importFiles(
      {
        project: "acme",
        by: ADA,
        files: [{ name: "long.pdf", type: "", bytes: makePdf(pages) }],
      },
      { today: () => TODAY },
    );
    const done = await finished("acme", job.id);
    expect(done.state).toBe("done");
    expect(done.created.reference).toBe(1);
    expect(done.truncated).toBe(true);
    const item = await read("sources/files/long.md");
    expect(item?.body).toContain(`Page ${PDF_MAX_PAGES}.`);
    expect(item?.body).not.toContain(`Page ${PDF_MAX_PAGES + 1}.`);
    expect(
      await knowledgeRepo.call(
        "readAttachment",
        "acme",
        "attachments/file+long/long.pdf",
      ),
    ).toBeNull();
  }, 60_000);

  test("a PDF that can't be checked in time is skipped", async () => {
    // fileText reads with the default limits; the child itself is
    // checked above. Here: a broken PDF is an error, not a crash.
    expect(
      await fileText("broken.pdf", "application/pdf", enc("%PDF-1.4 junk")),
    ).toEqual({ error: expect.stringContaining("broken.pdf") });
  });
});

describe("adversarial text finishes fast", () => {
  const fast = async (fn: () => Promise<unknown>) => {
    const started = performance.now();
    await fn();
    return performance.now() - started;
  };

  test("trailing blanks, headings and tags over megabytes", async () => {
    const spaces = `x${" \t".repeat(2_000_000)}x`;
    expect(await fast(() => fileText("s.txt", "", enc(spaces)))).toBeLessThan(
      2000,
    );
    const hashes = `# a${" #".repeat(2_000_000)}x\n`;
    expect(await fast(() => fileText("h.md", "", enc(hashes)))).toBeLessThan(
      2000,
    );
    const brackets = "<".repeat(5_000_000);
    expect(await fast(() => htmlToText(brackets))).toBeLessThan(2000);
    expect(
      await fast(() => fileText("b.html", "", enc(`<p>${brackets}</p>`))),
    ).toBeLessThan(3000);
  });

  test("markdown titles keep their meaning", async () => {
    const title = async (text: string) => {
      const r = await fileText("t.md", "", enc(text));
      return "title" in r ? r.title : r.error;
    };
    expect(await title("# Hello ##\n\nx")).toBe("Hello");
    expect(await title("intro\n#\tTabbed title\t\nx")).toBe("Tabbed title");
    expect(await title("#NoSpace\nx")).toBe("t");
    expect(await title("# C# tips\nx")).toBe("C# tips");
  });
});

describe("one request", () => {
  test("two files with the same name are refused before any job", async () => {
    await expect(
      importFiles(
        {
          project: "acme",
          by: ADA,
          files: [
            { name: "a/guide.md", type: "", bytes: enc("one") },
            { name: "b/guide.md", type: "", bytes: enc("two") },
          ],
        },
        { today: () => TODAY },
      ),
    ).rejects.toThrow(DUPLICATE_NAMES_COPY);
    expect(await listJobs("acme")).toEqual([]);
  });
});
