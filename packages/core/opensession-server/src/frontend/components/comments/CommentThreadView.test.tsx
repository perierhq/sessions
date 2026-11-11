// The comment thread's "Assign to" picker: the people first, then the
// bots (Blob) with their picture and Bot badge, never the current
// assignee. Rendered to markup; no effects run.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  fetch: () => new Promise<Response>(() => {}),
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { AssigneeOption, assigneeChoices } = await import("./CommentThreadView");

const ada = { name: "Ada", fullName: "Ada Lovelace" };
const bob = { name: "Bob", fullName: "Bob Example" };
const blob = {
  kind: "bot" as const,
  name: "Blob",
  fullName: "Blob",
  image: "/bot-icon/blob.png",
};

describe("assigneeChoices", () => {
  test("lists the people, then the bots", () => {
    expect(assigneeChoices([ada, bob], [blob]).map((p) => p.name)).toEqual([
      "Ada",
      "Bob",
      "Blob",
    ]);
    expect(assigneeChoices([ada], [blob]).at(-1)?.kind).toBe("bot");
  });

  test("leaves out the current assignee, a bot included", () => {
    expect(
      assigneeChoices([ada, bob], [blob], "bob").map((p) => p.name),
    ).toEqual(["Ada", "Blob"]);
    expect(
      assigneeChoices([ada, bob], [blob], "Blob").map((p) => p.name),
    ).toEqual(["Ada", "Bob"]);
  });

  test("a bot listed among the people still sits with the bots", () => {
    expect(assigneeChoices([ada, blob], [blob]).map((p) => p.name)).toEqual([
      "Ada",
      "Blob",
    ]);
  });
});

describe("AssigneeOption", () => {
  test("Blob's row has its picture and the Bot badge", () => {
    const html = renderToStaticMarkup(
      <AssigneeOption person={blob} me="Ada" />,
    );
    expect(html).toContain("/bot-icon/blob.png");
    expect(html).toContain("Blob");
    expect(html).toContain(">Bot<");
  });

  test("a person's row has no badge, and yours says so", () => {
    const html = renderToStaticMarkup(<AssigneeOption person={ada} me="ada" />);
    expect(html).toContain("Ada (you)");
    expect(html).not.toContain(">Bot<");
  });
});
