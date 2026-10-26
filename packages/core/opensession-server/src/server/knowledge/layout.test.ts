import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isValidRepoName } from "../memory-repo/layout";
import {
  articleSlug,
  attachmentFolder,
  isArticlePath,
  isSuggestionPath,
  folderFor,
  freeSlugPath,
  isAttachmentPath,
  isItemPath,
  isKnowledgeRepoName,
  issueItemPath,
  knowledgeRepoName,
  mailItemPath,
  originForPath,
  projectFromRepo,
  releaseItemPath,
  repoItemPath,
  webItemPath,
} from "./layout";

describe("knowledge layout", () => {
  test("repository names", () => {
    expect(knowledgeRepoName("acme")).toBe("knowledge-acme");
    expect(isKnowledgeRepoName("knowledge-acme")).toBe(true);
    expect(isKnowledgeRepoName("knowledge-../x")).toBe(false);
    expect(isKnowledgeRepoName("knowledge-a..b")).toBe(false);
    expect(isKnowledgeRepoName("knowledge-")).toBe(false);
    expect(isKnowledgeRepoName("team")).toBe(false);
    expect(projectFromRepo("knowledge-acme")).toBe("acme");
    expect(projectFromRepo("user-acme")).toBeNull();
    expect(() => knowledgeRepoName("../acme")).toThrow();
  });

  test("memory never treats a knowledge repo as one of its own", () => {
    expect(isValidRepoName(knowledgeRepoName("acme"))).toBe(false);
    expect(isValidRepoName(knowledgeRepoName("acme-api"))).toBe(false);
  });

  test("origin follows the folder", () => {
    expect(originForPath("sources/mail/2026-10/abc.md")).toBe("mail");
    expect(originForPath("articles/export.md")).toBe("article");
    expect(originForPath("suggestions/export.md")).toBe("suggestion");
    expect(originForPath("sources/repo/docs/export.md")).toBe("repo");
    expect(originForPath("sources/releases/v1.4.0.md")).toBe("release");
    expect(originForPath("sources/web/help.acme.example.test/a.md")).toBe(
      "web",
    );
    expect(originForPath("sources/issues/42.md")).toBe("issue");
    expect(originForPath("sources/files/handbook.md")).toBe("file");
    expect(originForPath("sources/other/x.md")).toBeNull();
    expect(originForPath("KNOWLEDGE.md")).toBeNull();
  });

  test("what counts as an item", () => {
    expect(isItemPath("articles/export.md")).toBe(true);
    expect(isItemPath("sources/mail/2026-10/abc@example.test.md")).toBe(true);
    expect(isItemPath("attachments/a/b.pdf")).toBe(false);
    expect(isItemPath("attachments/a/b.md")).toBe(false);
    expect(isItemPath("KNOWLEDGE.md")).toBe(false);
    expect(isItemPath("articles/export.pdf")).toBe(false);
    expect(isItemPath("articles/../x.md")).toBe(false);
    expect(isItemPath("articles/")).toBe(false);
    expect(isItemPath("notes.md")).toBe(false);
  });

  test("folders per origin", () => {
    expect(folderFor("article")).toBe("articles");
    expect(folderFor("suggestion")).toBe("suggestions");
    expect(folderFor("mail", { answeredAt: "2026-10-19T08:12:00Z" })).toBe(
      "sources/mail/2026-10",
    );
    expect(folderFor("web", { host: "Help.Acme.example.test" })).toBe(
      "sources/web/help.acme.example.test",
    );
    expect(folderFor("file")).toBe("sources/files");
  });

  test("free slug paths count up on collision", () => {
    expect(
      freeSlugPath(new Set(["articles/export.md"]), "articles", "Export"),
    ).toBe("articles/export-2.md");
    expect(
      freeSlugPath(
        new Set(["articles/export.md", "articles/export-2.md"]),
        "articles",
        "Export",
      ),
    ).toBe("articles/export-3.md");
    expect(freeSlugPath(new Set(), "suggestions", "Export as CSV")).toBe(
      "suggestions/export-as-csv.md",
    );
    const long = freeSlugPath(new Set(), "articles", "word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual("articles/".length + 80 + 3);
    expect(long.endsWith("-.md")).toBe(false);
  });

  test("web item paths drop the query", () => {
    expect(webItemPath("https://help.acme.example.test/a/b?x=1")).toBe(
      `sources/web/help.acme.example.test/a-b-${hash8("a/b")}.md`,
    );
    expect(webItemPath("https://help.acme.example.test/")).toBe(
      "sources/web/help.acme.example.test/index.md",
    );
    expect(() => webItemPath("ftp://help.acme.example.test/a")).toThrow();
  });

  test("mail item paths keep the Message-ID readable and safe", () => {
    expect(
      mailItemPath("<abc.123@mail.example.test>", "2026-10-19T08:12:00Z"),
    ).toBe("sources/mail/2026-10/abc.123@mail.example.test.md");
    const odd = mailItemPath("<a/b..c@x>", "2026-10-19T08:12:00Z");
    expect(isItemPath(odd)).toBe(true);
    expect(odd).not.toBe(mailItemPath("<a-b..c@x>", "2026-10-19T08:12:00Z"));
    expect(isItemPath(mailItemPath("<..>", "2026-10-19T08:12:00Z"))).toBe(true);
    expect(() => mailItemPath("<a@x>", "not a date")).toThrow();
  });

  test("repo, release and issue item paths", () => {
    expect(repoItemPath("docs/export.md")).toBe("sources/repo/docs/export.md");
    expect(repoItemPath("README.md")).toBe("sources/repo/README.md");
    expect(repoItemPath("docs/guide.rst")).toBe(
      "sources/repo/docs/guide.rst.md",
    );
    expect(() => repoItemPath("../secrets.md")).toThrow();
    expect(releaseItemPath("v1.4.0")).toBe("sources/releases/v1.4.0.md");
    expect(isItemPath(releaseItemPath("release/1.0"))).toBe(true);
    expect(issueItemPath(42)).toBe("sources/issues/42.md");
  });

  test("web slugs never collide and fold accents", () => {
    const paths = [
      "https://h.example.test/a-b",
      "https://h.example.test/a/b",
      "https://h.example.test/a_b",
      "https://h.example.test/A/B",
      "https://h.example.test/index",
      "https://h.example.test/",
    ].map(webItemPath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(webItemPath("https://h.example.test/caf%C3%A9")).toBe(
      `sources/web/h.example.test/cafe-${hash8("café")}.md`,
    );
    const nonLatin = webItemPath("https://h.example.test/%E6%97%A5%E6%9C%AC");
    expect(nonLatin).toBe(
      `sources/web/h.example.test/page-${hash8("日本")}.md`,
    );
    expect(nonLatin).not.toBe(
      webItemPath("https://h.example.test/%E4%B8%AD%E6%96%87"),
    );
    for (const path of paths) expect(isItemPath(path)).toBe(true);
  });

  test("item segments are plain ASCII names without a leading dot", () => {
    expect(isItemPath("articles/My Guide.md")).toBe(false);
    expect(isItemPath("articles/.hidden.md")).toBe(false);
    expect(isItemPath("articles/caf\u00e9.md")).toBe(false);
    expect(isItemPath("articles/cafe\u0301.md")).toBe(false);
    expect(isItemPath(`articles/${"a".repeat(198)}.md`)).toBe(false);
    expect(isItemPath(`articles/${"a".repeat(197)}.md`)).toBe(true);
    expect(isItemPath("sources/repo/.github/x.md")).toBe(false);
  });

  test("repo item paths make every segment safe", () => {
    const spaced = repoItemPath("docs/My Guide.md");
    expect(spaced).toBe(`sources/repo/docs/My-Guide-${hash8("My Guide")}.md`);
    expect(isItemPath(spaced)).toBe(true);
    const dotted = repoItemPath(".github/CONTRIBUTING.md");
    expect(dotted).toBe(
      `sources/repo/github-${hash8(".github")}/CONTRIBUTING.md`,
    );
    expect(isItemPath(dotted)).toBe(true);
    expect(isItemPath(repoItemPath("docs/\u00e9t\u00e9.rst"))).toBe(true);
  });

  test("mail item paths are lower case", () => {
    expect(
      mailItemPath("<ABC.123@Mail.Example.test>", "2026-10-19T08:12:00Z"),
    ).toBe("sources/mail/2026-10/abc.123@mail.example.test.md");
  });

  test("attachments are exactly attachments/<slug>/<name> with a known type", () => {
    expect(isAttachmentPath("attachments/export/guide.pdf")).toBe(true);
    expect(isAttachmentPath("attachments/export/Shot.PNG")).toBe(true);
    expect(isAttachmentPath("attachments/export/a/guide.pdf")).toBe(false);
    expect(isAttachmentPath("attachments/export/guide.html")).toBe(false);
    expect(isAttachmentPath("attachments/export/guide.svg")).toBe(false);
    expect(isAttachmentPath("attachments/export/.guide.pdf")).toBe(false);
    expect(isAttachmentPath("attachments/export/my guide.pdf")).toBe(false);
    expect(isAttachmentPath("attachments/export/guide")).toBe(false);
  });

  test("free slugs fold accents", () => {
    expect(freeSlugPath(new Set(), "articles", "Café crème")).toBe(
      "articles/cafe-creme.md",
    );
  });
});

describe("articles, suggestions and their attachments", () => {
  test("only <folder>/<slug>.md directly in the folder counts", () => {
    expect(articleSlug("articles/export.md", "articles")).toBe("export");
    expect(isArticlePath("articles/export.md")).toBe(true);
    expect(isSuggestionPath("suggestions/export.md")).toBe(true);
    for (const path of [
      "articles/a/b.md",
      "articles/../x.md",
      "articles/x.txt",
      "articles/a+b.md",
      "suggestions/export.md",
      "sources/files/x.md",
      "KNOWLEDGE.md",
    ])
      expect(isArticlePath(path)).toBe(false);
    expect(isSuggestionPath("suggestions/nested/x.md")).toBe(false);
  });

  test("a suggestion's folder never meets an article's", () => {
    expect(attachmentFolder("articles/export.md")).toBe("attachments/export");
    expect(attachmentFolder("suggestions/export.md")).toBe(
      "attachments/suggestion+export",
    );
    expect(attachmentFolder("sources/files/export.md")).toBe(null);
    expect(isAttachmentPath("attachments/suggestion+export/a.png")).toBe(true);
  });
});

function hash8(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}
