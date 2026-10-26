import { describe, expect, test } from "bun:test";
import {
  MAX_TEXT_CHARS,
  type MessagePartKind,
  hasQuotedParts,
  messageParts,
  newTextOf,
} from "../../shared/support";
import { SPLIT_VERSION, type SplitOptions, splitEmailText } from "./quote";

/** The parts as [kind, trimmed text], blank parts left out. */
function split(text: string, options?: SplitOptions) {
  const s = splitEmailText(text, options);
  expect(s.v).toBe(SPLIT_VERSION);
  return (messageParts({ text, split: s }) ?? [])
    .filter((p) => p.text.trim())
    .map((p): [MessagePartKind, string] => [p.kind, p.text.trim()]);
}

const fresh = (text: string, options?: SplitOptions) =>
  newTextOf({ text, split: splitEmailText(text, options) });

describe("splitEmailText", () => {
  test("Gmail, top-posted, with the attribution wrapped over two lines", () => {
    const text = [
      "Thanks, that worked!",
      "",
      "One more thing: can I set it per project?",
      "",
      "On Mon, Nov 3, 2026 at 10:12 AM Acme Support <",
      "help@example.test> wrote:",
      "",
      "> Hi Alice,",
      ">",
      "> Open Settings, then Models, and pick the default there.",
      ">",
      "> --",
      "> Acme Support",
      "",
    ].join("\n");
    expect(split(text)).toEqual([
      [
        "new",
        "Thanks, that worked!\n\nOne more thing: can I set it per project?",
      ],
      ["quoted", text.slice(text.indexOf("On Mon")).trim()],
    ]);
  });

  test("Outlook: the rule and the From / Sent / To / Subject block", () => {
    const text = [
      "Hello,",
      "",
      "It is still broken for me after the update.",
      "",
      "Regards",
      "Bob",
      "",
      "________________________________",
      "From: Acme Support <help@example.test>",
      "Sent: Monday, November 3, 2026 10:12 AM",
      "To: Bob Example <bob@example.test>",
      "Subject: Re: Login fails",
      "",
      "Hi Bob, please try again now.",
    ].join("\n");
    expect(split(text).map(([kind]) => kind)).toEqual(["new", "quoted"]);
    // A sign-off without a delimiter is part of what Bob wrote.
    expect(fresh(text)).toBe(
      "Hello,\n\nIt is still broken for me after the update.\n\nRegards\nBob",
    );
  });

  test("Outlook without addresses, and -----Original Message-----", () => {
    const bare = [
      "Still broken.",
      "",
      "From: Acme Support",
      "Sent: Monday, November 3, 2026 10:12 AM",
      "To: Bob Example",
      "Subject: RE: Login fails",
      "",
      "Hi Bob, try again.",
    ].join("\n");
    expect(fresh(bare)).toBe("Still broken.");
    const original = [
      "See below.",
      "",
      "-----Original Message-----",
      "From: Acme Support [mailto:help@example.test]",
      "Sent: Monday, November 3, 2026 10:12",
      "To: bob@example.test",
      "Subject: Login",
      "",
      "Hi Bob.",
    ].join("\n");
    expect(split(original)).toEqual([
      ["new", "See below."],
      ["quoted", original.slice(original.indexOf("-----")).trim()],
    ]);
  });

  test("German Outlook headers (Von / Gesendet / An / Betreff)", () => {
    const text = [
      "Danke, jetzt geht es.",
      "",
      "Von: Acme Support <help@example.test>",
      "Gesendet: Montag, 3. November 2026 10:12",
      "An: Jonas Beispiel <jonas@example.test>",
      "Betreff: AW: Anmeldung",
      "",
      "Hallo Jonas, bitte neu starten.",
    ].join("\n");
    expect(fresh(text)).toBe("Danke, jetzt geht es.");
  });

  test("Apple Mail on iPhone: the signature line and the quoted attribution", () => {
    const text = [
      "Yes please, reset it.",
      "",
      "Sent from my iPhone",
      "",
      "> On 3 Nov 2026, at 10:12, Acme Support <help@example.test> wrote:",
      ">",
      "> Shall we reset your workspace?",
      "",
    ].join("\n");
    expect(split(text)).toEqual([
      ["new", "Yes please, reset it."],
      ["signature", "Sent from my iPhone"],
      ["quoted", text.slice(text.indexOf("> On")).trim()],
    ]);
  });

  test("German Gmail: Am … schrieb …:", () => {
    const text = [
      "Hallo,",
      "",
      "danke, es geht jetzt.",
      "",
      "Viele Grüße",
      "Jonas",
      "",
      "Am Mo., 3. Nov. 2026 um 10:12 Uhr schrieb Acme Support <",
      "help@example.test>:",
      "",
      "> Hallo Jonas,",
      "> bitte neu starten.",
      "",
      "Von meinem iPhone gesendet",
    ].join("\n");
    expect(fresh(text)).toBe(
      "Hallo,\n\ndanke, es geht jetzt.\n\nViele Grüße\nJonas",
    );
    expect(split(text).map(([kind]) => kind)).toEqual([
      "new",
      "quoted",
      "signature",
    ]);
  });

  test("Polish: W dniu … napisał: and Gmail's … napisał(a):", () => {
    const thunderbird = [
      "Dzień dobry,",
      "",
      "nadal nie działa.",
      "",
      "Pozdrawiam",
      "Kasia",
      "",
      "W dniu 3.11.2026 o 10:12, Acme Support napisał:",
      "> Dzień dobry,",
      "> proszę spróbować ponownie.",
    ].join("\n");
    expect(fresh(thunderbird)).toBe(
      "Dzień dobry,\n\nnadal nie działa.\n\nPozdrawiam\nKasia",
    );
    const gmail = [
      "Nadal nie działa.",
      "",
      "Wysłane z iPhone'a",
      "",
      "pon., 3 lis 2026 o 10:12 Acme Support <help@example.test>",
      "napisał(a):",
      "",
      "> Proszę spróbować ponownie.",
    ].join("\n");
    expect(split(gmail)).toEqual([
      ["new", "Nadal nie działa."],
      ["signature", "Wysłane z iPhone'a"],
      ["quoted", gmail.slice(gmail.indexOf("pon.,")).trim()],
    ]);
  });

  test("bottom-posted: the quote first, then the reply and a -- signature", () => {
    const text = [
      "On Mon, 3 Nov 2026 at 10:12, Acme Support <help@example.test> wrote:",
      "> Shall we reset your workspace?",
      "",
      "Yes, please reset it.",
      "",
      "-- ",
      "Alice Example",
      "Example Corp",
      "",
    ].join("\n");
    expect(split(text)).toEqual([
      ["quoted", text.slice(0, text.indexOf("\n\nYes")).trim()],
      ["new", "Yes, please reset it."],
      ["signature", "-- \nAlice Example\nExample Corp".trim()],
    ]);
    // A quote at the very start with no attribution is history too.
    expect(fresh("> Shall we reset it?\n\nYes please.")).toBe("Yes please.");
  });

  test("a message with no quote is all new", () => {
    const text =
      "Hi, how do I change the default model a new session uses? Thanks, Alice";
    expect(split(text)).toEqual([["new", text]]);
    expect(hasQuotedParts({ text, split: splitEmailText(text) })).toBe(false);
  });

  test("> lines in the middle stay: inline answers and pasted output", () => {
    const text =
      "I ran this:\n\n> bun run build\n> error: missing module\n\nWhat does it mean?";
    expect(split(text)).toEqual([["new", text]]);
  });

  test("a forward keeps its header block visible", () => {
    const text = [
      "See the error below.",
      "",
      "---------- Forwarded message ---------",
      "From: Build Bot <bot@example.test>",
      "Date: Mon, 3 Nov 2026 at 10:12",
      "Subject: Build failed",
      "To: <alice@example.test>",
      "",
      "Build 12 failed.",
    ].join("\n");
    expect(split(text)).toEqual([["new", text]]);
    const outlookForward = text.replace(/^-+ Forwarded message -+\n/m, "");
    expect(split(outlookForward, { subject: "FW: Build failed" })).toEqual([
      ["new", outlookForward],
    ]);
  });

  test("nothing new left: the whole text stays new", () => {
    const text = "> On Mon, 3 Nov 2026, Bob wrote:\n> hello";
    expect(split(text)).toEqual([["new", text]]);
    expect(split("")).toEqual([]);
  });

  test("a sentence ending in a colon is not an attribution", () => {
    const text = "On Monday this is what I saw:\n\nThe page was blank.";
    expect(split(text)).toEqual([["new", text]]);
  });

  test("the HTML part's quote container, when the text shows none", () => {
    // Gmail in a language the text rules don't know.
    const text = [
      "Pořád to nefunguje.",
      "",
      "po 3. 11. 2026 v 10:12 odesílatel Acme Support",
      "help@example.test napsal:",
      "Zkuste to prosím znovu.",
    ].join("\n");
    expect(split(text)).toEqual([["new", text]]);
    expect(split(text, { htmlNewText: "Pořád to\nnefunguje." })).toEqual([
      ["new", "Pořád to nefunguje."],
      ["quoted", text.slice(text.indexOf("po 3.")).trim()],
    ]);
    // A hint that isn't where the text starts is ignored.
    expect(split(text, { htmlNewText: "Something else" })).toEqual([
      ["new", text],
    ]);
  });

  test("the parts cover the text exactly, CRLF included", () => {
    const text =
      "Thanks!\r\n\r\nOn Mon, 3 Nov 2026 at 10:12, Acme <help@example.test> wrote:\r\n> hi\r\n";
    const s = splitEmailText(text);
    expect(s.parts[0]!.start).toBe(0);
    expect(s.parts.at(-1)!.end).toBe(text.length);
    for (let i = 1; i < s.parts.length; i++)
      expect(s.parts[i]!.start).toBe(s.parts[i - 1]!.end);
    expect(newTextOf({ text, split: s })).toBe("Thanks!");
  });

  test("stays fast on hostile text at the size cap", () => {
    const hostile = [
      "On " + "a ".repeat(MAX_TEXT_CHARS / 2),
      "On 1 x wrote\n".repeat(MAX_TEXT_CHARS / 13),
      "From: a\nSent: b\n".repeat(MAX_TEXT_CHARS / 16),
      "> a\n\n".repeat(MAX_TEXT_CHARS / 5),
    ];
    for (const text of hostile) {
      const started = performance.now();
      splitEmailText(text.slice(0, MAX_TEXT_CHARS), {
        htmlNewText: "a ".repeat(1000),
      });
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe("messageParts", () => {
  test("a split that doesn't fit the text reads as all new", () => {
    const text = "Hello\n> quoted";
    const bad = { v: 1, parts: [{ kind: "new" as const, start: 0, end: 3 }] };
    expect(messageParts({ text, split: bad })).toEqual([{ kind: "new", text }]);
    expect(messageParts({ text: null, split: bad })).toBeNull();
    expect(newTextOf({ text: null })).toBeNull();
  });
});
