/**
 * One Anthropic turn's account binding, run in a process of its own, the way
 * a run host binds it: createPiRuntimeBinding with the real pool pick and
 * session memory, stopped before pi loads. Prints the picked account id and
 * the policy step that chose it (never the token).
 *
 * Usage: bun claude-pick-process.ts <user> <session-key>
 * The account store comes from OPENSESSION_CLAUDE_ACCOUNTS_PATH.
 */
import { pickClaudeAccount } from "../claude-account-pick";
import { createPiRuntimeBinding } from "../pi-runtime-binding";

const [user, sessionKey] = process.argv.slice(2);
const STOP = "stop before pi loads";
let result: { id?: string; reason?: string } = {};
try {
  await createPiRuntimeBinding({
    providerID: "anthropic",
    modelID: "claude-sonnet-5-5",
    affinityKey: sessionKey || "checkout",
    claudeSessionKey: sessionKey || undefined,
    unifiedSessionId: sessionKey || "checkout",
    accountUser: user || undefined,
    excludedOpenaiAccountIds: new Set(),
    onAccountEvidence: (evidence) => {
      result = {
        id: evidence.pickedClaude?.id,
        reason: evidence.claudePickReason,
      };
    },
    dependencies: {
      loadSdk: async () => {
        throw new Error(STOP);
      },
      readOpenaiAccounts: () => undefined,
      pickOpenaiAccount: () => ({ error: "unused" }),
      buildSeededOpenaiAuth: () => ({ error: "unused" }),
      pickClaudeAccount,
      buildThirdPartyProviderPlan: () => ({ error: "unused" }),
      bindXaiAccount: async () => ({ error: "unused" }),
    },
  });
} catch (error) {
  if ((error as Error).message !== STOP) {
    console.log(JSON.stringify({ error: (error as Error).message }));
    process.exit(1);
  }
}
console.log(JSON.stringify(result));
