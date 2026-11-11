import { describe, expect, test } from "bun:test";
import { suggestedTaskCreateInput } from "./SuggestedTaskCard";

describe("suggestedTaskCreateInput", () => {
  test("marks Start's create as a suggested task, so @Blob in it never routes", () => {
    expect(
      suggestedTaskCreateInput(
        {
          title: "Ask Blob",
          description: "",
          instructions: "@Blob check the acme deploy",
          repo: "acme",
        },
        "Ada",
        "req-1",
      ),
    ).toEqual({
      prompt: "@Blob check the acme deploy",
      repo: "acme",
      branch: undefined,
      mode: "code",
      user: "Ada",
      requestId: "req-1",
      origin: "suggested-task",
    });
  });
});
