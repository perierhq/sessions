import { audit } from "./audit";
import type { TurnUsage } from "./run-events";

/** The usage block pi reports on an assistant message or a compaction result. */
export interface PiReportedUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** One pi attempt's bookkeeping: usage, the audit closer and the flags its
 *  terminal, catch and finally paths read. Closures read the fields at call
 *  time, so code that runs late still sees the latest value. */
export class PiTurnLedger {
  // Cumulative usage across every assistant request in this attempt. Keep it
  // outside the run body so failures and cancellations retain the work they
  // completed before their terminal path.
  readonly usage: TurnUsage = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
  };
  requests = 0;
  sawUsage = false;
  piSessionId?: string;
  reachedTerminal = false;
  sawSettled = false;
  // Has the reader seen replay-unsafe output yet? After text or tool activity
  // escapes, rotation must continue the native session, not replay this prompt.
  // `usage_snapshot` does NOT close the walk: Pi emits a zero-token snapshot
  // with an in-band usage-limit terminal, and treating that bookkeeping event
  // as model output strands the rest of the account pool. (The Anthropic side's
  // equivalent gate is `partial.content.length === 0`.)
  sawStreamedOutput = false;
  private turnEnded = false;

  constructor(
    private readonly auditBase: Record<string, unknown>,
    private readonly started: number,
  ) {}

  // First-call-wins run closer + finally backstop (the bridgeRunEnd pattern).
  end(fields: Record<string, unknown>): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    audit({
      ...this.auditBase,
      direction: "out",
      duration_ms: Date.now() - this.started,
      ...fields,
    });
  }

  /** Fold an assistant message's usage. True when it carried usage. */
  foldAssistantUsage(u: PiReportedUsage | null | undefined): boolean {
    if (!(u && typeof u.input === "number")) return false;
    this.sawUsage = true;
    this.requests++;
    this.usage.inputTokens += u.input || 0;
    this.usage.outputTokens += u.output || 0;
    this.usage.cacheReadTokens += u.cacheRead || 0;
    this.usage.cacheCreationTokens += u.cacheWrite || 0;
    this.usage.costUsd = (this.usage.costUsd || 0) + (u.cost?.total || 0);
    this.usage.contextTokens =
      (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    return true;
  }

  /** Fold a compaction's usage, leaving contextTokens alone. True when it
   *  carried usage. */
  foldCompactionUsage(cu: PiReportedUsage | null | undefined): boolean {
    if (!(cu && typeof cu.input === "number")) return false;
    this.sawUsage = true;
    this.requests++;
    this.usage.inputTokens += cu.input || 0;
    this.usage.outputTokens += cu.output || 0;
    this.usage.cacheReadTokens += cu.cacheRead || 0;
    this.usage.cacheCreationTokens += cu.cacheWrite || 0;
    this.usage.costUsd = (this.usage.costUsd || 0) + (cu.cost?.total || 0);
    return true;
  }

  usageAuditFields(): Record<string, unknown> {
    return this.sawUsage
      ? {
          input_tokens: this.usage.inputTokens,
          output_tokens: this.usage.outputTokens,
          cache_read_input_tokens: this.usage.cacheReadTokens,
          cache_creation_input_tokens: this.usage.cacheCreationTokens,
          total_cost_usd: this.usage.costUsd,
          steps: this.requests,
        }
      : {};
  }

  /** The `usage` field of a terminal event: present once any usage arrived. */
  usageField(): { usage?: TurnUsage } {
    return this.sawUsage ? { usage: { ...this.usage } } : {};
  }

  snapshot(): TurnUsage {
    return { ...this.usage };
  }
}
