import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync, type TeamMember } from "./config";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import type { PrInfo } from "./pr-cache";

let stateRoot: string;
let priorConfig: string | undefined;
let restoreTeam: () => void;

beforeAll(async () => {
  stateRoot = join(tmpdir(), `opensession-pr-author-${crypto.randomUUID()}`);
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(
    join(stateRoot, "config.json"),
    JSON.stringify({
      repos: {
        acmeweb: {
          repo: join(stateRoot, "acme-web"),
          ghRepo: "acme/acme-web",
          label: "Acme web",
        },
      },
      policy: { githubBotLogins: ["acme-agent"] },
    }),
  );
  priorConfig = process.env.OPENSESSION_CONFIG;
  process.env.OPENSESSION_CONFIG = join(stateRoot, "config.json");
  await getConfigAsync();
  restoreTeam = __setIdentitiesForTest([
    { name: "Alex Acme", github: "alex-acme", email: "alex@example.test" },
  ] as TeamMember[]);
});

afterAll(async () => {
  restoreTeam();
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  await getConfigAsync();
  rmSync(stateRoot, { recursive: true, force: true });
});

function pr(number: number, author: string, assignees: string[] = []): PrInfo {
  return {
    url: `https://github.com/acme/acme-web/pull/${number}`,
    state: "OPEN",
    number,
    title: `PR ${number}`,
    isDraft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "",
    author,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: `2026-10-20T09:00:${String(number).padStart(2, "0")}.000Z`,
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "MERGEABLE",
    reviewRequested: [],
    reviewedBy: [],
    assignees,
  };
}

describe("recentPrRows", () => {
  it("tells team, outside and bot authors apart across the repo-wide window", async () => {
    const { recentPrRows } = await import("./pr-cache");
    const rows = recentPrRows(
      new Map([
        [
          "acmeweb",
          new Map([
            ["alex/fix", pr(1, "alex-acme")],
            ["agent/feature", pr(2, "acme-agent", ["alex-acme"])],
            ["fork/typo", pr(3, "octo-contributor")],
            ["dependabot/npm", pr(4, "app/dependabot")],
            ["fork/assigned", pr(5, "octo-helper", ["alex-acme"])],
          ]),
        ],
      ]),
    );
    const byNumber = new Map(rows.map((row) => [row.number, row]));
    expect(byNumber.get(1)).toMatchObject({
      authorKind: "team",
      person: "alex",
    });
    // The instance's own agent account is the team's, attributed by assignee.
    expect(byNumber.get(2)).toMatchObject({
      authorKind: "team",
      person: "alex",
    });
    expect(byNumber.get(3)).toMatchObject({
      authorKind: "outside",
      person: null,
    });
    expect(byNumber.get(4)).toMatchObject({ authorKind: "bot", person: null });
    // Assigning a teammate does not make the opener one of the team.
    expect(byNumber.get(5)).toMatchObject({
      authorKind: "outside",
      person: "alex",
    });
  });

  it("reads the roster when it serves rows, not when they were cached", async () => {
    const { recentPrRows } = await import("./pr-cache");
    const data = new Map([
      ["acmeweb", new Map([["fork/typo", pr(3, "octo-contributor")]])],
    ]);
    expect(recentPrRows(data)[0].authorKind).toBe("outside");
    const restore = __setIdentitiesForTest([
      { name: "Octo Contributor", github: "octo-contributor" },
    ] as TeamMember[]);
    try {
      expect(recentPrRows(data)[0].authorKind).toBe("team");
    } finally {
      restore();
    }
  });
});
