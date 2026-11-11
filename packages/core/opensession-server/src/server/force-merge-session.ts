/**
 * force_merge_pull_request for one session: who may confirm, and which PR.
 * The card and the merge itself live in force-merge.ts.
 */
import {
  ForceMergeError,
  requestForceMerge,
  type ForceMergeOutcome,
} from "./force-merge";
import type { MergeMethod } from "./pr-contract";
import { findSession } from "./session-cache";
import { raiseMergeCard } from "./supervisor-merge-queue";
import { resolvePrReadinessTarget } from "./session-repos";
import { trustedGithubTeammate } from "./shared/user-mappings";
import { webAuthRequired } from "./web-auth";

/** Why this session cannot open a force-merge card, or null. */
export function forceMergeRefusal(
  session:
    | {
        automation?: unknown;
        automationId?: unknown;
        automationDescendantPolicy?: unknown;
      }
    | undefined,
  user: string | undefined,
  signInRequired: boolean,
): string | null {
  if (
    session?.automation ||
    session?.automationId ||
    session?.automationDescendantPolicy
  )
    return "Force merge is not available to automation runs.";
  if (!signInRequired)
    return "Force merge needs GitHub sign-in on this instance, so a person can confirm it. Merge the PR on GitHub instead.";
  if (!trustedGithubTeammate(user))
    return "Only a signed-in teammate driving this session can confirm a force merge.";
  return null;
}

type ForceMergeInput = {
  url?: string;
  repo?: string;
  number?: number;
  reason: string;
  method?: MergeMethod;
};

/**
 * The tool's call. A supervisor session raises the card and returns at
 * once (supervisor-merge-queue.ts): the owner's answer arrives later as a
 * notice, so the conversation is never held up waiting for a tap. Any other
 * session waits for the answer as before.
 */
export async function forceMergeToolCall(
  sessionId: string,
  user: string | undefined,
  input: ForceMergeInput,
  signal?: AbortSignal,
): Promise<ForceMergeOutcome | string> {
  const session = findSession(sessionId);
  if (!session?.supervisor)
    return forceMergeForSession(sessionId, user, input, signal);
  const refusal = forceMergeRefusal(session, user, webAuthRequired());
  if (refusal) throw new ForceMergeError(refusal, 403);
  const target = await resolvePrReadinessTarget(sessionId, input);
  return raiseMergeCard(sessionId, {
    target,
    reason: input.reason,
    ...(input.method ? { method: input.method } : {}),
    driver: trustedGithubTeammate(user)!,
    owner: user!,
  });
}

export async function forceMergeForSession(
  sessionId: string,
  user: string | undefined,
  input: ForceMergeInput,
  signal?: AbortSignal,
): Promise<ForceMergeOutcome> {
  const session = findSession(sessionId);
  const refusal = forceMergeRefusal(session, user, webAuthRequired());
  if (refusal) throw new ForceMergeError(refusal, 403);
  const target = await resolvePrReadinessTarget(sessionId, input);
  return requestForceMerge(
    sessionId,
    {
      target,
      reason: input.reason,
      ...(input.method ? { method: input.method } : {}),
      driver: trustedGithubTeammate(user)!,
      // A supervisor session is Blob asking; the driver still confirms.
      ...(session?.supervisor ? { requestedBy: "Blob" as const } : {}),
    },
    signal,
  );
}
