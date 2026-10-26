import { describe, expect, test } from "bun:test";
import { runOwnWorktree } from "./pi-run-authority";

describe("runOwnWorktree", () => {
  const shared = "/srv/acme/repos/app";

  test("a registered repository's worktree is the run's own", () => {
    expect(
      runOwnWorktree({
        cwd: "/srv/acme/worktrees/app-fix",
        remote: false,
        repoCheckout: shared,
      }),
    ).toBe("/srv/acme/worktrees/app-fix");
  });

  test("the shared checkout, or a folder in it, is never the run's own", () => {
    expect(
      runOwnWorktree({ cwd: shared, remote: false, repoCheckout: shared }),
    ).toBeUndefined();
    expect(
      runOwnWorktree({
        cwd: `${shared}/packages/web`,
        remote: false,
        repoCheckout: shared,
      }),
    ).toBeUndefined();
  });

  test("symlinks resolve before the comparison", () => {
    expect(
      runOwnWorktree({
        cwd: "/srv/acme/link-to-app",
        remote: false,
        repoCheckout: shared,
        canonical: (path) => (path === "/srv/acme/link-to-app" ? shared : path),
      }),
    ).toBeUndefined();
  });

  test("a repo-less directory has no bounds to trust", () => {
    expect(
      runOwnWorktree({ cwd: "/srv/acme/scratch", remote: false }),
    ).toBeUndefined();
  });

  test("a Sandbox workspace is its own machine", () => {
    expect(runOwnWorktree({ cwd: "/home/acme/app", remote: true })).toBe(
      "/home/acme/app",
    );
  });
});
