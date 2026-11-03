/**
 * `agent-browser handoff "<what the person should do>"`: a step in a
 * browser task only the person can take (a CAPTCHA, their own sign-in, a
 * one-time code, a purchase), raised as the session's ordinary question
 * card with Done and Skip, and the answer handed back to the agent as the
 * command's output.
 *
 * It is not an agent-browser command. The bash tool answers it itself
 * (pi-bash-tool.ts) when it is the whole command, because only the run can
 * raise a card: it calls the run's ask handler, the same makeAskHandler the
 * `opensession-ask` tool uses, so the card, its Slack escalation and its
 * transcript record are the ones every question gets. A hand-off inside a
 * longer command reaches the agent-browser shim, which says how to run it
 * (session-ownership.ts).
 *
 * The agent's browser is headless on the server, so the person cannot see
 * it or take it over. The card says so: they do the step in their own
 * browser and reply, and the agent is told its own browser did not get
 * their sign-in.
 */

import type { AskUserHandler } from "../agents/slack/ask-tools";

export const BROWSER_HANDOFF_DONE = "Done";
export const BROWSER_HANDOFF_SKIP = "Skip";

export const BROWSER_HANDOFF_USAGE =
  'Usage: agent-browser handoff "<what the person should do>", as the whole bash command, with the request in quotes.';

/** Characters that make a command more than one plain hand-off once they
 *  appear outside quotes: chaining, pipes, redirects, substitution, globs. */
const SHELL_SPECIAL = /[;&|<>()$`\\*?[\]{}~#!\n]/;

/**
 * The request in `agent-browser handoff ...` when that is the whole command,
 * with its quoting undone; null for anything else, which then runs in the
 * shell as usual. Only plain words, single quotes and double quotes (with
 * `\"` and `\\`) are accepted: anything that needs a shell to read, such as
 * `$(...)` or a second command, is left to the shell.
 */
export function parseBrowserHandoff(command: string): { what: string } | null {
  const match = command.trim().match(/^agent-browser\s+handoff(?:\s+(.*))?$/s);
  if (!match) return null;
  const rest = match[1] ?? "";
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === " " || ch === "\t") {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    if (ch === "'") {
      const end = rest.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + rest.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      let text = "";
      let j = i + 1;
      for (; j < rest.length && rest[j] !== '"'; j++) {
        const c = rest[j]!;
        if (c === "$" || c === "`") return null;
        if (c === "\\" && (rest[j + 1] === '"' || rest[j + 1] === "\\")) {
          text += rest[j + 1];
          j++;
          continue;
        }
        text += c;
      }
      if (j >= rest.length) return null;
      word = (word ?? "") + text;
      i = j;
      continue;
    }
    if (SHELL_SPECIAL.test(ch)) return null;
    word = (word ?? "") + ch;
  }
  if (word !== null) words.push(word);
  return { what: words.join(" ").trim() };
}

/** The question card for one hand-off. */
export function browserHandoffQuestion(what: string) {
  return {
    header: "Browser",
    question:
      `The agent needs you to do this in your own browser: ${what}\n\n` +
      "Its browser runs on the server and can't be shown to you. " +
      "Choose Done once you have, or Skip. To pass something back, " +
      "like a code or a link, type it as your reply.",
    options: [
      {
        label: BROWSER_HANDOFF_DONE,
        description: "I did it. The agent carries on.",
      },
      {
        label: BROWSER_HANDOFF_SKIP,
        description: "Don't do this. The agent carries on without it.",
      },
    ],
    multiSelect: false,
  };
}

/** What the agent reads back for an answer, or for a card nobody answered. */
export function browserHandoffReply(
  result: { answer: string } | { unanswered: string },
): string {
  if ("unanswered" in result)
    return (
      `The hand-off was not answered: ${result.unanswered} ` +
      "Don't retry the step or work around it. Say in your reply what the " +
      "person needs to do."
    );
  const answer = result.answer.trim();
  const settled =
    "The person acted in their own browser: this session's browser is not " +
    "signed in to anything of theirs, and its page may not show what they " +
    "did. Take a fresh snapshot before you act.";
  if (answer.toLowerCase() === BROWSER_HANDOFF_DONE.toLowerCase())
    return `The person says it is done. ${settled}`;
  if (answer.toLowerCase() === BROWSER_HANDOFF_SKIP.toLowerCase())
    return (
      "The person skipped this step. Don't retry it or work around it: " +
      "carry on without it, or end the turn and say what is blocked."
    );
  return `The person replied: ${JSON.stringify(answer)}. ${settled}`;
}

/** The hand-off a run's bash tool calls: one card, one reply. */
export function makeBrowserHandoff(
  ask: AskUserHandler,
): (what: string) => Promise<string> {
  return async (what) => {
    const question = browserHandoffQuestion(what);
    const result = await ask({ questions: [question] });
    if (result.behavior === "deny")
      return browserHandoffReply({ unanswered: result.message });
    const answers =
      (result.updatedInput as { answers?: Record<string, string> }).answers ??
      {};
    const answer =
      answers[question.question] ?? Object.values(answers)[0] ?? "";
    return browserHandoffReply({ answer: String(answer) });
  };
}
