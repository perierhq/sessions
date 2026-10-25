import { describe, expect, test } from "bun:test";
import { MAX_TEXT_CHARS } from "../../shared/support";
import { rawMail } from "../../server/support/testing/mail-fixture";
import { parseInbound } from "./parse";

const CTX = {
  inboxId: "inb_1",
  providerId: "imap:1:7",
  receivedAt: "2026-10-25T10:00:00.000Z",
};

const bytes = (raw: string) => new TextEncoder().encode(raw);

function concat(...parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === "string" ? bytes(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("parseInbound", () => {
  test("normalizes addresses and threading keys", async () => {
    const raw = rawMail({
      from: '"Ada Lovelace" <Ada@Example.TEST>',
      to: "Help <HELP@acme.example.test>, other@example.test",
      subject: "Broken login",
      messageId: "abc.123@Mail.Example.TEST",
      inReplyTo: "prev@acme.example.test",
      references: ["first@acme.example.test", "prev@acme.example.test"],
      headers: {
        Cc: "Bob <bob@example.test>",
        "Reply-To": "ada.other@example.test",
      },
      text: "Hi there",
    });
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.inboxId).toBe("inb_1");
    expect(m.channel).toBe("email");
    expect(m.providerId).toBe("imap:1:7");
    expect(m.receivedAt).toBe(CTX.receivedAt);
    expect(m.from).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.test",
    });
    expect(m.to).toEqual([
      { name: "Help", address: "help@acme.example.test" },
      { name: null, address: "other@example.test" },
    ]);
    expect(m.cc).toEqual([{ name: "Bob", address: "bob@example.test" }]);
    expect(m.replyTo).toEqual([
      { name: null, address: "ada.other@example.test" },
    ]);
    expect(m.subject).toBe("Broken login");
    expect(m.text.trim()).toBe("Hi there");
    expect(m.keys).toEqual({
      messageId: "abc.123@mail.example.test",
      inReplyTo: "prev@acme.example.test",
      references: ["first@acme.example.test", "prev@acme.example.test"],
    });
    expect(m.attachments).toEqual([]);
    expect(m.oversize).toBeUndefined();
  });

  test("missing ids stay null", async () => {
    const m = await parseInbound(
      bytes(rawMail({ from: "a@example.test" })),
      CTX,
    );
    expect(m.keys).toEqual({
      messageId: null,
      inReplyTo: null,
      references: [],
    });
  });

  test("an HTML-only body yields readable text", async () => {
    const raw = [
      "From: a@example.test",
      "To: help@acme.example.test",
      "Subject: Html",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Hello <b>there</b></p><script>x()</script></body></html>",
      "",
    ].join("\r\n");
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.text).toContain("Hello");
    expect(m.text).toContain("there");
    expect(m.text).not.toContain("<");
  });

  test("decodes a windows-1250 body", async () => {
    const encoded = new Uint8Array([
      0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6, 0x20, 0x67, 0xea, 0x9c, 0x6c, 0xb9,
      0x20, 0x6a, 0x61, 0x9f, 0xf1,
    ]);
    const raw = concat(
      [
        "From: a@example.test",
        "To: help@acme.example.test",
        "Subject: Charset",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=windows-1250",
        "Content-Transfer-Encoding: 8bit",
        "",
        "",
      ].join("\r\n"),
      encoded,
      "\r\n",
    );
    const m = await parseInbound(raw, CTX);
    expect(m.text.trim()).toBe("Zażółć gęślą jaźń");
  });

  test("keeps attachment content and size", async () => {
    const content = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 251);
    const b64 = Buffer.from(content)
      .toString("base64")
      .replace(/.{76}/g, "$&\r\n");
    const raw = [
      "From: a@example.test",
      "To: help@acme.example.test",
      "Subject: File",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached",
      "--b1",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      b64,
      "--b1--",
      "",
    ].join("\r\n");
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.text.trim()).toBe("See attached");
    expect(m.attachments).toHaveLength(1);
    const [a] = m.attachments;
    expect(a!.fileName).toBe("report.pdf");
    expect(a!.mimeType).toBe("application/pdf");
    expect(a!.sizeBytes).toBe(content.length);
    expect(a!.stored).toBe(false);
    expect(a!.expiresAt).toBeNull();
    expect(a!.id.length).toBeGreaterThan(0);
    expect(Buffer.from(a!.content!).equals(Buffer.from(content))).toBe(true);
  });

  test("loopHeaders holds only the listed headers", async () => {
    const raw = rawMail({
      from: "a@example.test",
      headers: {
        "Auto-Submitted": "auto-replied",
        Precedence: "bulk",
        "List-Id": "Acme <acme.example.test>",
        "List-Unsubscribe": "<mailto:leave@example.test>",
        "X-Autoreply": "yes",
        "X-Auto-Response-Suppress": "All",
        "Return-Path": "<>",
        "Authentication-Results": "mx.example.test; dkim=fail",
        "X-Other": "nope",
        Received: "from somewhere",
      },
    });
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.loopHeaders).toEqual({
      "auto-submitted": "auto-replied",
      precedence: "bulk",
      "list-id": "Acme <acme.example.test>",
      "list-unsubscribe": "<mailto:leave@example.test>",
      "x-autoreply": "yes",
      "x-auto-response-suppress": "All",
      "return-path": "<>",
      "authentication-results": "mx.example.test; dkim=fail",
    });
  });

  test("a huge References header is cut fast to its ends", async () => {
    // mailparser refuses a header block over 1 MB, so 50k ids is near the
    // most a message can carry.
    const refs = Array.from({ length: 50_000 }, (_, i) => `r${i}@x.test`);
    const raw = rawMail({ from: "a@example.test", references: refs });
    const started = performance.now();
    const m = await parseInbound(bytes(raw), CTX);
    expect(performance.now() - started).toBeLessThan(200);
    expect(m.keys.references.length).toBeLessThanOrEqual(21);
    expect(m.keys.references[0]).toBe("r0@x.test");
    expect(m.keys.references.at(-1)).toBe("r49999@x.test");
  });

  test("drops reference ids longer than 998 characters", async () => {
    const long = `${"a".repeat(1000)}@x.test`;
    const raw = rawMail({
      from: "a@example.test",
      references: ["one@x.test", long, "two@x.test", "one@x.test"],
    });
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.keys.references).toEqual(["one@x.test", "two@x.test"]);
  });

  test("cuts text over MAX_TEXT_CHARS", async () => {
    const raw = rawMail({
      from: "a@example.test",
      text: "x".repeat(MAX_TEXT_CHARS + 500),
    });
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.text.length).toBe(MAX_TEXT_CHARS);
    expect(m.text.endsWith("\n[…cut]")).toBe(true);
  });

  test("oversize keeps headers and drops the body", async () => {
    const raw = rawMail({
      from: "Ada <ada@example.test>",
      subject: "Big one",
      messageId: "big@example.test",
      text: "body text",
    });
    const headersOnly = raw.slice(0, raw.indexOf("\r\n\r\n") + 4);
    const m = await parseInbound(bytes(headersOnly), {
      ...CTX,
      oversize: true,
    });
    expect(m.oversize).toBe(true);
    expect(m.text).toBe("");
    expect(m.subject).toBe("Big one");
    expect(m.from.address).toBe("ada@example.test");
    expect(m.keys.messageId).toBe("big@example.test");
    expect(m.attachments).toEqual([]);
  });

  test("strips controls from the subject and display names, and caps them", async () => {
    const raw = [
      "From: =?utf-8?Q?Ada=0D=0ALovelace=07?= <ada@example.test>",
      "To: help@acme.example.test",
      "Subject: =?utf-8?Q?Hi=0D=0ABcc:_x=07=C2=85end?=",
      "",
      "body",
      "",
    ].join("\r\n");
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.subject).toBe("Hi Bcc: x end");
    expect(m.from).toEqual({ name: "Ada Lovelace", address: "ada@example.test" });

    const long = await parseInbound(
      bytes(rawMail({ from: "a@example.test", subject: "s".repeat(3000) })),
      CTX,
    );
    expect(long.subject.length).toBe(998);
  });

  test("drops addresses that are not one plain mailbox", async () => {
    const raw = rawMail({
      from: "a@example.test",
      to: '<a@b@x.test>, good@x.test, <"a b"@x.test>, noat.example.test',
    });
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.to).toEqual([{ name: null, address: "good@x.test" }]);
  });

  test("the text cut never splits a surrogate pair", async () => {
    const cutAt = MAX_TEXT_CHARS - "\n[…cut]".length;
    const raw = rawMail({
      from: "a@example.test",
      text: `${"x".repeat(cutAt - 1)}${"😀".repeat(400)}`,
    });
    const m = await parseInbound(bytes(raw), CTX);
    expect(m.text.endsWith("\n[…cut]")).toBe(true);
    const body = m.text.slice(0, -"\n[…cut]".length);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  test("a huge HTML body still yields text, quickly", async () => {
    const html = `<html><body><script>secret()</script>${"<p>Hello <b>there</b></p>".repeat(120_000)}</body></html>`;
    const raw = [
      "From: a@example.test",
      "To: help@acme.example.test",
      "Subject: Html",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "",
    ].join("\r\n");
    const started = performance.now();
    const m = await parseInbound(bytes(raw), CTX);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(m.text).toContain("Hello there");
    expect(m.text).not.toContain("<");
    expect(m.text).not.toContain("secret");
    expect(m.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  test("hostile HTML over the parse limit stays linear", async () => {
    const html = `${"<script>".repeat(150_000)}${"<style".repeat(150_000)}`;
    const raw = [
      "From: a@example.test",
      "Subject: Html",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "",
    ].join("\r\n");
    const started = performance.now();
    const m = await parseInbound(bytes(raw), CTX);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(m.text).not.toContain("<");
  });

  test("an unreadable message keeps its headers and says so", async () => {
    const raw = rawMail({
      from: "Ada <ada@example.test>",
      subject: "Broken",
      messageId: "broken@example.test",
    });
    const headers = raw.slice(0, raw.indexOf("\r\n\r\n") + 4);
    const m = await parseInbound(bytes(headers), { ...CTX, unreadable: true });
    expect(m.unreadable).toBe(true);
    expect(m.oversize).toBeUndefined();
    expect(m.text).toBe("(This message couldn't be read)");
    expect(m.subject).toBe("Broken");
    expect(m.keys.messageId).toBe("broken@example.test");
    expect(m.attachments).toEqual([]);
  });
});
