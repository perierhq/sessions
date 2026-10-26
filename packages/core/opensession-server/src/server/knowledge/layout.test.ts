import { describe, expect, test } from "bun:test";
import { isValidRepoName } from "../memory-repo/layout";
import {
  folderFor,
  freeSlugPath,
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
      "sources/web/help.acme.example.test/a-b.md",
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
});
