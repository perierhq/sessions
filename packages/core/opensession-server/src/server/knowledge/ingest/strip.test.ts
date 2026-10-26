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
});
