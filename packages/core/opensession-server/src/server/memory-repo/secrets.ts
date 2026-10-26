/**
 * Refuse content that looks like a credential before it reaches memory or
 * knowledge.
 *
 * Git keeps everything ever committed, and removing a leaked secret means
 * rewriting history on every clone. So a write that contains one is
 * rejected instead of stored, and ingestion redacts (redactSecrets) before
 * it writes. The patterns are specific token formats, not guesses about
 * "password-like" strings, so ordinary prose never trips them; obvious
 * documentation placeholders (`AKIA…EXAMPLE`, `xxxx`, `<token>`,
 * `password=changeme`, credentials for a localhost URL) are let through.
 */

interface SecretPattern {
  name: string;
  /** Global; matched against one line at a time. */
  pattern: RegExp;
  /** The part that would be the credential; defaults to the whole match. */
  secret?: (match: RegExpMatchArray) => string;
  /** True when this match is a known-harmless value. */
  allow?: (match: RegExpMatchArray) => boolean;
}

const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i;
const PLACEHOLDER_VALUES = new Set(["password", "changeme"]);

const PATTERNS: SecretPattern[] = [
  { name: "private key", pattern: PEM },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  { name: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    name: "SendGrid key",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}/g,
  },
  { name: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  {
    name: "Slack webhook",
    pattern:
      /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,}/g,
  },
  { name: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "Stripe secret key", pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: "JSON web token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: "bearer token",
    pattern: /\b[Bb]earer[ \t]+([A-Za-z0-9._~+/-]{20,}=*)/g,
    secret: (m) => m[1],
  },
  {
    name: "password",
    pattern: /(?<![A-Za-z0-9])(?:password|passwd|pwd)=([^\s&"'<>;,]{4,})/gi,
    secret: (m) => m[1],
    allow: (m) => PLACEHOLDER_VALUES.has(m[1].toLowerCase()),
  },
  {
    name: "credential in a URL",
    pattern:
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{8,})@(\[[^\]\s]*\]|[^\s/:?#]+)/gi,
    secret: (m) => m[1],
    allow: (m) => LOCAL_HOST.test(m[2]),
  },
];

/** Documentation stand-ins: AWS's `…EXAMPLE` keys, `xxxx`, `<your-token>`,
 *  masked `***` and `${VAR}` / `{{var}}` references. */
function isPlaceholder(secret: string): boolean {
  return (
    /example/i.test(secret) ||
    /x{4}/i.test(secret) ||
    /<[^>]*>/.test(secret) ||
    /\*{3}/.test(secret) ||
    /^\$\{?[A-Za-z_]/.test(secret) ||
    secret.includes("{{")
  );
}

function isRealSecret(p: SecretPattern, match: RegExpMatchArray): boolean {
  if (p.allow?.(match)) return false;
  return !isPlaceholder(p.secret ? p.secret(match) : match[0]);
}

export interface SecretFinding {
  name: string;
  line: number;
}

/** The first credential-looking match per line, 0-based line numbers. */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split("\n").forEach((line, index) => {
    for (const p of PATTERNS) {
      for (const match of line.matchAll(p.pattern)) {
        if (isRealSecret(p, match)) {
          findings.push({ name: p.name, line: index });
          return;
        }
      }
    }
  });
  return findings;
}

const PEM_BEGIN = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----`;
const PEM_END = String.raw`-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----`;
/** A whole key block, BEGIN to END (keys run to a few hundred lines). */
const PEM_BLOCK = new RegExp(
  `${PEM_BEGIN}[^\\n]*\\n(?:[^\\n]*\\n){0,400}?${PEM_END}`,
  "g",
);
/** A BEGIN line with no END: it and the space-free lines under it. */
const PEM_OPEN = new RegExp(`${PEM_BEGIN}(?:\\n[^\\s]+(?=\\n|$))*`, "g");

/** The text with every credential findSecrets would flag replaced by
 *  `[redacted <kind>]`; a private key goes with its whole block. For
 *  ingestion, which keeps the rest of a message or page. */
export function redactSecrets(text: string): string {
  let out = text
    .replace(PEM_BLOCK, "[redacted private key]")
    .replace(PEM_OPEN, "[redacted private key]");
  for (const p of PATTERNS)
    out = out.replace(p.pattern, (whole: string, ...rest: unknown[]) => {
      // rest is the capture groups, then offset and input.
      const match = [whole, ...rest.slice(0, -2)] as RegExpMatchArray;
      return isRealSecret(p, match) ? `[redacted ${p.name}]` : whole;
    });
  return out;
}

export class SecretInMemoryError extends Error {
  constructor(public readonly finding: SecretFinding) {
    super(
      `This looks like a ${finding.name}. Memory never stores credentials; remove it and try again.`,
    );
    this.name = "SecretInMemoryError";
  }
}

export function assertNoSecrets(text: string): void {
  const [finding] = findSecrets(text);
  if (finding) throw new SecretInMemoryError(finding);
}
