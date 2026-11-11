import { describe, expect, test } from "bun:test";
import type { RouteContext } from "./context";
import { createBlobMentionSender, SUGGESTED_TASK_ORIGIN } from "./sessions";

function ctx(authUser: RouteContext["authUser"]): RouteContext {
  return { authUser } as RouteContext;
}

const ada = ctx({ login: "ada", name: "Ada Lovelace" });

describe("createBlobMentionSender", () => {
  test("a signed-in person's own create may route @Blob", () => {
    expect(createBlobMentionSender(ada, {})).toBe("Ada");
  });

  test("a suggested task started as written never routes @Blob", () => {
    expect(
      createBlobMentionSender(ada, {
        origin: SUGGESTED_TASK_ORIGIN,
      }),
    ).toBeUndefined();
  });

  test("origin can't turn routing on without sign-in", () => {
    expect(
      createBlobMentionSender(ctx(null), { origin: "typed" }),
    ).toBeUndefined();
    expect(createBlobMentionSender(ctx(null), null)).toBeUndefined();
  });
});
