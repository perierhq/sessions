import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { useSupportTestKernel } from "../../support/testing/kernel-fixture";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import { KnowledgeService } from "../service";
import {
  FILE_TYPES_COPY,
  FILE_TOO_BIG_COPY,
  fileText,
  importFiles,
  MAX_IMPORT_FILES,
  TOO_MANY_FILES_COPY,
  ZIP_COPY,
} from "./files";
import { __waitForJobForTest, listJobs } from "./jobs";

const kernel = useSupportTestKernel();
const TODAY = "2026-10-26";
const ADA = { name: "Ada", email: "ada@example.test" };
const enc = (text: string) => new TextEncoder().encode(text);

const helloPdf = async () =>
  new Uint8Array(await readFile(join(import.meta.dir, "testdata/hello.pdf")));

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
