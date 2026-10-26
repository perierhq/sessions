import { describe, expect, test } from "bun:test";
import {
  mcpServerAllowedForRun,
  askBashDenyReason,
  declaredRunFailure,
  describeUsageLimitReset,
  hasRunStatusDeclaration,
  isClaudeBridgeLaunchError,
  isClaudeSubscriptionError,
  isClaudeUsageLimitError,
  isClaudeMalformedTerminalError,
  isProviderOverloadError,
  isTransientRunError,
  isUpstreamIdleStallError,
  usageLimitResetAt,
} from "./runner-shared";

describe("isClaudeUsageLimitError", () => {
  test("recognizes provider notices before they leak into streamed output", () => {
    expect(
      isClaudeUsageLimitError(
        "You've reached your Fable 5.1 limit. Switch to another model to continue.",
        false,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageLimitError(
        "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
        false,
      ),
    ).toBe(true);
  });
});

describe("isClaudeSubscriptionError", () => {
  test("recognizes subscription and organization policy blocks", () => {
    expect(
      isClaudeSubscriptionError(
        "Claude Max subscription issue. Check your subscription status.",
      ),
    ).toBe(true);
    expect(
      isClaudeSubscriptionError(
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
      ),
    ).toBe(true);
    expect(isClaudeSubscriptionError("ordinary tool failure")).toBe(false);
  });
});

describe("isClaudeBridgeLaunchError", () => {
  test("matches the two shapes the agent SDK emits", () => {
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary at /home/ubuntu/projects/opensession/node_modules/.bin/claude exists but failed to launch.",
      ),
    ).toBe(true);
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary not found at /opt/claude. Please ensure Claude Code is installed via native installer.",
      ),
    ).toBe(true);
  });

  test("does not claim faults that belong to another recovery lane", () => {
    // Usage limits and subscription faults are account-level and own their own
    // (much longer) sideline; a model's own words about a launch must never
    // wedge the account either.
    expect(isClaudeBridgeLaunchError("Claude AI usage limit reached")).toBe(
      false,
    );
    expect(
      isClaudeBridgeLaunchError(
        "Claude Max subscription issue. Check your subscription status.",
      ),
    ).toBe(false);
    expect(
      isClaudeBridgeLaunchError(
        "the deploy script failed to launch the server",
      ),
    ).toBe(false);
    expect(isClaudeBridgeLaunchError("command not found: claude")).toBe(false);
    expect(isClaudeBridgeLaunchError("")).toBe(false);
  });
});

describe("isUpstreamIdleStallError", () => {
  test("matches Meridian's idle-guard kill", () => {
    // The exact shape from the 2026-08-03 bks-019fc819 incident.
    expect(
      isUpstreamIdleStallError("Upstream stalled: no data for 160090ms"),
    ).toBe(true);
    expect(
      isUpstreamIdleStallError(
        "AI_APICallError: Upstream stalled: no data for 91150ms",
      ),
    ).toBe(true);
  });

  test("does not match other stalls or provider errors", () => {
    expect(isUpstreamIdleStallError("Claude AI usage limit reached")).toBe(
      false,
    );
    expect(isUpstreamIdleStallError("upstream timeout while connecting")).toBe(
      false,
    );
    expect(isUpstreamIdleStallError("no data received")).toBe(false);
    expect(isUpstreamIdleStallError("")).toBe(false);
  });
});

describe("isClaudeMalformedTerminalError", () => {
  test("matches Claude's malformed user-terminal diagnostic", () => {
    expect(
      isClaudeMalformedTerminalError(
        "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null\n" +
          "Subprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas.",
      ),
    ).toBe(true);
    expect(
      isTransientRunError(
        "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
    ).toBe(true);
  });

  test("does not mistake normal Claude errors or model text for the diagnostic", () => {
    expect(
      isClaudeMalformedTerminalError(
        "Claude Code returned an error result: You've hit your weekly limit",
      ),
    ).toBe(false);
    expect(
      isClaudeMalformedTerminalError("Please explain the ede_diagnostic field"),
    ).toBe(false);
    expect(isClaudeMalformedTerminalError("")).toBe(false);
  });
});

describe("isTransientRunError", () => {
  test("recovers when the Claude binary fails to launch", () => {
    expect(
      isTransientRunError(
        "Claude Code native binary at /home/ubuntu/.local/bin/claude exists but failed to launch.",
      ),
    ).toBe(true);
  });
});

describe("isProviderOverloadError", () => {
  test("matches provider-declared overloads", () => {
    expect(
      isProviderOverloadError(
        "Our servers are currently overloaded. Please try again later.",
      ),
    ).toBe(true);
    expect(isProviderOverloadError("overloaded_error")).toBe(true);
  });

  test("does not match unrelated transient failures", () => {
    expect(isProviderOverloadError("socket hang up")).toBe(false);
    expect(isProviderOverloadError("OpenAI usage limit reached")).toBe(false);
  });
});

describe("declaredRunFailure", () => {
  test("a failed declaration is returned with its reason, last line wins", () => {
    expect(
      declaredRunFailure(
        "summary…\nSCAN STATUS: failed — claude CLI auth failure",
      ),
    ).toBe("SCAN STATUS: failed — claude CLI auth failure");
    expect(declaredRunFailure("RUN STATUS: failed — dry pool")).toBe(
      "RUN STATUS: failed — dry pool",
    );
    // A closing ok clears an earlier quoted/failed line.
    expect(
      declaredRunFailure(
        "SCAN STATUS: failed — transient\nretried fine\nSCAN STATUS: ok",
      ),
    ).toBeNull();
  });

  test("ok, absent, and mid-line mentions do not declare failure", () => {
    expect(declaredRunFailure("all good\nSCAN STATUS: ok")).toBeNull();
    expect(declaredRunFailure("no status here")).toBeNull();
    // Not line-anchored ⇒ not a declaration (e.g. quoting the instruction).
    expect(
      declaredRunFailure("end with `SCAN STATUS: failed — <reason>` on errors"),
    ).toBeNull();
  });
});

describe("hasRunStatusDeclaration", () => {
  test("line-anchored status lines only", () => {
    expect(hasRunStatusDeclaration("done\nSCAN STATUS: ok")).toBe(true);
    expect(hasRunStatusDeclaration("done\nRUN STATUS: failed — x")).toBe(true);
    expect(hasRunStatusDeclaration("mentions SCAN STATUS: ok inline")).toBe(
      false,
    );
    expect(hasRunStatusDeclaration("")).toBe(false);
  });
});

describe("describeUsageLimitReset", () => {
  test("returns the account's own words, whatever the phrasing", () => {
    expect(
      describeUsageLimitReset(
        "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
      ),
    ).toBe("Aug 20, 9am (UTC)");
    expect(
      describeUsageLimitReset(
        "You've hit your session limit · resets 12:50pm (UTC)",
      ),
    ).toBe("12:50pm (UTC)");
    expect(describeUsageLimitReset("5-hour limit reached ∙ resets 3am")).toBe(
      "3am",
    );
  });

  test("no reset stated means no opinion", () => {
    expect(
      describeUsageLimitReset("You're out of usage credits."),
    ).toBeUndefined();
    expect(describeUsageLimitReset("")).toBeUndefined();
  });
});

describe("usageLimitResetAt", () => {
  // A fixed "now" so these never drift: 2026-08-18T18:54:02Z, the minute the
  // weekly-limit failure this parser was written for actually happened.
  const now = Date.UTC(2026, 7, 18, 18, 54, 2);

  test("a dated weekly reset benches for days, not the one-hour default", () => {
    const at = usageLimitResetAt(
      "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
      now,
    );
    expect(at).toBe(Date.UTC(2026, 7, 20, 9, 0));
    // The whole point: far beyond the hour markExhausted would have used.
    expect(at! - now).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  test("a bare time means the next occurrence of it", () => {
    // 3am has passed today ⇒ tomorrow.
    expect(usageLimitResetAt("5-hour limit reached ∙ resets 3am", now)).toBe(
      Date.UTC(2026, 7, 19, 3, 0),
    );
    // 11:30pm is still ahead today.
    expect(usageLimitResetAt("limit · resets 11:30pm (UTC)", now)).toBe(
      Date.UTC(2026, 7, 18, 23, 30),
    );
  });

  test("a date with no year picks the occurrence ahead of now", () => {
    const dec = Date.UTC(2026, 11, 30, 12, 0);
    expect(usageLimitResetAt("resets Jan 2, 9am (UTC)", dec)).toBe(
      Date.UTC(2027, 0, 2, 9, 0),
    );
  });

  test("refuses anything it cannot vouch for, so the caller keeps its default", () => {
    // No time of day.
    expect(usageLimitResetAt("resets soon", now)).toBeUndefined();
    // No reset at all.
    expect(
      usageLimitResetAt("You're out of usage credits.", now),
    ).toBeUndefined();
    // Unknown month.
    expect(usageLimitResetAt("resets Foo 20, 9am (UTC)", now)).toBeUndefined();
    // Beyond the 14-day ceiling: a mis-parse must never bench a healthy
    // account for weeks, which would be worse than the churn this replaces.
    expect(usageLimitResetAt("resets Sep 30, 9am (UTC)", now)).toBeUndefined();
  });
});

describe("askBashDenyReason", () => {
  test("allows plain reads", () => {
    expect(askBashDenyReason("cat README.md")).toBeNull();
    expect(askBashDenyReason("ls -la src")).toBeNull();
    expect(askBashDenyReason("git log --oneline -5")).toBeNull();
    expect(askBashDenyReason("jq '.runs[0]' file.json")).toBeNull();
    expect(askBashDenyReason("gh pr list --state open")).toBeNull();
    expect(askBashDenyReason("systemctl is-active opensession")).toBeNull();
    expect(askBashDenyReason("date +%s")).toBeNull();
    expect(askBashDenyReason("whoami")).toBeNull();
    expect(askBashDenyReason("id -u")).toBeNull();
    expect(askBashDenyReason("uname -a")).toBeNull();
    expect(askBashDenyReason("printenv TMPDIR")).toBeNull();
    expect(askBashDenyReason("readlink -f /home/ubuntu")).toBeNull();
    expect(askBashDenyReason("realpath /home/ubuntu")).toBeNull();
  });

  test("every pipeline segment must be allowed", () => {
    expect(askBashDenyReason("git log --oneline | head -5")).toBeNull();
    expect(askBashDenyReason("cat f.json | jq '.a' | wc -l")).toBeNull();
    // The allowed prefix must not smuggle the write.
    expect(askBashDenyReason("cat x && rm y")).toContain("rm y");
    expect(askBashDenyReason("ls; touch pwned")).toContain("touch pwned");
    expect(askBashDenyReason("cat f | tee out.txt")).toContain("tee out.txt");
  });

  test("denies writes and unlisted commands with an actionable reason", () => {
    const reason = askBashDenyReason("rm -rf /tmp/x");
    expect(reason).toContain("read-only allowlist");
    expect(askBashDenyReason("git push")).not.toBeNull();
    expect(askBashDenyReason("git add .")).not.toBeNull();
    // sed is allowed only as a print-only `sed -n` (see below).
    expect(askBashDenyReason("sed -i 1,5p file")).not.toBeNull();
    expect(askBashDenyReason("python3 -c 'print(1)'")).not.toBeNull();
    expect(askBashDenyReason("gh api repos/o/r -X POST")).not.toBeNull();
    expect(askBashDenyReason("systemctl restart opensession")).not.toBeNull();
  });

  test("refuses command and process substitution outright", () => {
    expect(askBashDenyReason("echo $(rm -rf /)")).toContain("substitution");
    expect(askBashDenyReason("echo `id`")).toContain("substitution");
    expect(askBashDenyReason('echo "$(id)"')).toContain("substitution");
    expect(askBashDenyReason("diff <(cat a) <(cat b)")).toContain(
      "substitution",
    );
  });

  test("redirection: fd dups and /dev/null pass, file writes do not", () => {
    expect(askBashDenyReason("ls missing 2>&1")).toBeNull();
    expect(askBashDenyReason("cat big > /dev/null")).toBeNull();
    expect(askBashDenyReason("ls 2>/dev/null")).toBeNull();
    expect(askBashDenyReason("echo hi > /tmp/f")).toContain("redirection");
    expect(askBashDenyReason("cat a >> b")).toContain("redirection");
    expect(askBashDenyReason("cmd &> log.txt")).toContain("redirection");
  });

  test("quoting does not hide separators or unquote them wrongly", () => {
    // A quoted semicolon is data, not a separator: still one jq segment.
    expect(askBashDenyReason("jq '.a; .b' f.json")).toBeNull();
    // Literal $( inside single quotes is data too.
    expect(askBashDenyReason("grep -n '$(x)' file")).toBeNull();
  });
});

// The read work PR reviews actually do: a third of their bash calls were
// refused (`cd` into their own worktree, `| head`, `sed -n 1,40p`,
// `git -C <worktree> diff`) and agents retried the same refusal.
describe("askBashDenyReason: ordinary read work", () => {
  const ws = "/srv/acme/worktrees/acme-review";
  const ok = (command: string) =>
    expect(askBashDenyReason(command, { workspace: ws }), command).toBeNull();
  const refused = (command: string) =>
    expect(
      askBashDenyReason(command, { workspace: ws }),
      command,
    ).not.toBeNull();

  test("cd within the workspace", () => {
    ok(`cd ${ws} && git diff origin/main...HEAD`);
    ok(`cd ${ws}; git log --oneline -5`);
    ok(`cd "${ws}" && ls`);
    ok("cd packages/web && ls");
    ok(`cd ${ws}/packages/web/src && rg -n foo`);
    refused("cd /etc && cat passwd");
    refused(`cd ${ws}/../other && ls`);
    refused("cd ~ && ls");
    refused("cd $HOME && ls");
    refused("cd && ls");
    refused("cd - && ls");
    // cd itself never writes, but the rest of the line is still screened.
    refused(`cd ${ws} && rm -rf src`);
    // The session's scratch dir is the other place its tools may work.
    expect(
      askBashDenyReason("cd /srv/acme/scratch/s1/memory && ls", {
        workspace: ws,
        scratchDir: "/srv/acme/scratch/s1",
      }),
    ).toBeNull();
    refused("cd /srv/acme/scratch/s1/memory && ls");
    // Without a known workspace, cd stays refused.
    expect(askBashDenyReason(`cd ${ws} && ls`)).not.toBeNull();
  });

  test("a refused cd says where commands already run", () => {
    const reason = askBashDenyReason("cd /etc && ls", { workspace: ws });
    expect(reason).toContain(ws);
  });

  test("git -C into the workspace reads like plain git", () => {
    ok(`git -C ${ws} diff origin/main...HEAD --stat`);
    ok(`git -C ${ws} log --oneline -10`);
    ok(`git -C ${ws} show HEAD:README.md`);
    ok(`git -C ${ws} status --short`);
    ok(`git --no-pager -C ${ws} log -3`);
    refused(`git -C ${ws} push origin HEAD`);
    refused(`git -C ${ws} commit -m x`);
    refused("git -C /etc log");
  });

  test("bare pipeline filters", () => {
    ok("git log --oneline | head");
    ok("git diff --stat | tail");
    ok("git ls-files | wc");
    ok("git ls-files | sort");
    ok("git ls-files | sort -u");
    ok("rg -l foo | sort | uniq -c | sort -rn");
    ok("git log --format=%an | sort -t'|' -k2 -rn");
    ok("git diff | cat");
    ok("echo");
    ok("true");
    ok("git log --format=%s | cut -c1-80");
  });

  test("sed prints, deletes or substitutes on stdout only", () => {
    ok("sed -n '1,40p' src/a.ts");
    ok("sed -n 80,125p src/a.ts");
    ok("git show HEAD:src/a.ts | sed -n '1,8p'");
    ok("sed -n '1,5p;20,25p' a.ts");
    ok("sed -n '$p' a.ts");
    ok("sed -n '/^export/p' a.ts");
    ok("sed -n -e 1,5p -e 9p a.ts");
    ok("sed -nE '/a|b/p' a.ts");
    refused("sed -n -i 1,5p a.ts");
    refused("sed -i -n 1,5p a.ts");
    refused("sed -n --in-place 1,5p a.ts");
    refused("sed -ni 1,5p a.ts");
    refused("sed -n '1,5w out.txt' a.ts");
    refused("sed -n '1,5p;w out.txt' a.ts");
    refused("sed -n '1e touch x' a.ts");
    refused("sed -n -f script.sed a.ts");
    ok("sed '1,5p' a.ts");
    ok("grep -h x a.css | sed 's/:.*//' | sort | uniq -c");
    ok("sed -E 's/^ -\\s+\"([a-z]+)\".*/\\1/' a.json");
    ok("sed 's#a#b#g; /^$/d' a.txt");
    refused("sed 's/a/b/w out.txt' a.txt");
    refused("sed 's/a/b/e' a.txt");
    refused("sed '1r /etc/passwd' a.txt");
    refused("sed '1q5' a.txt");
    refused('sed -n "$X" a.ts');
  });

  test("awk without system, pipes or output redirection", () => {
    ok("awk 'NR>=80 && NR<=110' a.ts");
    ok("git log --format='%an' | awk '{print $NF}'");
    ok("awk -F: '{ if ($3 > 5) print $1 }' a.txt");
    ok("awk -v n=3 'NR<=n' a.txt");
    ok('awk \'$1 == "x" || $2 == "y"\' a.txt');
    refused("awk 'BEGIN { system(\"touch x\") }'");
    refused("awk '{ print > \"out.txt\" }' a.txt");
    refused("awk '{ print $1 >> \"out.txt\" }' a.txt");
    refused("awk '{ print | \"sh\" }' a.txt");
    refused("awk 'BEGIN { \"date\" | getline d }'");
    refused("awk -f prog.awk a.txt");
    refused("awk -i inplace '{print}' a.txt");
    refused("awk -o out.txt '{print}' a.txt");
    refused("awk '@load \"x\"; {print}' a.txt");
    refused('awk "$PROG" a.txt');
  });

  test("sort and uniq without an output file", () => {
    refused("sort -o out.txt a.txt");
    refused("sort -uo out.txt a.txt");
    refused("sort --output=out.txt a.txt");
    refused("sort --compress-program=sh a.txt");
    ok("uniq -c a.txt");
    ok("uniq -f 2 a.txt");
    refused("uniq a.txt out.txt");
  });

  test("find without -exec, -delete or file-writing actions", () => {
    ok("find . -name '*.ts' -newer a.ts");
    ok("find src -type f | head -20");
    refused("find . -name '*.tmp' -delete");
    refused("find . -exec rm {} ;");
    refused("find . -execdir touch x {} +");
    refused("find . -ok rm {} ;");
    refused("find . -fprint out.txt");
    refused("find . -fls out.txt");
  });

  test("read-only git and gh verbs seen in reviews", () => {
    ok("git ls-tree -r --name-only origin/main");
    ok("git range-diff origin/main..abc123 origin/main..HEAD");
    ok("git tag --sort=-version:refname");
    ok("git tag -l 'v0.*' --sort=-v:refname");
    ok("git tag");
    ok("git remote -v");
    ok("git --version");
    ok("gh pr diff 12 --repo acme/app");
    ok("gh issue view 9 --json title,body,comments");
    refused("git tag v1.0.0");
    refused("git tag -d v1.0.0");
    refused("git tag -a v1 -m x");
    refused("git tag --sort=refname v1");
    refused("git remote add x https://example.test/x.git");
    refused("gh issue comment 9 --body x");
  });
});

test("Allow agents opens a people-restricted server to runs without a user only", () => {
  expect(
    mcpServerAllowedForRun("logs", ["Ada"], undefined, [], true, true),
  ).toBe(true);
  // Only where the run's project ticks it for the run's role.
  expect(mcpServerAllowedForRun("logs", ["Ada"], undefined, [], true)).toBe(
    false,
  );
  expect(mcpServerAllowedForRun("logs", ["Ada"], undefined, [])).toBe(false);
  // A person who isn't listed still doesn't get it.
  expect(mcpServerAllowedForRun("logs", ["Ada"], "Bo", [], true, true)).toBe(
    false,
  );
  expect(
    mcpServerAllowedForRun("apple-release", ["Ada"], undefined, [], true, true),
  ).toBe(false);
});
