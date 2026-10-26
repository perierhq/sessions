// Injection strikes by sender: how many messages from one address an inbox
// saw flagged as an attempt to instruct the agent (routing.ts). A new
// conversation from that sender starts with them, so a second attempt in a
// fresh thread is still the second strike. One record per sender in the
// `support-inboxes` namespace under `strikes:<digest>` (the keyed digest
// retention.ts uses, never the address; listInboxes skips it by shape),
// counts per inbox; "Forget this customer" deletes it. A store failure is logged and reads as no earlier strikes
// (the conversation's own flags still count). Nothing runs at import.
import { catalogDocuments } from "../catalog-documents";

interface StrikeRecord {
  inboxes: Record<string, number>;
}

let docs: ReturnType<typeof catalogDocuments> | undefined;
const store = () => (docs ??= catalogDocuments("support-inboxes"));

async function keyOf(address: string): Promise<string> {
  return `strikes:${await (await import("./retention")).customerDigest(address)}`;
}

function count(value: unknown, inboxId: string): number {
  const n = (value as StrikeRecord | null)?.inboxes?.[inboxId];
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

/** Strikes of `address` in inbox `inboxId` so far. */
export async function senderStrikes(
  inboxId: string,
  address: string,
): Promise<number> {
  try {
    return count(await store().get(await keyOf(address)), inboxId);
  } catch (error) {
    console.warn(
      "[support] sender strikes unreadable:",
      error instanceof Error ? error.name : typeof error,
    );
    return 0;
  }
}

/** One more strike for `address` in `inboxId`; resolves to the count. */
export async function addSenderStrike(
  inboxId: string,
  address: string,
): Promise<number> {
  let next = 0;
  try {
    await store().update<StrikeRecord>(await keyOf(address), (value) => {
      next = count(value, inboxId) + 1;
      const inboxes = { ...((value as StrikeRecord | null)?.inboxes ?? {}) };
      inboxes[inboxId] = next;
      return { inboxes };
    });
  } catch (error) {
    console.warn(
      "[support] sender strike not recorded:",
      error instanceof Error ? error.name : typeof error,
    );
  }
  return next;
}

/** Forget every strike of `address` (retention.ts forgetCustomer). */
export async function forgetSenderStrikes(address: string): Promise<void> {
  await store().delete(await keyOf(address));
}
