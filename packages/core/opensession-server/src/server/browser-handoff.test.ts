import { describe, expect, test } from "bun:test";
import {
  BROWSER_HANDOFF_DONE,
  BROWSER_HANDOFF_SKIP,
  browserHandoffReply,
  makeBrowserHandoff,
  parseBrowserHandoff,
} from "./browser-handoff";

describe("parseBrowserHandoff", () => {
  test("reads the request from a hand-off command on its own", () => {
    expect(
      parseBrowserHandoff(
        `agent-browser handoff "Sign in to acme.example.test"`,
      ),
    ).toEqual({ what: "Sign in to acme.example.test" });
    expect(
      parseBrowserHandoff(
        `  agent-browser handoff 'Approve the "login" prompt'  `,
      ),
    ).toEqual({ what: `Approve the "login" prompt` });
    expect(
      parseBrowserHandoff(`agent-browser handoff Accept the cookie banner`),
    ).toEqual({ what: "Accept the cookie banner" });
    expect(
      parseBrowserHandoff(`agent-browser handoff "Say \\"yes\\" on the phone"`),
    ).toEqual({ what: `Say "yes" on the phone` });
    expect(parseBrowserHandoff("agent-browser handoff")).toEqual({ what: "" });
  });

  test("leaves every other command to the shell", () => {
    for (const command of [
      "agent-browser open https://example.test",
      "agent-browser snapshot -i",
      `echo "agent-browser handoff 'x'"`,
      `agent-browser handoff "x" && agent-browser snapshot`,
      `agent-browser handoff "x"; rm -rf ./acme`,
      `agent-browser handoff "x" | tee out.txt`,
      `agent-browser handoff "$(cat note.txt)"`,
      "agent-browser handoff `cat note.txt`",
      `agent-browser handoff "unterminated`,
      "agent-browser handoffs x",
      `agent-browser --session other handoff "x"`,
      "agent-browser handoff x\nagent-browser snapshot",
    ])
      expect(parseBrowserHandoff(command)).toBeNull();
  });
});

describe("makeBrowserHandoff", () => {
  test("raises one question card with Done and Skip and says where to act", async () => {
    const asked: Record<string, unknown>[] = [];
    const handoff = makeBrowserHandoff(async (input) => {
      asked.push(input);
      const [question] = input.questions as { question: string }[];
      return {
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: { [question!.question]: BROWSER_HANDOFF_DONE },
        },
      };
    });
    const reply = await handoff("Sign in to acme.example.test");
    expect(asked).toHaveLength(1);
    const [question] = asked[0]!.questions as {
      question: string;
      header: string;
      options: { label: string }[];
      multiSelect: boolean;
    }[];
    expect(question!.question).toContain("Sign in to acme.example.test");
    // Without a live view the person acts in their own browser; the card
    // has to say so, or they look for a browser they cannot see.
    expect(question!.question).toContain("your own browser");
    expect(question!.options.map((option) => option.label)).toEqual([
      BROWSER_HANDOFF_DONE,
      BROWSER_HANDOFF_SKIP,
    ]);
    expect(question!.multiSelect).toBe(false);
    expect(reply).toBe(browserHandoffReply({ answer: BROWSER_HANDOFF_DONE }));
  });

  test("passes a typed reply back and a dismissal as not answered", async () => {
    const typed = makeBrowserHandoff(async (input) => ({
      behavior: "allow",
      updatedInput: { ...input, answers: { q: "The code is 424242" } },
    }));
    expect(await typed("Read me the code")).toContain("The code is 424242");
    const dismissed = makeBrowserHandoff(async () => ({
      behavior: "deny",
      message: "Nobody answered in time.",
    }));
    const reply = await dismissed("Sign in");
    expect(reply).toContain("Nobody answered in time.");
    expect(reply).toContain("Don't retry");
  });
});

describe("browserHandoffReply", () => {
  test("tells the agent what each answer means for its next step", () => {
    const done = browserHandoffReply({ answer: BROWSER_HANDOFF_DONE });
    expect(done).toContain("fresh snapshot");
    // The person acted in their own browser: this session's browser did not
    // get their sign-in.
    expect(done).toContain("not signed in");
    const skip = browserHandoffReply({ answer: BROWSER_HANDOFF_SKIP });
    expect(skip).toContain("Don't retry");
    expect(browserHandoffReply({ answer: "  done  " })).toBe(done);
    expect(browserHandoffReply({ answer: "Use the staging login" })).toContain(
      '"Use the staging login"',
    );
  });
});
