import { describe, expect, test } from "bun:test";
import { findSecrets, redactSecrets } from "./secrets";

// Built from parts so the repository itself never holds a token-shaped
// string.
const j = (...parts: string[]) => parts.join("");

const REAL: Array<[string, string]> = [
  ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ["private key", "-----BEGIN PGP PRIVATE KEY BLOCK-----"],
  ["AWS access key", j("AKIA", "Q3EGRTZB7XKMN2PL")],
  [
    "JSON web token",
    j(
      "eyJ",
      "hbGciOiJIUzI1NiJ9.",
      "eyJ",
      "zdWIiOiIxMjM0In0.",
      "dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ),
  ],
  ["GitLab token", j("glpat", "-", "x8Kq2vLmZr7TnB4wYc1d")],
  ["npm token", j("npm", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")],
  [
    "SendGrid key",
    j(
      "SG",
      ".",
      "aB3dE5fG7hI9jK1lM3nO5p",
      ".",
      "Qr7sT9uV1wX3yZ5aB7cD9eF1gH3iJ5kL7mN9oP1qR3s",
    ),
  ],
  ["Hugging Face token", j("hf", "_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345")],
  [
    "Slack webhook",
    j(
      "https://hooks.slack",
      ".com/services/",
      "T0A1B2C3D/B0E4F5G6H/",
      "q7R8s9T0u1V2w3X4y5Z6a7B8",
    ),
  ],
  ["bearer token", j("Authorization: Bearer ", "q7R8s9T0u1V2w3X4y5Z6a7B8c9")],
  ["password", j("db?user=app&pass", "word=Tr0ub4dor3")],
  [
    "credential in a URL",
    j("postgres://app:", "s3cretPassw0rd@db.acme.test/app"),
  ],
];

const PLACEHOLDERS = [
  j("AKIA", "IOSFODNN7EXAMPLE"),
  "Authorization: Bearer <your-token-here-placeholder>",
  j("Authorization: Bearer ", "xxxxxxxxxxxxxxxxxxxxxxxx"),
  "password=<password>",
  "password=password",
  "password=changeme",
  "password=xxxx",
  j("postgres://app:", "localpassword@localhost:5432/app"),
  j("postgres://app:", "localpassword@127.0.0.1/app"),
  j("glpat", "-", "xxxxxxxxxxxxxxxxxxxx"),
  "The bearer of this letter is welcome.",
  "Set the password field to something long.",
];

describe("secret detection", () => {
  test("finds each credential format", () => {
    for (const [name, line] of REAL)
      expect({ line, found: findSecrets(line) }).toEqual({
        line,
        found: [{ name, line: 0 }],
      });
  });

  test("leaves documentation placeholders alone", () => {
    for (const line of PLACEHOLDERS)
      expect({ line, found: findSecrets(line) }).toEqual({ line, found: [] });
  });

  test("a real token after a placeholder on the same line still counts", () => {
    expect(
      findSecrets(j("AKIA", "IOSFODNN7EXAMPLE then AKIA", "Q3EGRTZB7XKMN2PL")),
    ).toEqual([{ name: "AWS access key", line: 0 }]);
  });

  test("redactSecrets replaces credentials and keeps placeholders", () => {
    const text = [
      "Intro",
      ...REAL.filter(([name]) => name !== "private key").map(
        ([, line]) => line,
      ),
      ...PLACEHOLDERS,
    ].join("\n");
    const redacted = redactSecrets(text);
    expect(findSecrets(redacted)).toEqual([]);
    for (const placeholder of PLACEHOLDERS)
      expect(redacted).toContain(placeholder);
    expect(redacted).toContain("[redacted AWS access key]");
    expect(redacted.startsWith("Intro\n")).toBe(true);
  });

  test("redactSecrets drops a whole private key block", () => {
    const text = [
      "Before",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
      "-----END OPENSSH PRIVATE KEY-----",
      "After",
    ].join("\n");
    expect(redactSecrets(text)).toBe("Before\n[redacted private key]\nAfter");
  });

  test("redactSecrets drops an unterminated key and the lines under it", () => {
    const text = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "lQOYBGSomeBase64",
      "=abcd",
      "Later prose stays.",
    ].join("\n");
    expect(redactSecrets(text)).toBe(
      "[redacted private key]\nLater prose stays.",
    );
  });
});
