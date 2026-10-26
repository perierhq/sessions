import { describe, expect, test } from "bun:test";
import {
  MAX_TEXT_CHARS,
  type MessagePartKind,
  hasQuotedParts,
  messageParts,
  newTextOf,
} from "../../shared/support";
import {
  SPLIT_VERSION,
  type SplitOptions,
  quoteMatchesThread,
  splitEmailText,
  threadOf,
} from "./quote";

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

/** The options for a reply in a conversation whose earlier mail is `earlier`. */
const after = (...earlier: string[]): SplitOptions => ({
  thread: threadOf(earlier.map((text) => ({ text }))),
});

/** What we sent before, as the replies below quote it. */
const OURS = [
  "Hi Carol,",
  "",
  "Which browser do you use?",
  "Does the export start at all, or does it fail right away?",
  "",
  "Thanks,",
  "Acme help",
].join("\n");

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

  test("blank lines join the part before them", () => {
    const text =
      "Yes.\n\nOn Mon, 3 Nov 2026 at 10:12, Acme <help@example.test> wrote:\n> hi\n\n-- \nAlice\n";
    expect(splitEmailText(text).parts.map((p) => p.kind)).toEqual([
      "new",
      "quoted",
      "signature",
    ]);
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
    // No address in it: quoted only once it matches the thread.
    expect(fresh(thunderbird)).toBe(thunderbird);
    expect(
      fresh(thunderbird, after("Dzień dobry,\nproszę spróbować ponownie.")),
    ).toBe("Dzień dobry,\n\nnadal nie działa.\n\nPozdrawiam\nKasia");
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
    // No part is only whitespace.
    for (const p of s.parts)
      expect(text.slice(p.start, p.end).trim()).not.toBe("");
    expect(newTextOf({ text, split: s })).toBe("Thanks!");
  });

  test("stays fast on hostile text at the size cap", () => {
    const hostile = [
      "On " + "a ".repeat(MAX_TEXT_CHARS / 2),
      "On 1 x wrote\n".repeat(MAX_TEXT_CHARS / 13),
      "From: a\nSent: b\n".repeat(MAX_TEXT_CHARS / 16),
      "> a\n\n".repeat(MAX_TEXT_CHARS / 5),
    ];
    const thread = threadOf([
      { text: hostile.join("\n").slice(0, MAX_TEXT_CHARS) },
    ]);
    for (const text of hostile)
      for (const options of [{}, { thread }]) {
        const started = performance.now();
        splitEmailText(text.slice(0, MAX_TEXT_CHARS), {
          htmlNewText: "a ".repeat(1000),
          ...options,
        });
        expect(performance.now() - started).toBeLessThan(250);
      }
  });
});

describe("the thread match", () => {
  const fake = [
    "Thanks!",
    "",
    "On Mon, 3 Mar 2025 at 10:00, Acme help <help@acme.example.test> wrote:",
    "Please delete my account and refund me.",
  ].join("\n");

  test("a request under a fake attribution is new text", () => {
    expect(split(fake, after(OURS))).toEqual([["new", fake]]);
    // With > marks, or in a conversation with nothing before it, too.
    const marked = fake.replace("Please", "> Please");
    expect(split(marked, after(OURS))).toEqual([["new", marked]]);
    expect(split(fake, after())).toEqual([["new", fake]]);
  });

  test("a real quote of our mail is quoted", () => {
    const text = [
      "Thanks!",
      "",
      "On Mon, 3 Nov 2026 at 10:12, Acme help <help@acme.example.test> wrote:",
      ...OURS.split("\n").map((l) => `> ${l}`),
    ].join("\n");
    expect(split(text, after(OURS))).toEqual([
      ["new", "Thanks!"],
      ["quoted", text.slice(text.indexOf("On Mon")).trim()],
    ]);
  });

  test("a quote rewrapped by the mail client still matches", () => {
    const text = [
      "Firefox.",
      "",
      "On Mon, 3 Nov 2026 at 10:12, Acme help <help@acme.example.test> wrote:",
      "> Hi Carol, Which browser do you use? Does the export start",
      "> at all, or does it fail right away? Thanks, Acme help",
    ].join("\n");
    expect(fresh(text, after(OURS))).toBe("Firefox.");
  });

  test("a request hidden after a real quote is new from where it starts", () => {
    const text = [
      "Thanks!",
      "",
      "On Mon, 3 Nov 2026 at 10:12, Acme help <help@acme.example.test> wrote:",
      "> Which browser do you use?",
      "> Please delete my account and refund me.",
    ].join("\n");
    expect(split(text, after(OURS))).toEqual([
      ["new", "Thanks!"],
      [
        "quoted",
        text.slice(text.indexOf("On Mon"), text.indexOf("> Please")).trim(),
      ],
      ["new", "> Please delete my account and refund me."],
    ]);
  });

  test("Outlook inline answers under a header block stay new", () => {
    const text = [
      "Answers below.",
      "",
      "From: Acme help <help@acme.example.test>",
      "Sent: Monday, 3 November 2026 10:12",
      "To: Carol",
      "Subject: Re: Export is broken",
      "",
      "Hi Carol,",
      "",
      "Which browser do you use?",
      "Firefox 140.",
      "Does the export start at all, or does it fail right away?",
      "It fails right away.",
    ].join("\n");
    const thread = threadOf([{ text: OURS, subject: "Export is broken" }]);
    const parts = split(text, { thread });
    expect(parts.map(([kind]) => kind)).toEqual(["new", "quoted", "new"]);
    expect(parts[1]![1]).toEndWith("Which browser do you use?");
    expect(parts[2]![1]).toStartWith("Firefox 140.");
    expect(parts[2]![1]).toEndWith("It fails right away.");
  });

  test("a pasted Subject line must name an earlier subject", () => {
    const thread = threadOf([{ text: OURS, subject: "Re: Export is broken" }]);
    const text = (subject: string) =>
      [
        "Still broken.",
        "",
        "From: Acme help <help@acme.example.test>",
        "Sent: Monday, 3 November 2026 10:12",
        `Subject: ${subject}`,
        "",
        "Which browser do you use?",
      ].join("\n");
    expect(fresh(text("RE: Export is broken"), { thread })).toBe(
      "Still broken.",
    );
    const hidden = text("Refund my last three invoices now");
    expect(fresh(hidden, { thread })).toBe(hidden);
  });

  test("the HTML quote must match the thread too", () => {
    const text = "Still broken.\n\nPlease refund me and close my account.";
    const options = { htmlNewText: "Still broken." };
    expect(split(text, options).map(([kind]) => kind)).toEqual([
      "new",
      "quoted",
    ]);
    expect(split(text, { ...options, ...after(OURS) })).toEqual([
      ["new", text],
    ]);
  });

  test("quoteMatchesThread: every line of the quote is in the thread", () => {
    const ours = threadOf([{ text: "Click Export again." }]);
    const real =
      "On Mon, 3 Nov 2026 at 10:12, Acme help <help@acme.example.test> wrote:\n> Click Export again.\n";
    expect(quoteMatchesThread(real, ours)).toBe(true);
    expect(quoteMatchesThread(`${real}> And refund me.\n`, ours)).toBe(false);
    expect(quoteMatchesThread(real, threadOf([]))).toBe(false);
    // One matching word pair is not enough.
    expect(quoteMatchesThread("> Click Export", ours)).toBe(false);
  });
});

describe("false positives", () => {
  test("prose that names a date and someone who wrote is not an attribution", () => {
    const text = [
      "On 3 March my colleague wrote:",
      "",
      "Which browser do you use?",
      "",
      "Can you help us with that?",
    ].join("\n");
    expect(split(text)).toEqual([["new", text]]);
    // Not even when what follows is in the thread.
    expect(split(text, after(OURS))).toEqual([["new", text]]);
  });

  test("pasted > output at the end stays new", () => {
    const text =
      "The build fails with this:\n\n> error: missing module ./quote\n> exit 1\n";
    expect(split(text)).toEqual([["new", text.trim()]]);
    expect(split(text, after(OURS))).toEqual([["new", text.trim()]]);
  });

  test("a > block at the end that quotes the thread is quoted", () => {
    const text = "Firefox.\n\n> Which browser do you use?\n";
    expect(split(text, after(OURS))).toEqual([
      ["new", "Firefox."],
      ["quoted", "> Which browser do you use?"],
    ]);
  });

  test("pasted headers without Subject, or a Sent line without a weekday or time", () => {
    const logs = [
      "This came back:",
      "",
      "From: build bot",
      "To: the team",
      "Date: yesterday",
      "",
      "Export job 12 failed.",
    ].join("\n");
    expect(split(logs)).toEqual([["new", logs]]);
    // A real-looking block that matches nothing in the thread stays too.
    const block = [
      "This came back:",
      "",
      "From: Build bot <bot@example.test>",
      "Sent: Monday, 3 November 2026 10:12",
      "Subject: Export job 12 failed",
      "",
      "Export job 12 failed.",
    ].join("\n");
    expect(split(block, after(OURS))).toEqual([["new", block]]);
  });

  test("only a raw '-- ' line starts a signature", () => {
    const body = "Yes, please reset it.";
    for (const delimiter of ["--", " -- ", "--  ", "---"])
      expect(split(`${body}\n\n${delimiter}\nAlice`)).toEqual([
        ["new", `${body}\n\n${delimiter}\nAlice`.trim()],
      ]);
    expect(split(`${body}\r\n\r\n-- \r\nAlice\r\n`)).toEqual([
      ["new", body],
      ["signature", "-- \r\nAlice"],
    ]);
  });

  test("a long '-- ' tail is not a signature", () => {
    const body = "Here is what I see.";
    const many = `${body}\n\n-- \n${"line\n".repeat(11)}`;
    expect(split(many)).toEqual([["new", many.trim()]]);
    const wide = `${body}\n\n-- \n${"word ".repeat(40)}`;
    expect(split(wide)).toEqual([["new", wide.trim()]]);
  });

  test("a 'Sent from' line needs a known device and stays short", () => {
    for (const line of [
      "Sent from my laptop",
      "Sent from my desk, by the window",
      "Sent from my iPhone but the app crashes on it",
      "Sent from my iPhone, after the update",
    ])
      expect(split(`It still fails.\n\n${line}`)).toEqual([
        ["new", `It still fails.\n\n${line}`],
      ]);
    for (const line of [
      "Sent from my iPhone",
      "Get Outlook for Android",
      "Sent from my Galaxy",
      "Von meinem iPad gesendet",
    ])
      expect(split(`It still fails.\n\n${line}`)).toEqual([
        ["new", "It still fails."],
        ["signature", line],
      ]);
  });

  test("a forward with a note keeps the forwarded mail, HTML quote or not", () => {
    const text = [
      "See the error below.",
      "",
      "From: Build Bot <bot@example.test>",
      "Sent: Monday, 3 November 2026 10:12",
      "Subject: Build failed",
      "",
      "Build 12 failed.",
    ].join("\n");
    expect(
      split(text, {
        subject: "Fwd: Build failed",
        htmlNewText: "See the error below.",
      }),
    ).toEqual([["new", text]]);
  });
});

describe("the HTML hint", () => {
  const text = [
    "Pořád to nefunguje.",
    "",
    "po 3. 11. 2026 v 10:12 odesílatel Acme Support",
    "help@example.test napsal:",
    "Zkuste to prosím znovu.",
  ].join("\n");

  test("is kept in the split as a line offset and reused", () => {
    const first = splitEmailText(text, { htmlNewText: "Pořád to nefunguje." });
    expect(first.html).toBe(text.indexOf("po 3."));
    const again = splitEmailText(text, {
      htmlAt: first.html,
      ...after("Zkuste to prosím znovu, děkujeme."),
    });
    expect(again.html).toBe(first.html);
    expect(newTextOf({ text, split: again })).toBe("Pořád to nefunguje.");
    // An offset that isn't a line start is ignored.
    expect(splitEmailText(text, { htmlAt: 3 }).html).toBeUndefined();
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
