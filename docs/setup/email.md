# Email support

Email support connects ordinary mailboxes to Sessions. Each inbox is read over
IMAP and answered over SMTP, with a password or an app password. New mail is
sorted on the small model, listed under Support, and answered or drafted by a
support session in the inbox's project, under the autonomy you choose for the
inbox.

The integration lives in `packages/core/opensession-server/src/agents/email/`
(the IMAP and SMTP transports and the channel adapter) and
`packages/core/opensession-server/src/server/support/` (conversations,
triage, the reply path and retention). The security rules are in
[security-model.md](../security-model.md#support-mail).

## Turn it on

Email support is off by default. Put the flag in `~/.opensession.env` and
restart the service:

```sh
ENABLE_EMAIL_SUPPORT=true
```

Only the literal value `true` enables it. With the flag unset,
`integrations.email.enabled: true` in `~/.opensession/config.json` does the
same. No credentials go in the env file: inboxes and their passwords are set
up in **Settings → Inboxes**. See
[integrations-misc.md](integrations-misc.md#boot-guards).

## Connect an inbox

1. Open **Settings → Inboxes** and choose **Connect an inbox**.
2. Fill in the inbox:
   - **Name shown to customers**: the display name on replies, for example
     `Acme support`.
   - **Address**: the address customers write to, for example
     `help@acme.example.test`. It must be the mailbox itself or an alias the
     account may send as (see [Sending as the inbox address](#sending-as-the-inbox-address)).
   - **Project**: where support sessions for this inbox run.
   - **IMAP** and **SMTP**: host, port, security, user name and password.
3. Choose **Test**. Sessions logs in to both servers once and reports what it
   found. A test changes nothing in the mailbox.
4. Save. Sessions connects within a few seconds; the inbox row shows its
   state.

The first connect starts at "now". Mail already in the mailbox is not
imported; only mail that arrives after the inbox is connected becomes a
conversation.

### Security

Each server has its own security setting:

| Setting      | Port (usual)       | What it does                                                                                                                  |
| ------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Implicit TLS | IMAP 993, SMTP 465 | TLS from the first byte.                                                                                                      |
| STARTTLS     | IMAP 143, SMTP 587 | Upgrades to TLS before logging in. A server that doesn't offer it is refused.                                                 |
| None         | any                | No TLS. Only for a server on this machine, such as a local mail bridge, and only when the inbox allows internal mail servers. |

Certificates are always checked.

Mail server addresses are checked when Sessions connects, against the address
the name resolves to. Public addresses are allowed. Link-local and cloud
metadata addresses are always refused. Loopback, private network and tailnet
addresses are allowed only when the inbox allows internal mail servers, which
only the instance owner can turn on.

### App passwords

Use an app password where the provider offers one. An account with two-step
sign-in refuses its normal password over IMAP and SMTP.

**Google (Gmail and Google Workspace)**

1. Turn on 2-Step Verification for the account.
2. Create an app password at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
   Google shows it once; paste it into both password fields.
3. Servers: IMAP `imap.gmail.com`, port 993, implicit TLS. SMTP
   `smtp.gmail.com`, port 465, implicit TLS (or port 587, STARTTLS).
4. The user name is the full address of the mailbox.

In Google Workspace an administrator can turn off IMAP access or app
passwords for the organisation; if the test reports a refused login, check
those settings in the Admin console.

**Microsoft (Microsoft 365 and Outlook.com)**

Microsoft has been turning off password sign-in for IMAP and SMTP. Sessions
v1 signs in with a password only, so many Microsoft mailboxes can't connect
yet. Where your tenant or account still allows it:

1. Turn on two-step verification and create an app password (for a personal
   account, in the account's security settings under advanced security
   options).
2. In Microsoft 365, an administrator must allow IMAP and authenticated SMTP
   (SMTP AUTH) for the mailbox, in the Microsoft 365 admin center under the
   user's mail apps.
3. Servers: IMAP `outlook.office365.com`, port 993, implicit TLS. SMTP
   `smtp.office365.com` (Outlook.com: `smtp-mail.outlook.com`), port 587,
   STARTTLS.

If the test reports a refused login with the right app password, the tenant
doesn't accept password sign-in. Use a mailbox at a provider that does, or
forward the support address to one.

## Sending as the inbox address

Sessions hands each reply to your provider's SMTP server, logged in as the
inbox's SMTP user. The provider delivers it, so deliverability is the
provider's and your domain's:

- **The provider signs outgoing mail (DKIM).** Sessions doesn't sign
  anything. For a custom domain, turn on DKIM signing at the provider (Google
  Admin console, Microsoft Defender portal) and publish the DNS record it
  gives you.
- **The inbox address must be the mailbox or a verified send-as alias.** If
  the address differs from the SMTP user, add it as an alias the account may
  send as: in Gmail, "Send mail as" with the address verified; in Microsoft
  365, a "Send As" permission on the mailbox. Otherwise the server refuses the
  reply and the draft shows "This account can't send as the inbox address".
- **The domain's SPF record must include the provider.** For example
  `include:_spf.google.com` for Google or `include:spf.protection.outlook.com`
  for Microsoft 365. With SPF and DKIM in place, replies also pass the
  domain's DMARC check.

## What each setting does

| Setting                    | Default                     | What it does                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Autonomy                   | Draft                       | **Watch only**: sort and list new mail; no agent, no drafts. **Draft**: the agent drafts, a person sends. **Send after a veto window**: the reply sends when the window ends unless someone stops it. **Send right away**: the agent sends.                  |
| Veto window in minutes     | 10                          | How long a reply waits before it sends, from 1 minute to 24 hours.                                                                                                                                                                                           |
| Never without a person     | All four topics             | Refunds, account deletion, legal and angry customers always wait for a person, whatever the autonomy. When the topics of a conversation are unknown (the classifier failed), every send waits.                                                               |
| Bug handling               | Off                         | **Create an issue** in the project's repository, or **create an issue and start an agent** to fix it. The issue holds the agent's summary with email addresses and the customer's name taken out. An issue in a public repository always waits for a person. |
| Who may move conversations | The agent or a person       | Whether the support agent may move a conversation to another project, or only people.                                                                                                                                                                        |
| Owner                      | Whoever connected the inbox | The owner of each new conversation, who is told when a reply needs a person. A person can hand a conversation to someone else on the team.                                                                                                                   |
| Mailbox behaviour          | Leave untouched             | What Sessions does in the mailbox when a conversation is handled (see below).                                                                                                                                                                                |
| Save a copy in Sent        | Depends on the SMTP host    | Appends each reply to the Sent folder (see below).                                                                                                                                                                                                           |
| Keep conversations (days)  | 180                         | How long a conversation's text is kept after it closes.                                                                                                                                                                                                      |
| Keep attachments (days)    | 30                          | How long attachment files are kept; afterwards only their name and size remain.                                                                                                                                                                              |
| Send limit per minute      | 30                          | The most replies this inbox sends in a minute (at most 120).                                                                                                                                                                                                 |

Any signed-in person can connect and edit inboxes. Only the instance owner can
let an inbox send right away, allow internal mail servers, remove an inbox
and forget a customer.

When a reply needs a person, will send at the end of its veto window, or
couldn't send, Sessions notifies the conversation's owner (the instance owner
when it has none) with fixed wording: "A support reply is
ready", "A support reply will send", "A support reply could not send". The
switch is **Support replies that need you** in **Settings → Notifications**.

## Rate limits and connections

- **One IMAP connection per inbox.** Sessions waits for new mail with IDLE
  and fetches only messages newer than the last one it read. A server without
  IDLE is checked every 5 minutes.
- **Reconnects back off.** A lost connection is retried after a random delay
  that grows from 30 seconds to 15 minutes. A connection limit ("too many
  connections") or a throttling response backs off the same way. A server
  alert that ends the connection shows the inbox as paused with the alert's
  text, and it is retried on the same schedule; the inbox row shows the
  reason and when Sessions tries again.
- **A refused login is not retried.** Providers lock accounts after repeated
  failed logins, so the inbox stays paused until someone saves the inbox
  (any change, or a new password) or a test with its saved passwords
  passes. Then Sessions logs in once more.
- **One SMTP connection per inbox**, reused for every reply, within the
  inbox's send limit. A conversation gets at most 3 automatic sends an hour.
- **Provider limits still apply.** Gmail allows about 15 IMAP connections per
  account at once and caps how many messages an account sends a day. Every
  mail client on the same account counts towards them.

Auto-replies, bounces, mailing-list mail and copies of our own replies never
start an agent or trigger a send.

## What Sessions changes in the mailbox

Sessions never deletes mail. What it changes depends on **Mailbox behaviour**:

- **Leave untouched**: the inbox is opened read-only. Nothing changes: no
  flags, no folders, no moves.
- **Mark read when handled**: when a reply is sent, a conversation is
  closed or triage files it as spam, its messages get the `\Seen` flag.
  Nothing else changes.
- **Move to Sessions folders**: when a reply is sent or a conversation is
  closed, its messages move to `Sessions/Done`; spam moves to
  `Sessions/Spam`. Sessions
  creates the folders when they are missing, under the server's own folder
  prefix if it has one (for example `INBOX.Sessions.Done`).

Only the messages of that conversation are touched, including our own mail
that Sessions read from the inbox. A mailbox action that fails (the
connection is down, the folder can't be created) is logged and dropped; it
never holds up a reply.

### Save a copy in Sent

With **Save a copy in Sent** on, Sessions appends each reply, marked read, to
the account's Sent folder over the inbox's IMAP connection after the server
accepted it. If a message with the same Message-ID is in Sent already, the
copy is skipped. If the IMAP connection is down at that moment, the copy is
skipped; the reply still counts as sent.

Gmail and Microsoft 365 save mail sent through their SMTP servers in Sent
themselves, so a second copy would be a duplicate. The setting starts off when
the SMTP host is `smtp.gmail.com`, `smtp.googlemail.com`,
`smtp.office365.com` or `smtp-mail.outlook.com`, and on for any other host.
Changing the SMTP host decides it again. If you turn it on for one of those
hosts, the provider may save its own copy after Sessions has checked, and Sent
can end up with two.

## Retention

- A conversation's text is deleted 180 days after it closes (per inbox).
- Attachment files are deleted after 30 days; their name and size stay.
- **Forget a customer** (instance owner only) deletes everything Sessions
  holds for one address: conversations, attachments and the support sessions
  that answered them. It can't delete mail in the mailbox or GitHub issues,
  and says which ones remain.
- Retention never changes the mailbox.

Conversations are stored in the Sessions catalog and also written as JSON
files under the state directory (for example
`~/.opensession/support-conversations/`). Treat the state directory as
holding customer mail.

## Troubleshooting

| Inbox state | Meaning                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live        | Connected and waiting for mail with IDLE.                                                                                                                                                                                                   |
| Polling     | Connected; the server has no IDLE, so Sessions checks every 5 minutes.                                                                                                                                                                      |
| Backing off | The connection was lost, or the server asked Sessions to slow down; the row shows when Sessions tries again.                                                                                                                                |
| Paused      | A refused login, a missing password or a refused server address: Sessions stopped trying. Fix the setting and save the inbox, or run a test that passes. A server alert also shows as paused, with the time Sessions tries again by itself. |

The state is the IMAP connection's. When a reply fails for a reason that
won't go away by retrying (a refused SMTP login, an address the account
can't send as), the row also shows "Sending failed" and the reason until a
reply sends or the SMTP settings change.

The service log has a line per connection event with the inbox id and an
error code. It never contains a password, an address or message text.
