/**
 * podman-image-rollout — keeps This machine (container)'s sandbox image
 * current across releases without a person.
 *
 * The image tag hashes its Containerfile (podman-image.ts), so a release that
 * changes it names an image this host has never built. Qualification built
 * the old one; nothing else would build the new one, and every start would
 * refuse until someone requalified by hand. Instead, while the connection is
 * qualified and on:
 *
 * - boot checks for the current tag and builds it in the background;
 * - a start that finds it missing starts that build, or joins the one
 *   running, and waits for it (SandboxImageBuildingError; the start's wait
 *   is bounded in sandbox/reliability.ts);
 * - only a build that failed refuses, with the existing requalify message,
 *   and only for PODMAN_IMAGE_RETRY_AFTER_MS: the next start after that
 *   tries again.
 *
 * After a build, and at boot when the current image is already there, the
 * images of earlier releases are removed (prunePodmanImages: the current
 * and the previous one stay, and any image a container still uses). The
 * pass is recorded as the `sandbox-image-prune` housekeeping job, with what
 * it removed, in `/api/health`. It never fails the build.
 *
 * Each build is a Sandboxes-page operation (kind "repair", as it repairs a
 * qualified connection) through the same startSandboxOperation a
 * qualification uses, and `podman build` itself runs once per tag
 * (ensurePodmanImage). The qualification's own facts and self-test stand:
 * every start still verifies its pod's firewall; only the recorded image tag
 * moves.
 */

import {
  noteHousekeepingReclaimed,
  runHousekeeping,
} from "../../housekeeping-health";
import { RunSetupRefusedError } from "../../run-setup-refusal";
import {
  getSandboxConnection,
  sandboxConnectionReady,
  setPodmanConnectionFacts,
} from "../connections";
import { startSandboxOperation, type SandboxOperation } from "../operations";
import { SandboxImageBuildingError } from "../reliability";
import {
  PODMAN_PROVIDER_LABEL,
  runPodman,
  type PodmanRunner,
} from "./podman-cli";
import {
  ensurePodmanImage,
  podmanImageTag,
  prunePodmanImages,
} from "./podman-image";

const LOG = "[sandbox:podman-image]";

/** How long a failed build is the answer before a start tries again. */
export const PODMAN_IMAGE_RETRY_AFTER_MS = 60_000;

const STAGE = "Building the sandbox image";

/** For `/api/health` and `opensession doctor`. */
export interface PodmanImageHealth {
  tag: string;
  state: "current" | "building" | "failed";
  at: string;
  error?: string;
}

type OperationUpdate = (
  patch: Pick<SandboxOperation, "stage"> &
    Partial<Pick<SandboxOperation, "detail" | "progress">>,
) => void;

export interface PodmanImageRolloutDeps {
  run: PodmanRunner;
  /** The image this release runs. */
  tag: () => string;
  /** The connection is qualified and on. */
  ready: () => boolean;
  build: (run: PodmanRunner, log: (line: string) => void) => Promise<string>;
  startOperation: (
    input: { kind: "repair"; provider: "podman" },
    body: (update: OperationUpdate) => Promise<void>,
  ) => unknown;
  /** Record the built tag on the connection's qualification facts. */
  recordTag: (tag: string) => void;
  /** Remove earlier releases' images, keeping `current` and the previous. */
  prune: (
    run: PodmanRunner,
    current: string,
  ) => Promise<{ removed: string[]; bytes: number }>;
  now: () => number;
  platform: string;
}

export interface PodmanImageRollout {
  /** What a start that found `tag` missing throws: the build to wait for,
   *  or the refusal. */
  missingImageError(tag: string): Error;
  /** Boot: start building the current image when it is missing. Never
   *  throws, and does not wait for the build. */
  check(): Promise<void>;
  health(): PodmanImageHealth | undefined;
}

function missingMessage(tag: string, failure?: string): string {
  const base = `the sandbox image ${tag} is missing. Requalify ${PODMAN_PROVIDER_LABEL} in Workspace → Sandboxes.`;
  return failure ? `${base} Building it failed: ${failure}` : base;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 600);
}

export function createPodmanImageRollout(
  deps: PodmanImageRolloutDeps,
): PodmanImageRollout {
  let building: { tag: string; done: Promise<string> } | undefined;
  let failed: { tag: string; at: number; error: string } | undefined;
  let health: PodmanImageHealth | undefined;
  const iso = () => new Date(deps.now()).toISOString();

  /** One prune pass, recorded; never throws. */
  function prune(current: string): Promise<void> {
    return runHousekeeping("sandbox-image-prune", async () => {
      const { removed, bytes } = await deps.prune(deps.run, current);
      if (removed.length)
        console.log(
          `${LOG} removed ${removed.length} old image(s): ${removed.join(", ")}`,
        );
      noteHousekeepingReclaimed("sandbox-image-prune", {
        count: removed.length,
        bytes,
      });
    }).then(() => {});
  }

  function build(tag: string): Promise<string> {
    if (building?.tag === tag) return building.done;
    let settle!: {
      resolve: (tag: string) => void;
      reject: (e: unknown) => void;
    };
    const done = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Waiters may all have gone; the failure is still recorded below.
    done.catch(() => {});
    building = { tag, done };
    health = { tag, state: "building", at: iso() };
    console.log(`${LOG} building ${tag} for this release`);
    const body = async (update: OperationUpdate): Promise<void> => {
      update({ stage: STAGE, progress: 10, detail: tag });
      try {
        const built = await deps.build(deps.run, (line) =>
          update({ stage: STAGE, progress: 50, detail: line }),
        );
        deps.recordTag(built);
        failed = undefined;
        health = { tag: built, state: "current", at: iso() };
        console.log(`${LOG} built ${built}`);
        settle.resolve(built);
        void prune(built);
      } catch (error) {
        const text = errorText(error);
        failed = { tag, at: deps.now(), error: text };
        health = { tag, state: "failed", at: iso(), error: text };
        console.error(`${LOG} building ${tag} failed: ${text}`);
        settle.reject(error);
        throw error;
      } finally {
        if (building?.done === done) building = undefined;
      }
    };
    try {
      deps.startOperation({ kind: "repair", provider: "podman" }, body);
    } catch (error) {
      // The operation could not be recorded; the build still runs.
      console.warn(`${LOG} could not record the build operation:`, error);
      void body(() => {}).catch(() => {});
    }
    return done;
  }

  return {
    missingImageError(tag) {
      if (building?.tag === tag)
        return new SandboxImageBuildingError(building.done);
      if (!deps.ready()) return new RunSetupRefusedError(missingMessage(tag));
      if (
        failed?.tag === tag &&
        deps.now() - failed.at < PODMAN_IMAGE_RETRY_AFTER_MS
      )
        return new RunSetupRefusedError(missingMessage(tag, failed.error));
      return new SandboxImageBuildingError(build(tag));
    },

    async check() {
      if (deps.platform !== "linux" || !deps.ready()) return;
      const tag = deps.tag();
      if (building?.tag === tag) return;
      try {
        const exists = await deps.run(["image", "exists", tag]);
        if (exists.exitCode === 0) {
          health = { tag, state: "current", at: iso() };
          await prune(tag);
          return;
        }
        if (exists.exitCode !== 1)
          throw new Error(
            `podman image exists failed (exit ${exists.exitCode}): ${(exists.stderr || exists.stdout).trim().slice(0, 300)}`,
          );
        void build(tag);
      } catch (error) {
        const text = errorText(error);
        health = { tag, state: "failed", at: iso(), error: text };
        console.warn(`${LOG} could not check ${tag}: ${text}`);
      }
    },

    health: () => health,
  };
}

function recordTag(tag: string): void {
  const facts = getSandboxConnection("podman")?.podman;
  if (facts && facts.imageTag !== tag)
    setPodmanConnectionFacts({ ...facts, imageTag: tag });
}

let rollout: PodmanImageRollout | undefined;

/** This process's rollout. Created on first use, never at import. */
export function podmanImageRollout(): PodmanImageRollout {
  rollout ??= createPodmanImageRollout({
    run: runPodman,
    tag: () => podmanImageTag(),
    ready: () => sandboxConnectionReady("podman"),
    build: ensurePodmanImage,
    startOperation: startSandboxOperation,
    recordTag,
    prune: prunePodmanImages,
    now: Date.now,
    platform: process.platform,
  });
  return rollout;
}

/** The rollout's state, or undefined before it checked anything. */
export function podmanImageHealth(): PodmanImageHealth | undefined {
  return rollout?.health();
}

let started = false;

/** Idempotent; called from boot. The check runs in the background: the
 *  build can take minutes and must not hold the gateway's startup. */
export function startPodmanImageRollout(): void {
  if (started) return;
  started = true;
  void podmanImageRollout().check();
}
