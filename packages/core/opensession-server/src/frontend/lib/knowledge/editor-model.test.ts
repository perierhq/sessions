import { describe, expect, test } from "bun:test";
import type { KnowledgeItem } from "../../../shared/knowledge";
import {
  attachmentLink,
  bodyAttachments,
  editorState,
  toSave,
  validateEditor,
  withLink,
  type EditorState,
} from "./editor-model";

const TODAY = "2026-10-26";

function item(over: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    project: "acme",
    path: "articles/export.md",
    blob: "b".repeat(40),
    commit: "c".repeat(40),
    updatedAt: "2026-10-20T08:00:00Z",
    effective: "active",
    excerpt: "",
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: ["export", "csv"],
    sources: ["issue:42"],
    dependsOn: ["repo:docs/export.md"],
    validAsOf: "2026-10-20",
    validAsOfCommit: "a".repeat(40),
    ...over,
  };
}

const fresh = (over: Partial<EditorState> = {}): EditorState => ({
  ...editorState(null, TODAY),
  title: "Support hours",
  body: "We answer on weekdays.",
  ...over,
});

describe("editorState", () => {
  test("a new article is a trusted, active answer, valid as of today", () => {
    const state = editorState(null, TODAY);
    expect(state.path).toBeNull();
    expect(state.blob).toBeNull();
    expect(state.validAsOf).toBe(TODAY);
    const { fm } = toSave({ ...state, title: "Support hours", body: "Hi" });
    expect(fm.kind).toBe("answer");
    expect(fm.trust).toBe("trusted");
    expect(fm.status).toBe("active");
    expect(fm.origin).toBe("article");
    expect(fm.validAsOf).toBe(TODAY);
    expect(fm.reviewBy).toBeUndefined();
    expect(fm.validAsOfCommit).toBeUndefined();
  });

  test("an item round-trips, keeping what the editor doesn't show", () => {
    const read = item({
      origin: "mail",
      trust: "reference",
      suggestedBy: "Pat",
      answeredAt: "2026-10-19T08:12:00Z",
      reviewBy: "2027-01-31",
    });
    const state = editorState({ item: read, body: "Body\n" }, TODAY);
    expect(state.path).toBe(read.path);
    expect(state.blob).toBe(read.blob);
    expect(state.topics).toBe("export, csv");
    expect(state.dependsOn).toBe("repo:docs/export.md");
    const { fm, body } = toSave(state);
    expect(body).toBe("Body\n");
    expect(fm).toEqual({
      title: read.title,
      kind: "answer",
      trust: "reference",
      status: "active",
      origin: "mail",
      topics: ["export", "csv"],
      sources: ["issue:42"],
      dependsOn: ["repo:docs/export.md"],
      validAsOf: "2026-10-20",
      validAsOfCommit: "a".repeat(40),
      reviewBy: "2027-01-31",
      suggestedBy: "Pat",
      answeredAt: "2026-10-19T08:12:00Z",
    });
  });
});

describe("toSave", () => {
  test("lists are trimmed, blank lines and repeats dropped", () => {
    const { fm } = toSave(
      fresh({
        topics: " Export ,, csv, export ",
        dependsOn: "repo:docs/export.md\n\n  issue:42  \nrepo:docs/export.md",
      }),
    );
    expect(fm.topics).toEqual(["export", "csv"]);
    expect(fm.dependsOn).toEqual(["repo:docs/export.md", "issue:42"]);
  });

  test("leaving needs-check drops the check note", () => {
    const read = item({
      status: "needs-check",
      effective: "needs-check",
      check: { reason: "docs/export.md changed", since: "2026-10-25" },
    });
    const state = editorState({ item: read, body: "x" }, TODAY);
    expect(toSave(state).fm.check).toEqual(read.check!);
    expect(toSave({ ...state, status: "active" }).fm.check).toBeUndefined();
  });

  test("a person marking an item needs-check writes a check note", () => {
    const { fm } = toSave(fresh({ status: "needs-check" }));
    expect(fm.check).toEqual({ reason: "Marked by a person", since: TODAY });
  });
});

describe("validateEditor", () => {
  test("a filled-in new article has no errors", () => {
    expect(validateEditor(fresh(), TODAY)).toEqual({});
  });

  test("review by must come after valid as of", () => {
    const errors = validateEditor(
      fresh({ validAsOf: "2026-10-20", reviewBy: "2026-10-19" }),
      TODAY,
    );
    expect(errors.reviewBy).toBe("Review by must be after Valid as of");
    expect(
      validateEditor(fresh({ validAsOf: TODAY, reviewBy: TODAY }), TODAY)
        .reviewBy,
    ).toBe("Review by must be after Valid as of");
  });

  test("every depends-on line must parse", () => {
    const errors = validateEditor(
      fresh({ dependsOn: "repo:docs/export.md\nrepo:../x" }),
      TODAY,
    );
    expect(errors.dependsOn).toBe("Not a dependency: repo:../x");
  });

  test("sources need a known prefix", () => {
    expect(validateEditor(fresh({ sources: "docs" }), TODAY).sources).toBe(
      "Not a source: docs",
    );
    expect(
      validateEditor(fresh({ sources: "file:handbook.pdf" }), TODAY),
    ).toEqual({});
  });

  test("title, valid as of and body are required", () => {
    const errors = validateEditor(
      fresh({ title: "  ", validAsOf: "", body: " \n" }),
      TODAY,
    );
    expect(errors.title).toBe("Add a title");
    expect(errors.validAsOf).toBe("Pick the day it was last known right");
    expect(errors.body).toBe("Write the article");
  });

  test("title is at most 200 characters", () => {
    expect(validateEditor(fresh({ title: "a".repeat(201) }), TODAY).title).toBe(
      "Keep the title under 200 characters",
    );
  });

  test("valid as of can't be in the future", () => {
    expect(
      validateEditor(fresh({ validAsOf: "2026-10-27" }), TODAY).validAsOf,
    ).toBe("Valid as of can't be in the future");
  });

  test("topics: at most 12, each at most 60 characters", () => {
    const many = Array.from({ length: 13 }, (_, i) => `t${i}`).join(", ");
    expect(validateEditor(fresh({ topics: many }), TODAY).topics).toBe(
      "At most 12 topics",
    );
    expect(
      validateEditor(fresh({ topics: "x".repeat(61) }), TODAY).topics,
    ).toBe("Keep each topic under 60 characters");
  });
});

describe("attachments", () => {
  test("a link relative to the article, an image shown inline", () => {
    expect(
      attachmentLink("articles/export.md", "attachments/export/shot one.png"),
    ).toBe("![shot one.png](../attachments/export/shot%20one.png)");
    expect(
      attachmentLink("articles/export.md", "attachments/export/guide.pdf"),
    ).toBe("[guide.pdf](../attachments/export/guide.pdf)");
  });

  test("a new link goes on its own line at the end", () => {
    expect(withLink("", "[a](x)")).toBe("[a](x)\n");
    expect(withLink("Text\n\n\n", "[a](x)")).toBe("Text\n\n[a](x)\n");
  });

  test("the body's attachment links, once each", () => {
    const body = [
      "See ![shot](../attachments/export/shot%20one.png).",
      "[guide.pdf](../attachments/export/guide.pdf) and again",
      "[guide.pdf](../attachments/export/guide.pdf)",
      "[docs](https://example.test/docs)",
    ].join("\n");
    expect(bodyAttachments("articles/export.md", body)).toEqual([
      { name: "shot one.png", path: "attachments/export/shot one.png" },
      { name: "guide.pdf", path: "attachments/export/guide.pdf" },
    ]);
  });
});
