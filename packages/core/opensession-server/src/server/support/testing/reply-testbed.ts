// Test fixture for the reply path: the support kernel, the mail fixture, an
// inbox on it and the real email channel adapter (SMTP only; IMAP is not
// connected), with its `mark` calls recorded, plus helpers for
// conversations and inbox changes.
// Not on any live import chain (excluded from the side-effect scan).
import { afterEach, beforeEach } from "bun:test";
import { EmailChannelAdapter } from "../../../agents/email/adapter";
import { join } from "node:path";
import type {
  MessageTriage,
  InboxConfig,
  InboxPatch,
  SupportConversation,
  SupportMessage,
  TriageVerdict,
} from "../../../shared/support";
import {
  __setKnowledgeVerdictForTest,
  knowledgeVerdict,
} from "../../knowledge/backing";
import { registerChannelAdapter } from "../channel";
import {
  __setInboxProjectCheckForTest,
  createInbox,
  getInbox,
  updateInbox,
} from "../inboxes";
import {
  type DraftMeta,
  __resetReplyStateForTest,
  __setProjectSitesForTest,
} from "../reply";
import { createConversation, updateConversation } from "../store";
import { __setDraftCheckForTest } from "../verify";
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

/** The project's Support websites and connectors in these tests. */
export const TEST_SITES = {
  hosts: ["docs.acme.example.test"],
  connectors: ["acme-crm"],
};

/** What an agent draft cites, so a routine inbox may send it. */
export const CITED: DraftMeta = {
  sources: [{ kind: "repo", ref: "docs/export.md" }],
};

/** A customer message's triage labels: nothing flagged, over `over`. */
export function cleanLabels(over: Partial<MessageTriage> = {}): MessageTriage {
  return {
    route: "work",
    topics: [],
    injection: false,
    wantsHuman: false,
    angry: false,
    repeat: false,
    bug: false,
    thanksOnly: false,
    at: new Date().toISOString(),
    ...over,
  };
}

export function useReplyTestbed() {
  const kernel = useSupportTestKernel();
  let fixture: MailFixture | undefined;
  let inbox: InboxConfig | undefined;
  let adapter: ReplyTestAdapter | undefined;
  let previousSecrets: string | undefined;
  let counter = 0;

  beforeEach(async () => {
    __resetReplyStateForTest();
    __setProjectSitesForTest(async () => ({ ...TEST_SITES }));
    // No knowledge, unless a test says otherwise (backing.test.ts covers
    // the verdict itself).
    __setKnowledgeVerdictForTest(async () => null);
    // Every cited source checks out and the text is clean, unless a test
    // says otherwise (verify.test.ts covers the check itself). Knowledge
    // goes through the verdict, as in checkDraft.
    __setDraftCheckForTest(async (input) => {
      const knowledge = await knowledgeVerdict(input);
      return {
        verified: input.sources,
        topics: [],
        promises: false,
        ...(knowledge ? { knowledge } : {}),
        at: new Date(input.now).toISOString(),
      };
    });
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
        autonomy: "draft",
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
    __setProjectSitesForTest(undefined);
    __setDraftCheckForTest(undefined);
    __setKnowledgeVerdictForTest(undefined);
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

    /** A later customer message on `conversationId`, labelled clean. */
    async customerReply(
      conversationId: string,
      text = "Thanks, one more question.",
    ): Promise<SupportConversation> {
      counter++;
      const m: SupportMessage = {
        id: `sm_test-${counter}`,
        direction: "in",
        at: new Date().toISOString(),
        from: CUSTOMER,
        to: [{ name: null, address: INBOX_ADDRESS }],
        cc: [],
        subject: "Re: Export is broken",
        text,
        keys: {
          messageId: `m${counter}@customer.example.test`,
          inReplyTo: null,
          references: [],
        },
        providerId: `imap:1:${counter}`,
        attachments: [],
        trust: { replyToDiffers: false, authFailed: false, authVerified: true },
        triage: cleanLabels(),
      };
      return (await updateConversation(conversationId, (x) => ({
        ...x,
        messages: [...x.messages, m],
        status: x.status === "waiting" ? "open" : x.status,
        lastMessageAt: m.at,
      })))!;
    },

    /** One customer email, triaged with `triage` (topics [] by default). */
    async conversation(
      opts: {
        text?: string;
        replyTo?: SupportMessage["replyTo"];
        trust?: SupportMessage["trust"];
        triage?: Partial<TriageVerdict> | null;
        /** false: the message was never labelled by triage. */
        topicsChecked?: boolean;
        /** The message's triage labels over clean ones. */
        labels?: Partial<MessageTriage>;
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
        trust: opts.trust ?? {
          replyToDiffers: false,
          authFailed: false,
          authVerified: true,
        },
        // As routing leaves it once triage labelled the message.
        ...(opts.topicsChecked === false
          ? {}
          : { triage: cleanLabels(opts.labels) }),
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
