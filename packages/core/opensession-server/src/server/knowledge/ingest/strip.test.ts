import { describe, expect, test } from "bun:test";
import { stripCustomerData } from "./strip";

const alice = {
  name: "Alice Customer",
  address: "alice@customer.example.test",
};
const SECRET = `sk_live_${"a1B2c3D4e5F6g7H8i9J0k1L2"}`;

describe("stripCustomerData", () => {
  test("strip removes customer identity", () => {
    const { text, clean } = stripCustomerData(
      "Hi, I'm Alice Customer (alice@customer.example.test, +48 600 100 200). See https://evil.example.test/x",
      alice,
    );
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("alice@");
    expect(text).not.toContain("600 100 200");
    expect(text).not.toContain("evil.example.test");
    expect(text).toContain("the customer");
    expect(clean).toBe(true);
  });

  test("name tokens match whole words in any case", () => {
    const { text } = stripCustomerData(
      "Thanks ALICE, customer support says alice is right. Malice stays.",
      alice,
    );
    expect(text).toBe(
      "Thanks the customer, the customer support says the customer is right. Malice stays.",
    );
  });

  test("one-letter name parts are left alone", () => {
    const { text } = stripCustomerData("A note about J exports.", {
      name: "J A",
      address: "j@customer.example.test",
    });
    expect(text).toBe("A note about J exports.");
  });

  test("keeps links to the support hosts and drops the rest", () => {
    const { text } = stripCustomerData(
      "Read https://help.acme.example.test/export and evil.example.test/y, or www.other.example.test.",
      alice,
      { keepHosts: ["help.acme.example.test"] },
    );
    expect(text).toContain("https://help.acme.example.test/export");
    expect(text).not.toContain("evil.example.test");
    expect(text).not.toContain("other.example.test");
  });

  test("file names and dates are not links or phone numbers", () => {
    const { text } = stripCustomerData(
      "Edit settings.json; it changed on 2026-10-20 in v1.4.0.",
      alice,
    );
    expect(text).toBe(
      "Edit settings.json; it changed on 2026-10-20 in v1.4.0.",
    );
  });

  test("drops quoted reply blocks", () => {
    const { text } = stripCustomerData(
      [
        "The export works now, thanks.",
        "",
        "On Mon, 19 Oct 2026 at 08:12, Acme Support <support@acme.example.test> wrote:",
        "> Try the CSV button.",
        ">> Older quote",
      ].join("\n"),
      alice,
    );
    expect(text).toBe("The export works now, thanks.");
  });

  test("drops signatures", () => {
    const dashed = stripCustomerData(
      "How do I export?\n-- \nAlice Customer\nCEO, Customer Ltd\nStreet 1",
      alice,
    );
    expect(dashed.text).toBe("How do I export?");
    const signOff = stripCustomerData(
      "How do I export?\n\nBest regards,\nA. C.\nCustomer Ltd",
      alice,
    );
    expect(signOff.text).toBe("How do I export?");
    const phone = stripCustomerData(
      "Is CSV supported?\n\nSent from my iPhone",
      alice,
    );
    expect(phone.text).toBe("Is CSV supported?");
  });

  test("a sign-off as the first line is not a signature", () => {
    const { text } = stripCustomerData("Thanks,\nthe export works.", alice);
    expect(text).toBe("Thanks,\nthe export works.");
  });

  test("secret-looking text skips the pair", () => {
    expect(stripCustomerData(`My key is ${SECRET}`, alice).clean).toBe(false);
  });

  test("a secret hidden in a link is still unclean", () => {
    const { text, clean } = stripCustomerData(
      "Use https://admin:hunter2hunter2@evil.example.test/db",
      alice,
    );
    expect(text).not.toContain("hunter2");
    expect(clean).toBe(false);
  });

  test("a secret only in the quoted history does not make the reply unclean", () => {
    const { text, clean } = stripCustomerData(
      `Please rotate it.\n\nOn Mon, 19 Oct 2026, Alice wrote:\n> ${SECRET}`,
      alice,
    );
    expect(text).toBe("Please rotate it.");
    expect(clean).toBe(true);
  });

  test("invisible characters cannot hide a name or address", () => {
    const { text } = stripCustomerData(
      "Al\u200bice at alice\u200d@customer.example.test",
      alice,
    );
    expect(text).not.toMatch(/alice/i);
  });

  test("works without a display name", () => {
    const { text } = stripCustomerData("Write to alice@customer.example.test", {
      address: "alice@customer.example.test",
    });
    expect(text).not.toContain("alice@");
  });

  test("names match without diacritics, inflected and split", () => {
    const customer = {
      name: "Łukasz Żółć-Nowak O’Brien",
      address: "l.zolc@acme.example.test",
    };
    const { text } = stripCustomerData(
      "Lukasz wrote, then Łukasza and Zolc, also Nowakowi, Żółć-Nowak, OBrien and O'Brien.",
      customer,
    );
    expect(text).not.toMatch(/lukasz|łukasz|zolc|żółć|nowak|brien/i);
  });

  test("an underscore does not hide a name", () => {
    const { text } = stripCustomerData("Ask alice_ops about it.", alice);
    expect(text).toBe("Ask the customer_ops about it.");
  });

  test("address local part and company domain are name tokens", () => {
    const { text } = stripCustomerData(
      "Hello team. Bob from Contoso said Marek and contoso are fine; robert42 too.",
      { address: "marek.robert42+x@contoso.example.test" },
    );
    expect(text).not.toMatch(/marek|contoso|robert/i);
    expect(text).toContain("Bob");
  });

  test("public mail providers are no name tokens", () => {
    const { text } = stripCustomerData("Gmail and Outlook both work.", {
      address: "someone@gmail.com",
    });
    expect(text).toBe("Gmail and Outlook both work.");
  });

  test("stopwords are never name tokens", () => {
    const { text } = stripCustomerData("Support will reply with the steps.", {
      name: "Support With",
      address: "support@acme.example.test",
    });
    expect(text).toBe("Support will reply with the steps.");
  });

  test("a short first-line greeting is dropped", () => {
    expect(stripCustomerData("Hi Marta,\nPress Export.", alice).text).toBe(
      "Press Export.",
    );
    expect(
      stripCustomerData(
        "Dzień dobry Pani Marto!\nProszę kliknąć Eksport.",
        alice,
      ).text,
    ).toBe("Proszę kliknąć Eksport.");
  });

  test("quoted history is cut from the first header block", () => {
    const cases = [
      "From: Alice <a@x.example.test>\nSent: Monday\nTo: support\nSubject: Re: export\n\nOld text",
      "________________________________\nOld text",
      "Am Mo., 19. Okt. 2026 um 08:12 Uhr schrieb Alice <a@x.example.test>:\nOld text",
      "Le lun. 19 oct. 2026 à 08:12, Alice <a@x.example.test> a écrit :\nOld text",
      "W dniu 19.10.2026 o 08:12, Alice <a@x.example.test> napisał(a):\nOld text",
      "On Mon, 19 Oct 2026, Alice wrote:\nOld text\n> quoted",
    ];
    for (const tail of cases) {
      const { text } = stripCustomerData(`Press Export.\n\n${tail}`, alice);
      expect(text).toBe("Press Export.");
    }
  });

  test("identifiers are removed", () => {
    const { text } = stripCustomerData(
      [
        "IBAN PL61 1090 1014 0000 0712 1981 2874, DE89370400440532013000.",
        "Id 3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f, invoice INV-48213, cus_N3xT9aQ2LmP0.",
        "Order #48213. Server 203.0.113.7 and 2001:db8::8a2e:370:7334.",
        "Write to ałice@przykład.example.test or bob at contoso dot example dot test or carol (at) acme (dot) test.",
        "RFC 5322 and ISO8601 at 10:30:00 stay, as does v1.4.0.",
      ].join("\n"),
      alice,
    );
    for (const gone of [
      "PL61",
      "DE8937",
      "3f2b8c1e",
      "INV-48213",
      "cus_",
      "#48213",
      "203.0.113",
      "2001:db8",
      "ałice",
      "contoso dot",
      "(at)",
    ])
      expect(text).not.toContain(gone);
    expect(text).toContain(
      "RFC 5322 and ISO8601 at 10:30:00 stay, as does v1.4.0.",
    );
  });

  test("a kept link with an opaque path segment is dropped", () => {
    const { text } = stripCustomerData(
      "See https://help.acme.example.test/export and https://help.acme.example.test/r/a8f3k2m9q7x1z5w0b4",
      alice,
      { keepHosts: ["help.acme.example.test"] },
    );
    expect(text).toContain("https://help.acme.example.test/export");
    expect(text).not.toContain("a8f3k2m9q7x1z5w0b4");
  });

  test("structure false keeps quotes, signatures and greetings", () => {
    const raw = "Hi there,\nPress Export.\n\nThanks,\n> keep";
    const out = stripCustomerData(raw, alice, { structure: false });
    expect(out.text).toBe(raw);
    expect(out.removed).toEqual([]);
  });

  test("reports which identity replacements ran", () => {
    const out = stripCustomerData(
      "Alice wrote from alice@customer.example.test, +48 600 100 200.",
      alice,
      { structure: false },
    );
    expect(new Set(out.removed)).toEqual(new Set(["name", "email", "phone"]));
  });

  test("a kept link naming the customer is dropped", () => {
    const { text } = stripCustomerData(
      "See https://help.acme.example.test/users/alice for it.",
      alice,
      { keepHosts: ["help.acme.example.test"] },
    );
    expect(text).toBe("See [link removed] for it.");
  });

  test("the placeholder is not replaced again", () => {
    const { text } = stripCustomerData("Ask the customer first.", alice, {
      structure: false,
    });
    expect(text).toBe("Ask the customer first.");
  });
});
