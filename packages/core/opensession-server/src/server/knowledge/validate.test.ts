import { describe, expect, test } from "bun:test";
import { renderArticle } from "./format";
import {
  MAX_ARTICLE_BYTES,
  MAX_ATTACHMENT_BYTES,
  validateKnowledgeFile,
} from "./validate";

const encode = (text: string) => new TextEncoder().encode(text);

function article(body = "Use Export → CSV.") {
  return renderArticle(
    {
      title: "Exporting a project as CSV",
      kind: "answer",
      trust: "trusted",
      status: "active",
      origin: "article",
      topics: ["export"],
      sources: [],
      dependsOn: ["repo:docs/export.md"],
      validAsOf: "2026-10-20",
    },
    body,
  );
}

function binary(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(encode("%PDF-1.7\n"));
  bytes[20] = 0;
  bytes[21] = 0xff;
  return bytes;
}

describe("knowledge file validation", () => {
  test("a valid article passes", () => {
    expect(
      validateKnowledgeFile("articles/export.md", encode(article())),
    ).toEqual([]);
  });

  test("KNOWLEDGE.md is allowed without front matter", () => {
    expect(
      validateKnowledgeFile("KNOWLEDGE.md", encode("# Knowledge\n\nText\n")),
    ).toEqual([]);
  });

  test("a binary attachment up to 10 MB passes", () => {
    expect(
      validateKnowledgeFile("attachments/export/guide.pdf", binary(1024)),
    ).toEqual([]);
    expect(
      validateKnowledgeFile(
        "attachments/export/guide.pdf",
        binary(MAX_ATTACHMENT_BYTES),
      ),
    ).toEqual([]);
    expect(
      validateKnowledgeFile(
        "attachments/export/guide.pdf",
        binary(MAX_ATTACHMENT_BYTES + 1),
      ).map((p) => p.message),
    ).toEqual([
      `File is ${MAX_ATTACHMENT_BYTES + 1} bytes; the limit is ${MAX_ATTACHMENT_BYTES}.`,
    ]);
  });

  test("binary files outside attachments/ fail", () => {
    expect(
      validateKnowledgeFile("articles/x.pdf", binary(1024)).map(
        (p) => p.message,
      ),
    ).toEqual(["Binary files belong under attachments/."]);
  });

  test("an item over 256 KB fails", () => {
    const text = article("x".repeat(MAX_ARTICLE_BYTES));
    expect(
      validateKnowledgeFile("articles/big.md", encode(text)).map(
        (p) => p.message,
      ),
    ).toEqual([
      `File is ${encode(text).byteLength} bytes; the limit is ${MAX_ARTICLE_BYTES}. Split it into smaller articles.`,
    ]);
  });

  test("an item holding a GitHub token fails on its line", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const text = article(`Line one\nUse ${token} here`);
    const lines = text.split("\n");
    const tokenLine = lines.findIndex((l) => l.includes(token)) + 1;
    expect(validateKnowledgeFile("articles/x.md", encode(text))).toEqual([
      {
        path: "articles/x.md",
        line: tokenLine,
        message:
          "Looks like a GitHub token. Knowledge never stores credentials.",
      },
    ]);
  });

  test("symbolic links fail", () => {
    expect(
      validateKnowledgeFile("articles/x.md", encode(article()), "120000").map(
        (p) => p.message,
      ),
    ).toEqual(["Symbolic links are not allowed in knowledge."]);
  });

  test("format problems are reported with 1-based lines", () => {
    const text = article().replace("kind: answer", "kind: faq");
    expect(validateKnowledgeFile("articles/x.md", encode(text))).toEqual([
      {
        path: "articles/x.md",
        line: 3,
        message: 'Unknown kind "faq". Use one of: answer, internal.',
      },
    ]);
  });

  test("files outside the layout fail", () => {
    expect(
      validateKnowledgeFile("notes.md", encode(article())).map(
        (p) => p.message,
      ),
    ).toEqual([
      "Knowledge files belong under articles/, suggestions/, sources/ or attachments/.",
    ]);
    expect(
      validateKnowledgeFile("attachments/x.pdf", binary(10)).map(
        (p) => p.message,
      ),
    ).toEqual(["Attachments go in attachments/<article>/<file name>."]);
  });

  test("front matter must be in the rendered form", () => {
    const text = article();
    const variants = [
      text.replace(
        "kind: answer\ntrust: trusted",
        "trust: trusted\nkind: answer",
      ),
      text.replace("title: Exporting", "title:  Exporting"),
      text.replace("topics: [export]", "topics:\n  - export"),
      text.replace(
        "title: Exporting a project as CSV",
        'title: "Exporting a project as CSV"',
      ),
      text.replace(/\n/g, "\r\n"),
      text.replace("validAsOf: 2026-10-20", "validAsOf: 2026-10-20 # checked"),
    ];
    for (const variant of variants)
      expect(
        validateKnowledgeFile("articles/x.md", encode(variant)).map(
          (p) => p.message,
        ),
      ).toEqual([NOT_CANONICAL]);
  });

  test("only regular non-executable files", () => {
    for (const mode of ["040000", "100664", "100600", ""])
      expect(
        validateKnowledgeFile("articles/x.md", encode(article()), mode).map(
          (p) => p.message,
        ),
      ).toEqual(["Only regular files are allowed in knowledge."]);
    expect(
      validateKnowledgeFile("articles/x.md", encode(article()), "100755").map(
        (p) => p.message,
      ),
    ).toEqual(["Executable files are not allowed."]);
  });

  test("text files must be UTF-8", () => {
    const bytes = new Uint8Array([...encode(article()), 0xc3, 0x28, 0x0a]);
    expect(
      validateKnowledgeFile("articles/x.md", bytes).map((p) => p.message),
    ).toEqual(["File isn't UTF-8 text."]);
    expect(
      validateKnowledgeFile(
        "attachments/export/notes.txt",
        new Uint8Array([0x61, 0xff, 0x62]),
      ).map((p) => p.message),
    ).toEqual(["File isn't UTF-8 text."]);
  });

  test("attachments need a known file type", () => {
    expect(
      validateKnowledgeFile(
        "attachments/export/page.html",
        encode("<p>x</p>"),
      ).map((p) => p.message),
    ).toEqual([
      "Attachments must be png, jpg, jpeg, gif, webp, pdf, md or txt files.",
    ]);
    expect(
      validateKnowledgeFile("attachments/export/a/b.pdf", binary(10)).map(
        (p) => p.message,
      ),
    ).toEqual(["Attachments go in attachments/<article>/<file name>."]);
  });

  test("names must be plain ASCII without a leading dot", () => {
    for (const path of [
      "articles/cafe\u0301.md",
      "articles/caf\u00e9.md",
      "articles/.x.md",
      "articles/a b.md",
    ])
      expect(
        validateKnowledgeFile(path, encode(article())).map((p) => p.message),
      ).toEqual([BAD_NAME]);
  });

  test("a trusted item under suggestions/ fails", () => {
    const text = renderArticle(
      {
        title: "Export",
        kind: "answer",
        trust: "trusted",
        status: "active",
        origin: "suggestion",
        topics: [],
        sources: [],
        dependsOn: [],
        validAsOf: "2026-10-20",
      },
      "Body",
    );
    expect(
      validateKnowledgeFile("suggestions/export.md", encode(text)).map(
        (p) => p.message,
      ),
    ).toEqual(["Items under suggestions/ are reference until approved."]);
  });
});

const NOT_CANONICAL =
  "The front matter isn't in the standard form (one `key: value` per line, keys in the usual order). Save it from Knowledge to fix it.";
const BAD_NAME =
  "File and folder names may use only letters, digits and @ . _ + -, and can't start with a dot.";
