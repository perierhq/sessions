import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamMember } from "./config";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import { classifyGithubAuthor, githubAuthorKind } from "./author-kind";

const roster = {
  isTeamLogin: (login: string) => login === "alex-acme" || login === "sam",
  ownBotLogins: ["acme-agent[bot]", "acme-machine"],
};

describe("classifyGithubAuthor", () => {
  test("a roster login is team, whatever its case or @", () => {
    expect(classifyGithubAuthor("alex-acme", roster)).toBe("team");
    expect(classifyGithubAuthor("Alex-Acme", roster)).toBe("team");
    expect(classifyGithubAuthor("@sam", roster)).toBe("team");
  });

  test("the instance's own agent accounts are team", () => {
    expect(classifyGithubAuthor("acme-agent[bot]", roster)).toBe("team");
    // gh names an App author app/<slug>; REST names it <slug>[bot].
    expect(classifyGithubAuthor("app/acme-agent", roster)).toBe("team");
    expect(classifyGithubAuthor("acme-machine", roster)).toBe("team");
  });

  test("other apps and the well-known automation accounts are bots", () => {
    for (const login of [
      "dependabot[bot]",
      "app/dependabot",
      "renovate[bot]",
      "app/renovate",
      "renovate-bot",
      "github-actions[bot]",
      "app/github-actions",
      "Copilot",
      "copilot-swe-agent[bot]",
      "app/copilot-swe-agent",
      "some-ci[bot]",
    ]) {
      expect(classifyGithubAuthor(login, roster)).toBe("bot");
    }
  });

  test("anyone else is outside the team", () => {
    expect(classifyGithubAuthor("octo-contributor", roster)).toBe("outside");
    // A bot-ish word in a person's login does not make them a bot.
    expect(classifyGithubAuthor("robotlover", roster)).toBe("outside");
    expect(classifyGithubAuthor("botanist", roster)).toBe("outside");
  });

  test("a missing author (a deleted account) is outside the team", () => {
    expect(classifyGithubAuthor("", roster)).toBe("outside");
    expect(classifyGithubAuthor(null, roster)).toBe("outside");
    expect(classifyGithubAuthor("ghost", roster)).toBe("outside");
  });
});

describe("githubAuthorKind", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = __setIdentitiesForTest([
      { name: "Alex Acme", github: "alex-acme", email: "alex@example.test" },
    ] as TeamMember[]);
  });
  afterAll(() => restore());

  test("reads the configured roster", () => {
    expect(githubAuthorKind("alex-acme")).toBe("team");
    expect(githubAuthorKind("octo-contributor")).toBe("outside");
    expect(githubAuthorKind("dependabot[bot]")).toBe("bot");
  });
});
