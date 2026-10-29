// A release that changes the sandbox image must not need a person: a
// qualified This machine (container) builds the new image on its own, once,
// with its progress on the Sandboxes page, and a start that finds it missing
// waits for that build instead of refusing.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  housekeepingHealth,
  resetHousekeepingHealthForTest,
} from "../../housekeeping-health";
import { isRunSetupRefusal } from "../../run-setup-refusal";
import {
  isSandboxImageBuildingError,
  SandboxImageBuildingError,
} from "../reliability";
import type { PodmanRunner } from "./podman-cli";
import {
  createPodmanImageRollout,
  PODMAN_IMAGE_RETRY_AFTER_MS,
  type PodmanImageRolloutDeps,
} from "./podman-image-rollout";

const TAG = "localhost/opensession-sandbox:0123456789abcdef";

function harness(over: Partial<PodmanImageRolloutDeps> = {}) {
  let exists = false;
  let now = 1_000_000;
  const builds: Array<{ finish: () => void; fail: (e: Error) => void }> = [];
  const operations: Array<{
    input: { kind: string; provider: string };
    stages: string[];
    result?: "succeeded" | "failed";
  }> = [];
  const recorded: string[] = [];
  const pruned: string[] = [];
  const run: PodmanRunner = async (argv) => ({
    exitCode: argv[0] === "image" && argv[1] === "exists" && exists ? 0 : 1,
    stdout: "",
    stderr: "",
  });
  const deps: PodmanImageRolloutDeps = {
    run,
    tag: () => TAG,
    ready: () => true,
    platform: "linux",
    now: () => now,
    build: (_run, log) =>
      new Promise<string>((resolve, reject) => {
        log(`building ${TAG}`);
        builds.push({
          finish: () => {
            exists = true;
            resolve(TAG);
          },
          fail: reject,
        });
      }),
    startOperation: (input, body) => {
      const op = { input, stages: [] as string[] } as (typeof operations)[0];
      operations.push(op);
      void body((patch) => op.stages.push(patch.stage)).then(
        () => (op.result = "succeeded"),
        () => (op.result = "failed"),
      );
      return op;
    },
    recordTag: (tag) => recorded.push(tag),
    prune: async (_run, current) => {
      pruned.push(current);
      return { removed: [], bytes: 0 };
    },
    ...over,
  };
  return {
    rollout: createPodmanImageRollout(deps),
    builds,
    operations,
    recorded,
    pruned,
    setExists: (value: boolean) => (exists = value),
    advance: (ms: number) => (now += ms),
  };
}

const settle = () => Bun.sleep(1);

afterEach(() => resetHousekeepingHealthForTest());

describe("podman image rollout", () => {
  test("a qualified connection builds a missing image once and every start waits on it", async () => {
    const h = harness();
    const first = h.rollout.missingImageError(TAG);
    const second = h.rollout.missingImageError(TAG);
    expect(isSandboxImageBuildingError(first)).toBe(true);
    expect(isSandboxImageBuildingError(second)).toBe(true);
    expect(h.builds).toHaveLength(1);
    expect(h.operations).toHaveLength(1);
    expect(h.operations[0]!.input).toEqual({
      kind: "repair",
      provider: "podman",
    });
    expect(h.operations[0]!.stages[0]).toBe("Building the sandbox image");
    expect(h.rollout.health()).toMatchObject({ tag: TAG, state: "building" });
    h.builds[0]!.finish();
    await (first as SandboxImageBuildingError).ready;
    await (second as SandboxImageBuildingError).ready;
    await settle();
    expect(h.operations[0]!.result).toBe("succeeded");
    expect(h.recorded).toEqual([TAG]);
    expect(h.rollout.health()).toMatchObject({ tag: TAG, state: "current" });
  });

  test("a connection that is not qualified or is off keeps the refusal", () => {
    const h = harness({ ready: () => false });
    const error = h.rollout.missingImageError(TAG);
    expect(isRunSetupRefusal(error)).toBe(true);
    expect(error.message).toBe(
      `the sandbox image ${TAG} is missing. Requalify This machine (container) in Workspace → Sandboxes.`,
    );
    expect(h.builds).toHaveLength(0);
    expect(h.operations).toHaveLength(0);
  });

  test("only a failed build refuses, with the existing message, until it may be tried again", async () => {
    const h = harness();
    const waiting = h.rollout.missingImageError(
      TAG,
    ) as SandboxImageBuildingError;
    h.builds[0]!.fail(new Error("podman image build failed (exit 125)"));
    await expect(waiting.ready).rejects.toThrow("exit 125");
    await settle();
    expect(h.operations[0]!.result).toBe("failed");
    expect(h.rollout.health()).toMatchObject({
      tag: TAG,
      state: "failed",
      error: "podman image build failed (exit 125)",
    });

    const refused = h.rollout.missingImageError(TAG);
    expect(isRunSetupRefusal(refused)).toBe(true);
    expect(refused.message).toStartWith(
      `the sandbox image ${TAG} is missing. Requalify This machine (container) in Workspace → Sandboxes.`,
    );
    expect(refused.message).toContain("exit 125");
    expect(h.builds).toHaveLength(1);

    h.advance(PODMAN_IMAGE_RETRY_AFTER_MS + 1);
    expect(isSandboxImageBuildingError(h.rollout.missingImageError(TAG))).toBe(
      true,
    );
    expect(h.builds).toHaveLength(2);
    expect(h.operations).toHaveLength(2);
  });

  test("boot builds the new image after an update, and leaves a current one alone", async () => {
    const missing = harness();
    await missing.rollout.check();
    expect(missing.builds).toHaveLength(1);
    expect(missing.rollout.health()).toMatchObject({ state: "building" });
    // A start during that build joins it.
    expect(
      isSandboxImageBuildingError(missing.rollout.missingImageError(TAG)),
    ).toBe(true);
    expect(missing.builds).toHaveLength(1);
    missing.builds[0]!.finish();
    await settle();
    expect(missing.rollout.health()).toMatchObject({ state: "current" });

    const current = harness();
    current.setExists(true);
    await current.rollout.check();
    expect(current.builds).toHaveLength(0);
    expect(current.operations).toHaveLength(0);
    expect(current.rollout.health()).toMatchObject({
      tag: TAG,
      state: "current",
    });
  });

  test("boot does nothing for an unqualified connection or off Linux", async () => {
    for (const over of [{ ready: () => false }, { platform: "darwin" }]) {
      const h = harness(over);
      await h.rollout.check();
      expect(h.builds).toHaveLength(0);
      expect(h.rollout.health()).toBeUndefined();
    }
  });

  test("a boot check that cannot ask podman builds nothing", async () => {
    const h = harness({
      run: async () => ({ exitCode: 125, stdout: "", stderr: "no podman" }),
    });
    await h.rollout.check();
    expect(h.builds).toHaveLength(0);
    expect(h.rollout.health()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("no podman"),
    });
  });

  test("old images go after a build, and at boot when the image is current", async () => {
    const h = harness({
      prune: async (_run, current) => {
        expect(current).toBe(TAG);
        return {
          removed: ["localhost/opensession-sandbox:00000000000000aa"],
          bytes: 1_200_000_000,
        };
      },
    });
    const waiting = h.rollout.missingImageError(TAG);
    expect(isSandboxImageBuildingError(waiting)).toBe(true);
    h.builds[0]!.finish();
    await (waiting as SandboxImageBuildingError).ready;
    await settle();
    expect(housekeepingHealth()["sandbox-image-prune"]?.lastReclaimed).toEqual({
      count: 1,
      bytes: 1_200_000_000,
    });

    await h.rollout.check();
    await settle();
    expect(
      housekeepingHealth()["sandbox-image-prune"]?.reclaimedSinceBoot,
    ).toEqual({ count: 2, bytes: 2_400_000_000 });
  });

  test("a failed prune is recorded and never fails the build", async () => {
    const h = harness({
      prune: async () => {
        throw new Error("podman image ls: database is locked");
      },
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const waiting = h.rollout.missingImageError(TAG);
      h.builds[0]!.finish();
      expect(await (waiting as SandboxImageBuildingError).ready).toBe(TAG);
      await settle();
    } finally {
      errors.mockRestore();
    }
    expect(h.rollout.health()?.state).toBe("current");
    expect(housekeepingHealth()["sandbox-image-prune"]?.lastError).toContain(
      "database is locked",
    );
  });
});
