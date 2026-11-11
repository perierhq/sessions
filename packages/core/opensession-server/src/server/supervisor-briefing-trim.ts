/**
 * Only the newest briefing reaches the supervisor's model.
 *
 * Every supervisor turn prepends its briefing to the owner's message: the
 * live state (desk-state.ts), the inbox, the clock, the report style and the
 * Blob surface (run-session.ts). The session file keeps each copy, so after a
 * few dozen turns most of the context was stale briefings that the model then
 * read as news. Before each model request, pi's `context` event hands this
 * module the messages; every briefing block older than the newest one of its
 * kind becomes a one-line stub. The session file is unchanged.
 *
 * Every owner turn carries each kind, even with nothing to say: an empty
 * inbox is "Inbox: nothing waiting." (supervisor-inbox.ts) and a web turn
 * says it is not in Blob (blob-surface.ts). So the newest block of a kind
 * is always this turn's, never a stale one an empty turn left standing.
 *
 * Prompt cache: a new turn's briefing stubs the previous turn's blocks, so
 * on the turn's first request the cached prefix breaks at the previous
 * turn's prompt, and everything from there (that prompt, its replies and
 * tool results) is cached again. Later requests of the same turn keep the
 * prefix. A stub is the same text every time, so a stubbed block never
 * changes again and nothing before the previous turn breaks.
 */
import type {
  ExtensionFactory,
  ContextEvent,
} from "@earendil-works/pi-coding-agent";
import type { ContextSource } from "./prompt-context";

/** Per-turn blocks the next turn rebuilds in full. The seed, memory and
 *  everything else stay as they are: they are not repeated each turn. */
export const STUBBED_BRIEFING_SOURCES: readonly ContextSource[] = [
  "desk-state",
  "supervisor-inbox",
  "supervisor-clock",
  "supervisor-report-style",
  "blob-surface",
];

const STUBBED = new Set<string>(STUBBED_BRIEFING_SOURCES);

/** wrapContext's fence. Bodies never hold a fence (wrapContext neutralizes
 *  them), so the first close tag ends the block. */
const FENCE_RE =
  /<opensession:context source="([a-z-]+)">\n([\s\S]*?)\n<\/opensession:context>/g;

export const STALE_BRIEFING_NOTE =
  "An older copy, replaced by the newest one in a later message.";

/** The inbox's answers appear once (supervisor-inbox.ts marks them briefed),
 *  so a stubbed inbox keeps them: they are the owner's decisions. */
const ANSWERED_HEADING = "Answered since your last turn:";

function stubBody(source: string, body: string): string {
  if (source !== "supervisor-inbox") return STALE_BRIEFING_NOTE;
  const answered = body
    .split("\n\n")
    .find((section) => section.startsWith(ANSWERED_HEADING));
  return answered
    ? `${STALE_BRIEFING_NOTE}\n\n${answered}`
    : STALE_BRIEFING_NOTE;
}

/** The stubbable sources a text carries. */
function sourcesIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(FENCE_RE))
    if (STUBBED.has(match[1]!)) out.push(match[1]!);
  return out;
}

function stubText(text: string, stale: (source: string) => boolean): string {
  return text.replace(FENCE_RE, (block, source: string, body: string) =>
    STUBBED.has(source) && stale(source)
      ? `<opensession:context source="${source}">\n${stubBody(source, body)}\n</opensession:context>`
      : block,
  );
}

interface TextPart {
  type: "text";
  text: string;
}

/** The text parts of a user message, or none for any other message. */
function userTexts(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  if (Reflect.get(message, "role") !== "user") return [];
  const content: unknown = Reflect.get(message, "content");
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) =>
    part &&
    typeof part === "object" &&
    Reflect.get(part, "type") === "text" &&
    typeof Reflect.get(part, "text") === "string"
      ? [(part as TextPart).text]
      : [],
  );
}

/**
 * The messages with every briefing block that a later user message repeats
 * (by source) replaced by a stub. Messages without a stale block are
 * returned as they are; the input is never modified. A kind no later
 * message repeats stays in full, which is why owner turns always carry
 * every kind (the header).
 */
export function stubStaleBriefings<T>(messages: readonly T[]): T[] {
  const newest = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const text of userTexts(message))
      for (const source of sourcesIn(text)) newest.set(source, index);
  });
  if (!newest.size) return [...messages];
  return messages.map((message, index) => {
    const texts = userTexts(message);
    const stale = (source: string) => (newest.get(source) ?? index) > index;
    if (!texts.some((text) => sourcesIn(text).some(stale))) return message;
    const content: unknown = Reflect.get(message as object, "content");
    return {
      ...message,
      content:
        typeof content === "string"
          ? stubText(content, stale)
          : (content as unknown[]).map((part) =>
              part &&
              typeof part === "object" &&
              Reflect.get(part, "type") === "text"
                ? {
                    ...(part as TextPart),
                    text: stubText((part as TextPart).text, stale),
                  }
                : part,
            ),
    };
  });
}

/** The inline pi extension that applies stubStaleBriefings to each model
 *  request of a supervisor turn (pi-session-setup.ts). */
export const supervisorBriefingTrimExtension: ExtensionFactory = (pi) => {
  pi.on("context", (event: ContextEvent) => ({
    messages: stubStaleBriefings(event.messages),
  }));
};
