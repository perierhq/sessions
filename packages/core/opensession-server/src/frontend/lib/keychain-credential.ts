/**
 * The Keychain's add and edit dialog as plain data: the form a credential
 * opens with, the spec it saves, whether an edit changed anything, and the
 * words for its expiry and its test result. Pure, so the dialog stays a
 * component file and these rules are tested on their own.
 */
import {
  KEYCHAIN_METHODS,
  type KeychainCredentialDto,
  type KeychainCredentialSpec,
  type KeychainMethod,
} from "./api/settings";

export interface CredentialFormState {
  service: string;
  host: string;
  description: string;
  header: string;
  methods: KeychainMethod[];
  /** Comma-separated, as typed. */
  prefixes: string;
  statusOnly: boolean;
  workspace: boolean;
  /** YYYY-MM-DD, or "" for none. */
  expiresOn: string;
  testPath: string;
}

export function credentialForm(c?: KeychainCredentialDto): CredentialFormState {
  return {
    service: c?.service ?? "",
    host: c?.host ?? "",
    description: c?.description ?? "",
    header: c?.injection?.header ?? "",
    methods: KEYCHAIN_METHODS.filter((m) => c?.allowedMethods?.includes(m)),
    prefixes: (c?.allowedPathPrefixes ?? []).join(", "),
    statusOnly: c?.statusOnly === true,
    workspace: c?.scope === "workspace",
    expiresOn: c?.expiresOn ?? "",
    testPath: c?.testPath ?? "",
  };
}

export function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Every field of the form as the server takes it. An empty field is sent
 * as a clear (`""`, `[]`, `null`), so saving an edit can remove a limit;
 * on an add the server drops them.
 */
export function credentialSpec(
  form: CredentialFormState,
): KeychainCredentialSpec & { service: string; host: string } {
  const header = form.header.trim();
  return {
    service: form.service.trim(),
    host: form.host.trim(),
    description: form.description.trim(),
    injection: header ? { header } : {},
    allowedMethods: form.methods,
    allowedPathPrefixes: list(form.prefixes),
    statusOnly: form.statusOnly,
    scope: form.workspace ? "workspace" : "personal",
    expiresOn: form.expiresOn || null,
    testPath: form.testPath.trim() || null,
  };
}

/** Whether the form saves something different from where it started. */
export function formChanged(
  before: CredentialFormState,
  after: CredentialFormState,
): boolean {
  return (
    JSON.stringify(credentialSpec(before)) !==
    JSON.stringify(credentialSpec(after))
  );
}

const DAY_MS = 86_400_000;

/** A credential's expiry as a person reads it, in whole UTC days, as the
 *  server counts them. Null without one. */
export function expiryNote(
  expiresOn: string | undefined,
  now = Date.now(),
): { text: string; expired: boolean } | null {
  if (!expiresOn) return null;
  const today = Date.parse(
    `${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const last = Date.parse(`${expiresOn}T00:00:00Z`);
  if (Number.isNaN(last)) return null;
  const days = Math.round((last - today) / DAY_MS);
  if (days < 0) return { text: `Expired on ${expiresOn}`, expired: true };
  if (days === 0) return { text: "Expires today", expired: false };
  if (days === 1) return { text: "Expires tomorrow", expired: false };
  return { text: `Expires in ${days} days`, expired: false };
}

export type TestResult = { status: number; reason: string } | { error: string };

export interface TestOutcome {
  text: string;
  tone: "success" | "warning" | "danger";
}

/** What a test's line says, and its tone: green for a 2xx, amber for any
 *  other answer, red when no answer came back. Never the body. */
export function testOutcome(result: TestResult, path: string): TestOutcome {
  if ("error" in result)
    return {
      text: result.error.charAt(0).toUpperCase() + result.error.slice(1),
      tone: "danger",
    };
  const line = `GET ${path} answered ${result.status}${result.reason ? ` ${result.reason}` : ""}`;
  if (result.status >= 200 && result.status < 300)
    return { text: line, tone: "success" };
  if (result.status === 401 || result.status === 403)
    return {
      text: `${line}. Check the secret and the header`,
      tone: "warning",
    };
  return { text: line, tone: "warning" };
}
