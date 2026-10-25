// Test fixture for the reply path: the support kernel, the mail fixture, an
// inbox on it and the real email channel adapter (SMTP only; IMAP is not
// connected), with its `mark` calls recorded, plus helpers for
// conversations and inbox changes.
// Not on any live import chain (excluded from the side-effect scan).
import { afterEach, beforeEach } from "bun:test";
import { EmailChannelAdapter } from "../../../agents/email/adapter";
import { join } from "node:path";
import type {
  InboxConfig,
  InboxPatch,
  SupportConversation,
  SupportMessage,
  TriageVerdict,
} from "../../../shared/support";
import { registerChannelAdapter } from "../channel";
import {
  __setInboxProjectCheckForTest,
  createInbox,
  getInbox,
  updateInbox,
} from "../inboxes";
import { __resetReplyStateForTest } from "../reply";
import { createConversation, updateConversation } from "../store";
import { TEST_PROJECTS, useSupportTestKernel } from "./kernel-fixture";
import {
  MAIL_PASSWORD,
  type MailFixture,
  startMailFixture,
} from "./mail-fixture";

export type ReplyTestAdapter = EmailChannelAdapter & {
  marks: Array<{ conversationId: string; state: "handled" | "spam" }>;
};

function recordingAdapter(inbox: InboxConfig): ReplyTestAdapter {
  const adapter = Object.assign(new EmailChannelAdapter(inbox), {
    marks: [] as ReplyTestAdapter["marks"],
  });
  const mark = adapter.mark.bind(adapter);
  adapter.mark = async (c, state) => {
    adapter.marks.push({ conversationId: c.id, state });
    await mark(c, state);
  };
  return adapter;
}

export const INBOX_ADDRESS = "help@acme.example.test";
export const CUSTOMER = {
  name: "Carol",
  address: "carol@customer.example.test",
};
/** The instance owner, so every autonomy level may be set. */
export const OWNER = { name: "Ada", verified: true, isInstanceOwner: true };

export function useReplyTestbed() {
  const kernel = useSupportTestKernel();
  let fixture: MailFixture | undefined;
  let inbox: InboxConfig | undefined;
  let adapter: ReplyTestAdapter | undefined;
  let previousSecrets: string | undefined;
  let counter = 0;

  beforeEach(async () => {
    __resetReplyStateForTest();
    __setInboxProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
    previousSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
    process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
      kernel.root(),
      "workspace-secrets.json",
    );
    fixture = await startMailFixture();
    const created = await createInbox(
      {
        label: "Acme help",
        address: INBOX_ADDRESS,
        project: "acme",
        allowInternalHost: true,
        autonomy: "propose",
        imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
        smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
      },
      OWNER,
    );
    if (!created.ok) throw new Error(created.error);
    inbox = created.inbox;
    adapter = recordingAdapter(inbox);
    registerChannelAdapter(adapter);
  });

  afterEach(async () => {
    await adapter?.disconnect();
    await fixture?.close();
    adapter = undefined;
    fixture = undefined;
    inbox = undefined;
    __resetReplyStateForTest();
    __setInboxProjectCheckForTest(undefined);
    if (previousSecrets === undefined)
      delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
    else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previousSecrets;
  });

  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`${what} exists only in a test`);
    return value;
  };

  return {
    kernel,
    fixture: () => need(fixture, "The mail fixture"),
    inbox: () => need(inbox, "The inbox"),
    adapter: () => need(adapter, "The adapter"),

    /** Applies a patch as the instance owner and returns the new config. */
    async setInbox(
      patch: Omit<InboxPatch, "expectedRevision">,
    ): Promise<InboxConfig> {
      const current = await getInbox(need(inbox, "The inbox").id);
      const result = await updateInbox(
        current!.id,
        { ...patch, expectedRevision: current!.revision },
        OWNER,
      );
      if (!result.ok) throw new Error(result.error);
      inbox = result.inbox;
      // As EmailAgent does for fields that need no new connection.
      adapter?.update(result.inbox);
      return inbox;
    },

    /** One customer email, triaged with `triage` (topics [] by default). */
    async conversation(
      opts: {
        text?: string;
        replyTo?: SupportMessage["replyTo"];
        trust?: SupportMessage["trust"];
        triage?: Partial<TriageVerdict> | null;
      } = {},
    ): Promise<SupportConversation> {
      counter++;
      const first: SupportMessage = {
        id: `sm_test-${counter}`,
        direction: "in",
        at: new Date().toISOString(),
        from: CUSTOMER,
        to: [{ name: null, address: INBOX_ADDRESS }],
        cc: [],
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        subject: "Export is broken",
        text: opts.text ?? "The CSV export fails since Monday.",
        keys: {
          messageId: `m${counter}@customer.example.test`,
          inReplyTo: null,
          references: [],
        },
        providerId: `imap:1:${counter}`,
        attachments: [],
        trust: opts.trust ?? { replyToDiffers: false, authFailed: false },
      };
      const c = await createConversation({
        channel: "email",
        inboxId: need(inbox, "The inbox").id,
        project: "acme",
        subject: first.subject,
        customer: first.from,
        owner: null,
        first,
        now: new Date().toISOString(),
      });
      const triage: TriageVerdict | null =
        opts.triage === null
          ? null
          : {
              route: "work",
              reason: "test",
              topics: [],
              bug: false,
              at: new Date().toISOString(),
              ...opts.triage,
            };
      return (await updateConversation(c.id, (x) => ({ ...x, triage })))!;
    },
  };
}
