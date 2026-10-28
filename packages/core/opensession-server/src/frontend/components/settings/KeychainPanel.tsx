import { useEffect, useState } from "react";
import {
  answerKeychainAsk,
  deleteKeychainCredential,
  fetchKeychain,
  relativeTime,
  resumeKeychainGrant,
  revokeKeychainGrant,
  setKeychainCredentialScope,
  testKeychainCredential,
  type KeychainAskDto,
  type KeychainCredentialDto,
  type KeychainGrantDto,
} from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import { ceilingSummary } from "../../../shared/keychain-ceiling";
import { routePath } from "../../lib/app-route";
import {
  canLend,
  expiryNote,
  lendingRoles,
  testOutcome,
} from "../../lib/keychain-credential";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { useConfirm } from "../../ui/confirm";
import { Menu } from "../../ui/menu";
import {
  rowMenuTriggerClasses,
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconDotsHorizontal } from "../icons";
import { BASE_PATH } from "../../lib/base";
import { AgentName } from "../AgentIdentity";
import { CredentialHistoryDialog } from "./CredentialHistoryDialog";
import { CredentialDialog, LoginDialog } from "./KeychainDialogs";
import { UseInIncidentsDialog } from "./UseInIncidentsDialog";
import { SettingRow } from "./shared";

// ── Keychain: per-person credentials sessions can BORROW with your approval
// (src/server/keychain.ts). Registration lives here rather than in a tool
// because a secret pasted into a session prompt is a secret in the transcript.
//
// It renders as a section of Settings → Account rather than a page of its
// own: a credential you lend to a session is the same kind of thing as an
// account a session acts as, and it was one thin page in a nav that is already
// 22 entries deep. Old /settings/keychain links redirect there (App.tsx's
// LEGACY_SETTINGS_SECTIONS). ──
export function KeychainSection() {
  const [data, setData] = useState<{
    credentials: KeychainCredentialDto[];
    grants: KeychainGrantDto[];
    asks: KeychainAskDto[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The add or edit dialog, mounted only while open so a typed secret
  // never outlives it.
  const [dialog, setDialog] = useState<{
    kind: "api" | "login";
    credential?: KeychainCredentialDto;
  } | null>(null);
  const [history, setHistory] = useState<KeychainCredentialDto | null>(null);
  const [lending, setLending] = useState<KeychainCredentialDto | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const reload = () => {
    fetchKeychain()
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(reload, [reload]);
  // Links from a project's access settings land here with #keychain: the
  // section sits under others on the page, so bring it into view once the
  // list has its height.
  const loaded = data !== null;
  useEffect(() => {
    // Through globalThis: the panel's tests run without a DOM.
    if (loaded && globalThis.location?.hash === "#keychain")
      globalThis.document
        ?.getElementById("keychain")
        ?.scrollIntoView({ block: "start" });
  }, [loaded]);

  // The label, its action and the hint below the card are all static, so they
  // stay while the credentials are in flight — only the list is unknown, and
  // ghosting more than that is what makes the block change height when the
  // answer lands.
  const label = (
    <SettingsGroupLabel
      id="keychain"
      className="scroll-mt-6"
      actions={
        <>
          <Button
            size="sm"
            className="phone:min-h-11"
            variant="ghost"
            disabled={!data}
            onClick={() => setDialog({ kind: "login" })}
          >
            Add login
          </Button>
          <Button
            size="sm"
            className="phone:min-h-11"
            variant="ghost"
            disabled={!data}
            onClick={() => setDialog({ kind: "api" })}
          >
            Add credential
          </Button>
        </>
      }
    >
      Keychain
    </SettingsGroupLabel>
  );
  const hint = (
    <SettingsHint>
      Any teammate's session can ask to borrow a credential. Its owner approves
      or declines here or in Slack. A workspace credential needs no approval:
      every session can use it. The secret is injected server-side, so the agent
      never sees it, and every call is audited. A login is different: the agent
      types its password into the sign-in page, so it can read it. Add only test
      accounts as logins.
    </SettingsHint>
  );

  if (!data)
    return (
      <>
        {label}
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          <SettingCardSkeleton rows={2} label="Loading keychain" />
        )}
        {hint}
      </>
    );

  const byId = new Map(data.credentials.map((c) => [c.id, c]));
  const activeGrants = data.grants.filter((g) => g.status === "active");
  // Paused by a widening edit: listed with the live ones, so the owner can
  // allow each again or end it.
  const listedGrants = data.grants.filter(
    (g) => g.status === "active" || g.status === "suspended",
  );
  const pending = data.asks.filter((a) => a.status === "pending");
  const serviceOf = (id: string) => byId.get(id)?.service ?? id;
  // One owner's credentials in a multi-credential run are one answer.
  const sameRun = (a: KeychainAskDto) =>
    pending.filter(
      (o) =>
        o.canAnswer && !!a.run?.group && o.run?.group?.id === a.run.group.id,
    );
  const toAnswer = pending.filter(
    (a) => a.canAnswer && (!a.run?.group || sameRun(a)[0] === a),
  );
  const waiting = pending.filter((a) => !a.canAnswer);
  const answer = (
    id: string,
    decision: Parameters<typeof answerKeychainAsk>[1],
  ) =>
    answerKeychainAsk(id, decision)
      .then(reload)
      .catch((e) => setError(e.message));
  const setScope = (c: KeychainCredentialDto) => {
    const sharing = c.scope !== "workspace";
    confirm({
      title: sharing
        ? `Share ${c.service} with the workspace?`
        : `Make ${c.service} personal?`,
      description: sharing
        ? "Every session in the workspace can call it without asking you, within its host, methods and paths. Calls are still audited."
        : "Sessions will have to ask you again before using it. Access they got without asking ends now.",
      confirmLabel: sharing ? "Share" : "Make personal",
      onConfirm: () =>
        void setKeychainCredentialScope(
          c.id,
          sharing ? "workspace" : "personal",
        )
          .then(reload)
          .catch((e) => setError(e.message)),
    });
  };

  // Deleting revokes every live grant and stops any scripted run using the
  // credential, so it is confirmed, with the count from the grants in view.
  const remove = (c: KeychainCredentialDto) => {
    const now = Date.now();
    const live = activeGrants.filter(
      (g) => g.credentialId === c.id && new Date(g.expiresAt).getTime() > now,
    ).length;
    confirm({
      title: `Delete ${c.service}?`,
      description:
        live === 0
          ? "No session holds a grant for it. This can't be undone."
          : `${live} active ${live === 1 ? "grant loses" : "grants lose"} access now. This can't be undone.`,
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () =>
        void deleteKeychainCredential(c.id)
          .then(reload)
          .catch((e) => setError(e.message)),
    });
  };

  // The saved credential, tested with its stored secret and test path: a
  // one-off result, so a toast.
  const test = (c: KeychainCredentialDto) => {
    const path = c.testPath || c.allowedPathPrefixes?.[0] || "/";
    testKeychainCredential({ credentialId: c.id })
      .then((result) => {
        const { text, tone } = testOutcome(result, path);
        toast(`${c.service}: ${text}`, {
          variant: tone === "success" ? "success" : "default",
        });
      })
      .catch((e) =>
        toast(`${c.service}: ${errorMessage(e, "Couldn't run the test")}`, {
          variant: "error",
        }),
      );
  };

  return (
    <>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      {label}
      {confirmDialog}

      {dialog &&
        (dialog.kind === "login" ? (
          <LoginDialog
            credential={dialog.credential}
            onClose={() => setDialog(null)}
            onSaved={() => {
              setDialog(null);
              reload();
            }}
          />
        ) : (
          <CredentialDialog
            credential={dialog.credential}
            grants={data.grants.filter(
              (g) => g.credentialId === dialog.credential?.id,
            )}
            onClose={() => setDialog(null)}
            onSaved={() => {
              setDialog(null);
              reload();
            }}
          />
        ))}

      {lending && (
        <UseInIncidentsDialog
          credential={lending}
          onClose={() => setLending(null)}
        />
      )}
      {history && (
        <CredentialHistoryDialog
          credential={history}
          onClose={() => setHistory(null)}
        />
      )}

      {data.credentials.length === 0 ? (
        <EmptyState placement="card">
          No credentials yet. Add one so sessions can request scoped access
          without putting a token in a prompt.
        </EmptyState>
      ) : (
        <SettingCard>
          {data.credentials.map((c) => {
            const expiry = expiryNote(c.expiresOn);
            return (
              <SettingRow
                key={c.id}
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {c.kind === "login"
                      ? `${c.service} · ${c.username ?? ""}`
                      : `${c.service} · ${c.host}`}
                    {c.scope === "workspace" && (
                      <Badge tone="info">Workspace</Badge>
                    )}
                    {expiry?.expired && <Badge tone="warning">Expired</Badge>}
                  </span>
                }
                desc={
                  <>
                    {[
                      c.kind === "login"
                        ? `login on ${c.loginUrl ?? c.host}`
                        : null,
                      `owner ${c.owner}`,
                      c.description,
                      // The ceiling every grant inherits, as the approval card shows it.
                      c.kind === "login"
                        ? null
                        : `allows ${lowerFirst(ceilingSummary(c).text)}`,
                      expiry && !expiry.expired
                        ? lowerFirst(expiry.text)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {c.lastUsed && lastUsedLine(c.lastUsed)}
                    {c.lentIn?.length ? lentInLine(c.lentIn) : null}
                  </>
                }
                control={
                  c.mine ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="ghost"
                        onClick={() =>
                          setDialog({
                            kind: c.kind === "login" ? "login" : "api",
                            credential: c,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Menu.Root>
                        <Menu.Trigger
                          className={rowMenuTriggerClasses}
                          aria-label={`More for ${c.service}`}
                        >
                          <IconDotsHorizontal size={18} />
                        </Menu.Trigger>
                        <Menu.Popup align="end" sideOffset={4}>
                          {c.kind !== "login" && (
                            <Menu.Item onClick={() => test(c)}>Test</Menu.Item>
                          )}
                          <Menu.Item onClick={() => setHistory(c)}>
                            History
                          </Menu.Item>
                          {canLend(c) && (
                            <Menu.Item onClick={() => setLending(c)}>
                              Use in incidents
                            </Menu.Item>
                          )}
                          {c.kind !== "login" && (
                            <Menu.Item onClick={() => setScope(c)}>
                              {c.scope === "workspace"
                                ? "Make personal"
                                : "Share with the workspace"}
                            </Menu.Item>
                          )}
                          <Menu.Item
                            onClick={() => remove(c)}
                            className="text-red data-[highlighted]:bg-red-soft"
                          >
                            Delete
                          </Menu.Item>
                        </Menu.Popup>
                      </Menu.Root>
                    </div>
                  ) : canLend(c) ? (
                    // A teammate's workspace credential: anyone signed in may lend it.
                    <Button
                      size="sm"
                      className="phone:min-h-11"
                      variant="ghost"
                      onClick={() => setLending(c)}
                    >
                      Use in incidents
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </SettingCard>
      )}
      {hint}

      {/* Teammates asking to borrow one of your credentials. Only the
			    owner can answer, here or in the Slack DM; never as a card in
			    the asking session, where anyone watching could click it. */}
      {toAnswer.length > 0 && (
        <>
          <SettingsGroupLabel>Requests for your credentials</SettingsGroupLabel>
          <SettingCard>
            {toAnswer.map((a) => (
              <SettingRow
                key={a.id}
                title={`${a.requestedBy} wants ${
                  a.run?.group
                    ? sameRun(a)
                        .map((o) => serviceOf(o.credentialId))
                        .join(" and ")
                    : serviceOf(a.credentialId)
                }`}
                desc={
                  a.requestedMode === "release"
                    ? `Wants the password, which the agent will see · ${a.purpose}`
                    : a.run?.group
                      ? `Scripted run with ${a.run.group.members
                          .map(
                            (m) =>
                              `${m.service} (owner ${m.owner}, up to ${m.maxCalls.toLocaleString()} calls)`,
                          )
                          .join(
                            ", ",
                          )}; starts once every owner allows it · ${a.run.command} · ${a.purpose}`
                      : a.run
                        ? `Scripted run, up to ${a.run.maxCalls.toLocaleString()} calls · ${a.run.command} · ${a.purpose}`
                        : `Asked for ${a.requestedMode === "once" ? "one call" : "7 days"} · ${a.purpose} · Allows ${ceilingSummary(byId.get(a.credentialId) ?? {}).text}`
                }
                controlClassName="flex flex-wrap justify-end gap-1"
                control={
                  a.requestedMode === "release" ? (
                    <>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="ghost"
                        onClick={() => answer(a.id, "decline")}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="primary"
                        onClick={() => answer(a.id, "release")}
                      >
                        Release password
                      </Button>
                    </>
                  ) : a.run ? (
                    <>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="ghost"
                        onClick={() => answer(a.id, "decline")}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="primary"
                        onClick={() => answer(a.id, "run")}
                      >
                        Allow run
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="ghost"
                        onClick={() => answer(a.id, "decline")}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="ghost"
                        onClick={() => answer(a.id, "standing")}
                      >
                        Allow 7 days
                      </Button>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="primary"
                        onClick={() => answer(a.id, "once")}
                      >
                        Allow once
                      </Button>
                    </>
                  )
                }
              />
            ))}
          </SettingCard>
          <SettingsHint>
            Allow once covers a single API call. Allow run covers one script, up
            to its call cap, while it runs. The session never sees those
            secrets, and you can revoke a grant below. Release password writes a
            login's password to a file the session reads once, deleted after 30
            minutes.
          </SettingsHint>
        </>
      )}

      {waiting.length > 0 && (
        <>
          <SettingsGroupLabel>Your pending requests</SettingsGroupLabel>
          <SettingCard>
            {waiting.map((a) => (
              <SettingRow
                key={a.id}
                title={`${byId.get(a.credentialId)?.service ?? a.credentialId} · waiting on ${a.owner}`}
                desc={`${a.requestedMode} · ${a.purpose}`}
                control={null}
              />
            ))}
          </SettingCard>
        </>
      )}

      {/* Only when there is one. As a page this group carried an empty
			    state; as a section it would be a second empty block under a
			    list most people never populate. */}
      {listedGrants.length > 0 && (
        <>
          <SettingsGroupLabel>Active grants</SettingsGroupLabel>
          <SettingCard>
            {listedGrants.map((g) => {
              const paused = g.status === "suspended";
              return (
                <SettingRow
                  key={g.id}
                  title={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {`${byId.get(g.credentialId)?.service ?? g.credentialId} → ${g.requestedBy}`}
                      {paused && <Badge tone="warning">Paused</Badge>}
                    </span>
                  }
                  desc={
                    paused
                      ? `Approved under narrower limits. Paused until you allow it again · ${g.purpose}`
                      : `${g.mode} · expires ${new Date(g.expiresAt).toLocaleString()} · ${g.purpose}`
                  }
                  controlClassName="flex flex-wrap justify-end gap-1"
                  control={
                    <>
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        variant="ghost"
                        onClick={() =>
                          revokeKeychainGrant(g.id)
                            .then(reload)
                            .catch((e) => setError(e.message))
                        }
                      >
                        Revoke
                      </Button>
                      {paused && byId.get(g.credentialId)?.mine && (
                        <Button
                          size="sm"
                          className="phone:min-h-11"
                          variant="primary"
                          onClick={() =>
                            resumeKeychainGrant(g.id)
                              .then(reload)
                              .catch((e) => setError(e.message))
                          }
                        >
                          Allow again
                        </Button>
                      )}
                    </>
                  }
                />
              );
            })}
          </SettingCard>
        </>
      )}
    </>
  );
}

/** A link inside a row's description: underlined in the text's colour,
 *  with a hit area taller than the line (TextLink's recipe, as an anchor). */
const INLINE_LINK =
  "relative underline decoration-line-strong underline-offset-2 before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[''] hover:text-fg";

/** "Last used 2h ago by <agent>": the session links to its transcript. */
function lastUsedLine(use: NonNullable<KeychainCredentialDto["lastUsed"]>) {
  return (
    <span className="block">
      Last used {relativeTime(use.at)} by{" "}
      <a
        className={INLINE_LINK}
        href={`${BASE_PATH}/session/${encodeURIComponent(use.sessionId)}`}
      >
        <AgentName sessionId={use.sessionId} />
      </a>
      {use.status !== undefined
        ? ` · ${use.status}`
        : use.error
          ? " · failed"
          : ""}
    </span>
  );
}

/** "Lent to incident agents in acme-todo (investigator always)": each
 *  project links to its access settings, where the lending is changed. */
function lentInLine(lentIn: NonNullable<KeychainCredentialDto["lentIn"]>) {
  return (
    <span className="block">
      Lent to incident agents in{" "}
      {lentIn.map((l, i) => (
        <span key={l.project}>
          {i > 0 && ", "}
          <a
            className={INLINE_LINK}
            href={routePath({
              view: "projectSettings",
              project: l.project,
              section: "access",
            })}
          >
            {l.project}
          </a>{" "}
          ({lendingRoles(l.roles)})
        </span>
      ))}
    </span>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
