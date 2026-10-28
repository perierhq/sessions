import { useState } from "react";
import { ASK_CARD_SHELL } from "../lib/ask-card-classes";
import { AGENT_NAME } from "../lib/brand";
import { answerKeychainAsk } from "../lib/api/settings";
import {
  reloadKeychainAsks,
  type SessionKeychainAsk,
} from "../lib/keychain-ask-store";
import { useKeychainAsks } from "../hooks/useKeychainAsks";
import { askChoices, askCeilings } from "../lib/keychain-ask-copy";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";

type Decision = Parameters<typeof answerKeychainAsk>[1];

/**
 * A keychain ask this session made for a credential the viewer owns
 * (opensession-keychain request_credential). Only the owner ever gets one:
 * the server returns these asks to nobody else, and the answer goes through
 * the same owner-checked route as Settings. The Slack DM stays open too, and
 * whichever the owner answers first settles both.
 */
export function KeychainAskCard({ sessionId }: { sessionId: string }) {
  const asks = useKeychainAsks(sessionId);
  return (
    <>
      {asks.map((ask) => (
        <AskCard key={ask.id} sessionId={sessionId} ask={ask} />
      ))}
    </>
  );
}

function summary(ask: SessionKeychainAsk): string {
  if (ask.requestedMode === "release")
    return `${AGENT_NAME} will see the password: it types it into the sign-in page itself. Release only a test account.`;
  if (ask.run)
    return `Runs this script, up to ${ask.run.maxCalls.toLocaleString("en-US")} calls, refused beyond that. The script never sees the secret.`;
  return `The secret is never shown to the session. Calls go through the keychain broker within the credential's limits, and each one is audited.`;
}

function AskCard({
  sessionId,
  ask,
}: {
  sessionId: string;
  ask: SessionKeychainAsk;
}) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(decision: Decision) {
    setBusy(decision);
    setError(null);
    try {
      await answerKeychainAsk(ask.id, decision);
      reloadKeychainAsks(sessionId);
    } catch (caught) {
      setBusy(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't answer the request",
      );
    }
  }

  const login = ask.requestedMode === "release";
  const choices = askChoices(ask);

  return (
    <section className={ASK_CARD_SHELL} aria-label="Keychain request">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
        />
        <span className="text-label font-semibold text-dim">
          {login
            ? `${AGENT_NAME} wants the password for your login`
            : ask.run
              ? `${AGENT_NAME} wants to run a script with your credential`
              : `${AGENT_NAME} wants to borrow your credential`}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {ask.credentials.map((c, index) => {
          // What the grant may reach: the credential's own ceiling. An
          // open one is said in a warning tone.
          const ceiling = askCeilings({ ...ask, credentials: [c] })[0];
          return (
            <div key={index} className="flex flex-col">
              <p className="m-0 text-body leading-6 text-fg [overflow-wrap:anywhere]">
                <span className="font-semibold">{c.service}</span>
                {c.kind === "login" ? (
                  <>
                    : {c.username} on {c.loginUrl}
                  </>
                ) : c.host ? (
                  <> for {c.host}</>
                ) : null}
              </p>
              {c.description && (
                <p className="m-0 text-meta text-dim [overflow-wrap:anywhere]">
                  {c.description}
                </p>
              )}
              {ceiling && (
                <p
                  className={cn(
                    "m-0 text-meta font-medium [overflow-wrap:anywhere]",
                    ceiling.open ? "text-yellow" : "text-dim",
                  )}
                >
                  Allows {ceiling.text}
                </p>
              )}
            </div>
          );
        })}
        <p className="m-0 text-supporting text-fg [overflow-wrap:anywhere]">
          {ask.purpose}
        </p>
        {ask.run && (
          <p className="m-0 font-mono text-meta text-dim [overflow-wrap:anywhere]">
            {ask.run.command}
          </p>
        )}
        <p className="m-0 text-meta text-dim">
          Asked by {ask.requestedBy}
          {!login && !ask.run
            ? ` for ${ask.requestedMode === "once" ? "one call" : "7 days"}`
            : ""}
        </p>
      </div>

      <p className="m-0 text-meta text-faint">{summary(ask)}</p>
      {/* What each answer permits, so the choice is made on the terms. */}
      {choices.length > 1 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-meta text-dim">
          {choices.map((choice) => (
            <li key={choice.decision}>
              <span className="font-medium text-fg">{choice.label}:</span>{" "}
              {choice.terms}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="m-0 text-meta text-red" role="alert">
          {error}
        </p>
      )}

      {/* The mode the agent asked for is the primary choice, unless the
          credential has no limits: then a single call is. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="soft"
          size="lg"
          disabled={busy !== null}
          onClick={() => void submit("decline")}
        >
          Decline
        </Button>
        {choices.map((choice) => (
          <Button
            key={choice.decision}
            variant={choice.primary ? "primary" : "soft"}
            size="lg"
            disabled={busy !== null}
            onClick={() => void submit(choice.decision)}
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
