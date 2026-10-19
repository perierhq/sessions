import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { audit, summarizeText } from "./audit";
import { stagePromptImages, withImagesNote } from "./prompt-attachments";
import {
  remoteAttachmentWriter,
  type RemoteWorkspace,
} from "./remote-workspace";
import { expandSkillCommand, type LoadedSkill } from "./skill-paths";
import type { ImageInput } from "./run-events";
import { piImages } from "./pi-transcript";
import { retractPendingSteer } from "./pi-run-registry";
import { interruptPiThinkingForSteer } from "./pi-steering";
import type { PiSteerBoundary } from "./pi-tools";

/** A steer accepted for the run and not yet delivered to the model. */
export interface PiPendingSteer {
  text: string;
  images?: ImageInput[];
  steerId?: string;
}

export interface PiSteerControllerInit {
  session: AgentSession;
  /** The run's loaded skills, read when a steer arrives. */
  skills: () => LoadedSkill[];
  scratchDir: string | undefined;
  remote: RemoteWorkspace | undefined;
  signal: AbortSignal;
  boundary: PiSteerBoundary;
  auditBase: Record<string, unknown>;
}

/**
 * Mid-turn steering for one pi session: the steers accepted and not yet
 * delivered, the ordered chain every touch of pi's queue goes through, the
 * thinking-only cut, and cancellation.
 */
export class PiSteerController {
  private readonly session: AgentSession;
  private readonly skills: () => LoadedSkill[];
  private readonly scratchDir: string | undefined;
  private readonly remote: RemoteWorkspace | undefined;
  private readonly signal: AbortSignal;
  private readonly boundary: PiSteerBoundary;
  private readonly auditBase: Record<string, unknown>;

  // Steer contract: accept = enqueue + receipt. The transcript user line is
  // written only when the queued message is actually DELIVERED (its user
  // message_end below) — session.steer() resolves at enqueue time, so a
  // .then() would confirm nothing, and an optimistically-persisted line
  // marks an undelivered steer as said (queue-state reconciles receipts
  // against transcript user texts, so it would never be requeued). An
  // undelivered steer keeps its run-session receipt as the recovery
  // affordance — previous runner's failed-POST semantics.
  private readonly pendingSteers: PiPendingSteer[] = [];
  // Every touch of pi's queue goes through this chain, in call order. The
  // bookkeeping above it (pending entry, boundary flag, the caller's
  // receipt) stays synchronous; only the engine enqueue waits, because
  // staging an attachment is async and an in-process run shares the
  // gateway's event loop. Ordering the retraction rebuild on the same
  // chain means a steer still being staged is never enqueued twice, and a
  // steer retracted mid-staging is never enqueued at all.
  private queue: Promise<void> = Promise.resolve();
  // Steps still to run or running. The pump below reads it before trusting
  // pi's pendingMessageCount: a steer accepted just before the prompt
  // settled may not have reached pi's queue yet.
  private queueDepth = 0;
  // Set when a steer cut the current response short while it was only
  // thinking. Its message_end then persists nothing: the thinking was
  // superseded, and the next response starts from the steer.
  private steerCutResponse = false;

  constructor(init: PiSteerControllerInit) {
    this.session = init.session;
    this.skills = init.skills;
    this.scratchDir = init.scratchDir;
    this.remote = init.remote;
    this.signal = init.signal;
    this.boundary = init.boundary;
    this.auditBase = init.auditBase;
  }

  /** The engine queue chain; resolves once every step queued so far ran. */
  get engineQueue(): Promise<void> {
    return this.queue;
  }

  /** Engine queue steps still to run or running. */
  get engineQueueDepth(): number {
    return this.queueDepth;
  }

  /** Steers accepted and not yet delivered. */
  get pendingCount(): number {
    return this.pendingSteers.length;
  }

  private onEngineQueue(step: () => Promise<void>, what: string): void {
    this.queueDepth++;
    this.queue = this.queue
      .then(step)
      .catch((e) => {
        console.warn(`[pi-runner] ${what} failed:`, e);
      })
      .finally(() => {
        this.queueDepth--;
      });
  }

  interruptForSteer(): void {
    if (this.signal.aborted) return;
    if (!interruptPiThinkingForSteer(this.session.agent)) return;
    this.steerCutResponse = true;
    audit({
      ...this.auditBase,
      direction: "in",
      kind: "steer_interrupted_response",
    });
  }

  /** Whether a steer cut the current response; clears the flag. */
  consumeCut(): boolean {
    const cutBySteer = this.steerCutResponse;
    this.steerCutResponse = false;
    return cutBySteer;
  }

  steer(text: string, images?: ImageInput[], steerId?: string): void {
    // Same skill expansion as the prompt path. The queue holds the expanded
    // text so the delivery match stays exact; the audit line below still
    // records what the person typed.
    const entry = {
      text: expandSkillCommand(text, this.skills()),
      images,
      steerId,
    };
    this.boundary.pending = true;
    this.pendingSteers.push(entry);
    this.onEngineQueue(async () => {
      // Attached images are staged into this run's scratch dir, in this
      // process, so the note names paths the engine's tools can read (see
      // prompt-attachments.ts). The pending entry holds the noted text
      // before pi ever sees it: delivery matches pi's echo against it, and
      // a retraction replays it verbatim.
      entry.text = withImagesNote(
        entry.text,
        await stagePromptImages(
          this.scratchDir,
          images,
          this.remote ? remoteAttachmentWriter(this.remote) : undefined,
        ),
      );
      if (!this.pendingSteers.includes(entry)) return; // retracted meanwhile
      await this.session.steer(entry.text, piImages(images));
      this.interruptForSteer();
    }, "steer");
    audit({
      ...this.auditBase,
      direction: "in",
      kind: "steer_queued",
      ...summarizeText(text),
    });
  }

  retractSteer(steerId: string): boolean {
    return retractPendingSteer(this.pendingSteers, steerId, (remaining) => {
      // Pi exposes exact delivery identity only in our wrapper. Rebuild its
      // whole queue from our richer copy so duplicate text and images keep
      // their original order while the selected id disappears. The entries
      // are read when the step runs, so one still being staged replays with
      // its final (noted) text.
      this.boundary.pending = remaining.length > 0;
      this.onEngineQueue(async () => {
        this.session.clearQueue();
        for (const steer of remaining) {
          if (!this.pendingSteers.includes(steer)) continue; // delivered or retracted since
          await this.session.steer(steer.text, piImages(steer.images));
        }
      }, "steer replay");
      audit({
        ...this.auditBase,
        direction: "in",
        kind: "steer_retracted",
        steer_id: steerId,
      });
    });
  }

  /** The pending steer a delivered user message `text` stands for, removed
   *  from the queue; undefined when none is pending. */
  takeDelivered(text: string): PiPendingSteer | undefined {
    let idx = this.pendingSteers.findIndex((s) => s.text === text);
    // Skill/template expansion can rewrite a queued steer's text;
    // any user message that isn't the prompt is a delivery, so
    // fall back to the oldest pending steer but persist what was
    // actually delivered.
    if (idx === -1 && this.pendingSteers.length > 0) idx = 0;
    if (idx === -1) return undefined;
    const steer = this.pendingSteers.splice(idx, 1)[0];
    this.boundary.pending = this.pendingSteers.length > 0;
    return steer;
  }

  /** Cancellation: our registry AbortController drives session.abort(). */
  listenForAbort(): void {
    const onAbort = () => {
      void this.session.abort().catch(() => {});
    };
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener("abort", onAbort, { once: true });
  }
}
