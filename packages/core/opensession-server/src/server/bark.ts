/**
 * Bark (https://github.com/Finb/Bark): native iPhone pushes through the Bark
 * app, for an owner whose own app cannot ship APNs.
 *
 * This is a second delivery channel next to Web Push (push.ts), nothing more.
 * What to notify, and when, is still decided by notifications.ts and the
 * supervisor inbox (quiet hours, digests); `deliverNotification` starts
 * `sendBarkNotification` without waiting for it.
 *
 * Settings live per person in their supervisor inbox document
 * (supervisor-inbox.ts, `bark`). The device key and the encryption key are
 * workspace secrets (workspace-secrets.ts): the document holds only refs, and
 * neither key is ever returned or logged.
 *
 * The server is the person's choice, so every send goes through
 * `pinnedFetch` (https only, public addresses only, no redirects), checked
 * again at send time and not only when saved.
 *
 * Without encryption Bark's server and APNs see the message, so kinds whose
 * row text people or agents wrote (mentions, comments, reminders, reviews)
 * travel as fixed generic copy with no subtitle; incident, support and
 * supervisor rows already push fixed copy (notifications.ts `pushFor`).
 * The subtitle is the row's project. Only a sealed push may carry the
 * event's `sealedMarkdown` (the digest's count per project, never titles).
 *
 * A supervisor push wears Blob's icon, sets the badge to the open needs-you
 * items, keeps its `ttl` to the item's expiry, rings on (`call`) only when
 * critical, and, with "speak" on, plays Blob reading its fixed copy
 * (bark-sound.ts). A row marked done is retracted (`retractBarkNotifications`,
 * from notifications.ts `markNotifications`).
 *
 * Encryption mirrors the Bark app at Finb/Bark@e681a1dc:
 * - Model/Algorithm.swift L24-33: AES128/192/256 take a key of 16/24/32
 *   characters; L108 uses the key's UTF-8 bytes (CryptoSwift `key.bytes`).
 * - L72: the IV is 16 characters for CBC and 12 for GCM, also as UTF-8
 *   bytes (L86, L90); CiphertextProcessor.swift L81-83: an `iv` sent with
 *   the push overrides the one saved in the app.
 * - L90: GCM is CryptoSwift `GCM(iv:, mode: .combined)`, the 16-byte tag
 *   appended to the ciphertext. Controller/CryptoSettingViewModel.swift
 *   L68-76 offers only `noPadding` for GCM and only `pkcs7` for CBC, and its
 *   GCM sample script (L140-148) is Node's aes-*-gcm with
 *   `Buffer.concat([encrypted, tag])`: exactly what `encryptForBark` does.
 * - L112/L119: the ciphertext is base64.
 * - CiphertextProcessor.swift L22-58, L103-116: the decrypted text is a
 *   JSON object whose keys (lowercased) replace the push's fields, so the
 *   whole message is sealed and sent as `ciphertext` with its `iv`.
 * ECB (no IV) is left out on purpose: it leaks repeated blocks.
 *
 * `id` and `delete`, checked against bark-server@a365aa9d and
 * Finb/Bark@9d006ab1:
 * - bark-server route_push.go L220-222 reads `id` in clear as the APNs
 *   collapse id (apns.go L143); the notification's identifier on the phone.
 * - CiphertextProcessor.swift L56-57 replaces the push's fields with the
 *   decrypted ones, so a sealed push repeats `id` inside the ciphertext:
 *   ArchiveProcessor.swift L29 and L50 file the history entry under it.
 * - apns.go L37-40 and L112-116: `delete` must be in clear, as it makes the
 *   server send a silent background push; AppDelegate.swift L108-122 then
 *   removes the notification and the history entry by the clear `id`. A
 *   retract therefore sends only the device key, `id` and `delete`, never
 *   anything sealed, and works the same with and without encryption.
 * - A silent push runs no notification extension, so it cannot set the
 *   badge (BadgeProcessor.swift): the badge is set by the next supervisor
 *   push, and Bark clears it when it opens (SceneDelegate.swift L50-51).
 */
import { createCipheriv, randomBytes, type CipherGCM } from "node:crypto";
import { configuredServer } from "./config";
import {
  hasFixedPush,
  pushSafeText,
  type NotificationDelivery,
  type NotificationEvent,
  type NotificationKind,
  type NotificationThread,
} from "./notification-threads";
import type { PushPayload } from "./push";
import { isBlockedAddress, isPrivateHostName } from "./shared/network-address";
import {
  BlockedAddressError,
  defaultPinnedFetchDeps,
  pinnedFetch,
  type PinnedFetchDeps,
} from "./shared/pinned-fetch";
import { BLOB_NOTIFICATION_ICON_PATH, isBlobActor } from "./session-actors";
import {
  readSupervisorBarkState,
  updateSupervisorBark,
} from "./supervisor-inbox";
import {
  deleteWorkspaceSecretAsync,
  putWorkspaceSecretAsync,
  resolveWorkspaceSecretAsync,
} from "./workspace-secrets";

export const BARK_DEFAULT_SERVER = "https://api.day.app";

/** Key length in characters per algorithm, as the Bark app checks it. */
export const BARK_ALGORITHMS = { AES128: 16, AES192: 24, AES256: 32 } as const;
export type BarkAlgorithm = keyof typeof BARK_ALGORITHMS;
export const BARK_MODES = ["GCM", "CBC"] as const;
export type BarkMode = (typeof BARK_MODES)[number];
/** IV length in characters per mode (Algorithm.swift L72). */
const IV_LENGTH: Record<BarkMode, number> = { CBC: 16, GCM: 12 };
/** Where a supervisor decision opens: the Blob app (`blob://`) or the web. */
export const BARK_OPEN_IN = ["blob", "web"] as const;
export type BarkOpenIn = (typeof BARK_OPEN_IN)[number];

export type BarkLevel = "critical" | "active" | "timeSensitive" | "passive";

export interface BarkEncryption {
  algorithm: BarkAlgorithm;
  mode: BarkMode;
  key: string;
}

/** What one Bark push says. Every value is a string, as Bark reads them. */
export interface BarkMessage {
  title: string;
  body: string;
  subtitle?: string;
  /** Shown instead of `body` (Bark ignores `body` when it is set); `body`
   *  stays as the fallback. */
  markdown?: string;
  level: BarkLevel;
  /** `"1"` rings for 30 seconds; only with `level: "critical"`. */
  call?: "1";
  group: string;
  url?: string;
  icon?: string;
  /** The app badge, set to this number. */
  badge?: string;
  /** Seconds Bark keeps the push in its history and Notification Center. */
  ttl?: string;
  /** A sound file to play (bark-sound.ts), with `sound` as its fallback. */
  soundUrl?: string;
  sound?: string;
  isArchive: "1";
}

interface BarkRecord {
  enabled: boolean;
  serverUrl: string;
  openIn: BarkOpenIn;
  /** Supervisor pushes play Blob reading their fixed copy (bark-sound.ts). */
  speak: boolean;
  deviceKeyRef?: string;
  /** The key's last four characters, so Settings can show which one. */
  deviceKeyHint?: string;
  encryption?: { algorithm: BarkAlgorithm; mode: BarkMode; keyRef: string };
  /** A saved encryption setting this version cannot use (a dropped mode):
   *  nothing is sent until it is saved again, never in clear instead. */
  encryptionUnusable?: { keyRef?: string };
}

/** Settings as clients see them: no key in clear. */
export interface BarkSettingsView {
  enabled: boolean;
  serverUrl: string;
  openIn: BarkOpenIn;
  speak: boolean;
  /** Whether this server can make the spoken sound at all (bark-sound.ts). */
  speakAvailable: boolean;
  /** Masked, e.g. `••••gRA4`; null when none is set. */
  deviceKey: string | null;
  encryption: { algorithm: BarkAlgorithm; mode: BarkMode } | null;
}

export interface BarkPatch {
  enabled?: boolean;
  serverUrl?: string;
  openIn?: BarkOpenIn;
  speak?: boolean;
  /** A new key; null removes it. */
  deviceKey?: string | null;
  /** New settings; `key` may be left out to keep the stored one when the
   *  algorithm is unchanged. null turns encryption off. */
  encryption?: {
    algorithm: BarkAlgorithm;
    mode: BarkMode;
    key?: string;
  } | null;
}

// ── Timing (tests shorten it) ───────────────────────────────────────────────

const timing = { timeoutMs: 10_000, retryDelaysMs: [1_000, 3_000] };
/** How a push reaches the server; tests answer without a network. */
let net: PinnedFetchDeps = defaultPinnedFetchDeps;

export function __setBarkTimingForTest(
  next: Partial<typeof timing>,
): () => void {
  const previous = { ...timing };
  Object.assign(timing, next);
  return () => Object.assign(timing, previous);
}

export function __setBarkNetForTest(
  next: Partial<PinnedFetchDeps>,
): () => void {
  const previous = net;
  net = { ...defaultPinnedFetchDeps, ...next };
  return () => {
    net = previous;
  };
}

// ── Cleaning and validation ─────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAlgorithm(value: unknown): value is BarkAlgorithm {
  return typeof value === "string" && Object.hasOwn(BARK_ALGORITHMS, value);
}

function isMode(value: unknown): value is BarkMode {
  return BARK_MODES.some((mode) => mode === value);
}

function isOpenIn(value: unknown): value is BarkOpenIn {
  return BARK_OPEN_IN.some((openIn) => openIn === value);
}

/** An https URL on a public host, without credentials, query or fragment,
 *  no trailing slash. A name is checked again against its addresses when a
 *  push is sent (`pinnedFetch`). */
export function cleanBarkServerUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (isPrivateHostName(url.hostname) || isBlockedAddress(url.hostname))
    return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function cleanRecord(value: unknown): BarkRecord {
  const record: BarkRecord = {
    enabled: false,
    serverUrl: BARK_DEFAULT_SERVER,
    openIn: "blob",
    speak: false,
  };
  if (!isRecord(value)) return record;
  record.enabled = value.enabled === true;
  record.speak = value.speak === true;
  // Kept as saved: a server that no longer passes is refused at send time,
  // never swapped for the default, which would get the device key.
  if (typeof value.serverUrl === "string" && value.serverUrl)
    record.serverUrl = value.serverUrl.slice(0, 500);
  if (isOpenIn(value.openIn)) record.openIn = value.openIn;
  if (typeof value.deviceKeyRef === "string" && value.deviceKeyRef) {
    record.deviceKeyRef = value.deviceKeyRef;
    if (typeof value.deviceKeyHint === "string")
      record.deviceKeyHint = value.deviceKeyHint.slice(-4);
  }
  const encryption = value.encryption;
  if (
    isRecord(encryption) &&
    isAlgorithm(encryption.algorithm) &&
    isMode(encryption.mode) &&
    typeof encryption.keyRef === "string" &&
    encryption.keyRef
  )
    record.encryption = {
      algorithm: encryption.algorithm,
      mode: encryption.mode,
      keyRef: encryption.keyRef,
    };
  else if (encryption !== undefined || isRecord(value.encryptionUnusable)) {
    const old = isRecord(encryption) ? encryption : value.encryptionUnusable;
    const keyRef = isRecord(old) ? old.keyRef : undefined;
    record.encryptionUnusable =
      typeof keyRef === "string" && keyRef ? { keyRef } : {};
  }
  if (!record.deviceKeyRef) record.enabled = false;
  return record;
}

function view(record: BarkRecord, speakAvailable: boolean): BarkSettingsView {
  return {
    enabled: record.enabled,
    serverUrl: record.serverUrl,
    openIn: record.openIn,
    speak: record.speak,
    speakAvailable,
    deviceKey: record.deviceKeyRef ? `••••${record.deviceKeyHint ?? ""}` : null,
    encryption: record.encryption
      ? {
          algorithm: record.encryption.algorithm,
          mode: record.encryption.mode,
        }
      : null,
  };
}

const DEVICE_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** Check a PUT body. Returns the patch or a message for the person. */
export function validateBarkPatch(
  body: Record<string, unknown>,
): BarkPatch | { error: string } {
  const patch: BarkPatch = {};
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean")
      return { error: "enabled must be true or false" };
    patch.enabled = body.enabled;
  }
  if ("serverUrl" in body) {
    if (typeof body.serverUrl !== "string")
      return { error: "serverUrl must be a string" };
    if (!body.serverUrl.trim()) patch.serverUrl = BARK_DEFAULT_SERVER;
    else {
      const url = cleanBarkServerUrl(body.serverUrl);
      if (!url)
        return {
          error:
            "The server must be a public https:// address, like https://api.day.app",
        };
      patch.serverUrl = url;
    }
  }
  if ("openIn" in body) {
    if (!isOpenIn(body.openIn)) return { error: "openIn must be blob or web" };
    patch.openIn = body.openIn;
  }
  if ("speak" in body) {
    if (typeof body.speak !== "boolean")
      return { error: "speak must be true or false" };
    patch.speak = body.speak;
  }
  if ("deviceKey" in body) {
    if (body.deviceKey === null || body.deviceKey === "")
      patch.deviceKey = null;
    else if (
      typeof body.deviceKey !== "string" ||
      !DEVICE_KEY.test(body.deviceKey.trim())
    )
      return {
        error:
          "That doesn't look like a Bark device key. Paste only the key, the part after api.day.app/.",
      };
    else patch.deviceKey = body.deviceKey.trim();
  }
  if ("encryption" in body) {
    const encryption = body.encryption;
    if (encryption === null) patch.encryption = null;
    else if (!isRecord(encryption))
      return { error: "encryption must be an object or null" };
    else {
      if (!isAlgorithm(encryption.algorithm))
        return { error: "Choose AES128, AES192 or AES256" };
      if (!isMode(encryption.mode)) return { error: "Choose GCM or CBC" };
      const next: NonNullable<BarkPatch["encryption"]> = {
        algorithm: encryption.algorithm,
        mode: encryption.mode,
      };
      if (encryption.key !== undefined && encryption.key !== "") {
        const length = BARK_ALGORITHMS[encryption.algorithm];
        if (
          typeof encryption.key !== "string" ||
          encryption.key.length !== length ||
          !PRINTABLE_ASCII.test(encryption.key)
        )
          return {
            error: `The ${encryption.algorithm} key must be exactly ${length} characters, letters, digits or symbols, no spaces`,
          };
        next.key = encryption.key;
      }
      patch.encryption = next;
    }
  }
  return patch;
}

// ── Settings ────────────────────────────────────────────────────────────────

async function speakAvailable(): Promise<boolean> {
  try {
    return await (await import("./bark-sound")).barkSoundAvailable();
  } catch {
    return false;
  }
}

export async function getBarkSettings(user: string): Promise<BarkSettingsView> {
  const [{ bark }, available] = await Promise.all([
    readSupervisorBarkState(user),
    speakAvailable(),
  ]);
  return view(cleanRecord(bark), available);
}

function refsOf(record: BarkRecord): string[] {
  return [
    record.deviceKeyRef,
    record.encryption?.keyRef,
    record.encryptionUnusable?.keyRef,
  ].filter((ref): ref is string => Boolean(ref));
}

/**
 * Apply a checked patch. New keys go under new secret refs before the
 * commit, so the record never points at a missing secret; refs the commit
 * replaced are deleted after it, and a failed commit deletes the new ones.
 */
export async function setBarkSettings(
  user: string,
  patch: BarkPatch,
): Promise<
  { ok: true; settings: BarkSettingsView } | { ok: false; error: string }
> {
  const created: string[] = [];
  let deviceKeyRef: string | undefined;
  let encryptionKeyRef: string | undefined;
  try {
    if (patch.deviceKey) {
      deviceKeyRef = await putWorkspaceSecretAsync(
        `Bark device key for ${user}`,
        patch.deviceKey,
      );
      created.push(deviceKeyRef);
    }
    if (patch.encryption?.key) {
      encryptionKeyRef = await putWorkspaceSecretAsync(
        `Bark encryption key for ${user}`,
        patch.encryption.key,
      );
      created.push(encryptionKeyRef);
    }
  } catch (error) {
    await Promise.allSettled(created.map(deleteWorkspaceSecretAsync));
    throw error;
  }

  // Written by the mutator, which may rerun on a conflict.
  const outcome: { error?: string; retired: string[]; record?: BarkRecord } = {
    retired: [],
  };
  try {
    await updateSupervisorBark(user, (raw) => {
      outcome.error = undefined;
      outcome.retired = [];
      const current = cleanRecord(raw);
      const next: BarkRecord = { ...current };
      if (patch.serverUrl !== undefined) next.serverUrl = patch.serverUrl;
      if (patch.openIn !== undefined) next.openIn = patch.openIn;
      if (patch.speak !== undefined) next.speak = patch.speak;
      if (patch.deviceKey === null) {
        delete next.deviceKeyRef;
        delete next.deviceKeyHint;
      } else if (patch.deviceKey && deviceKeyRef) {
        next.deviceKeyRef = deviceKeyRef;
        next.deviceKeyHint = patch.deviceKey.slice(-4);
      }
      if (patch.encryption !== undefined) delete next.encryptionUnusable;
      if (patch.encryption === null) delete next.encryption;
      else if (patch.encryption) {
        const { algorithm, mode } = patch.encryption;
        const keyRef =
          encryptionKeyRef ??
          (current.encryption?.algorithm === algorithm
            ? current.encryption.keyRef
            : undefined);
        if (!keyRef) {
          outcome.error = `Enter a ${BARK_ALGORITHMS[algorithm]} character ${algorithm} key`;
          return raw;
        }
        next.encryption = { algorithm, mode, keyRef };
      }
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      // The first key turns Bark on: a key alone is what the owner meant.
      // Replacing a key keeps the current state.
      else if (patch.deviceKey && !current.deviceKeyRef) next.enabled = true;
      if (!next.deviceKeyRef) {
        if (patch.enabled === true) {
          outcome.error = "Add your Bark device key first";
          return raw;
        }
        next.enabled = false;
      }
      const kept = new Set(refsOf(next));
      outcome.retired = refsOf(current).filter((ref) => !kept.has(ref));
      outcome.record = next;
      return { ...next };
    });
  } catch (error) {
    await Promise.allSettled(created.map(deleteWorkspaceSecretAsync));
    throw error;
  }
  if (outcome.error || !outcome.record) {
    await Promise.allSettled(created.map(deleteWorkspaceSecretAsync));
    return { ok: false, error: outcome.error ?? "Couldn't save Bark settings" };
  }
  const results = await Promise.allSettled(
    outcome.retired.map(deleteWorkspaceSecretAsync),
  );
  if (results.some((result) => result.status === "rejected"))
    console.warn("[bark] could not delete a replaced key");
  return {
    ok: true,
    settings: view(outcome.record, await speakAvailable()),
  };
}

// ── Messages ────────────────────────────────────────────────────────────────

/** The instance's public web origin (and path prefix), no trailing slash. */
function publicBase(): string {
  return configuredServer().publicBaseUrl.replace(/\/+$/, "");
}

/** The push's icon, when the instance is reachable over https: Blob's for
 *  a push from Blob, the instance's for anything else. */
function iconUrl(base: string, blob = false): string | undefined {
  if (!base.startsWith("https://")) return undefined;
  return blob
    ? `${base}${BLOB_NOTIFICATION_ICON_PATH}`
    : `${base}/apple-touch-icon.png`;
}

function absoluteUrl(
  base: string,
  path: string | undefined,
): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** How loudly a push lands, from the event's push urgency: high is time
 *  sensitive (critical only for a supervisor item about something down),
 *  low is passive, anything else active. An in-place update is passive. */
export function barkLevel(
  thread: Pick<NotificationThread, "kind">,
  event: Pick<NotificationEvent, "push">,
  delivery: Exclude<NotificationDelivery, "quiet">,
): BarkLevel {
  if (delivery === "replace") return "passive";
  const urgency = event.push?.urgency;
  if (urgency === "high")
    return thread.kind === "supervisor_needs_you"
      ? "critical"
      : "timeSensitive";
  if (urgency === "low") return "passive";
  return "active";
}

/** The fixed title a kind without fixed push copy gets when the push goes
 *  in clear: it names the kind, never the subject. */
const GENERIC_TITLE: Partial<Record<NotificationKind, string>> = {
  review_requested: "Review requested",
  team_review_requested: "Review requested",
  review_done: "Review finished",
  mention: "New mention",
  collaborator: "Added to a session",
  reminder: "Reminder",
  comment: "New comment",
  access_failing: "Access needs fixing",
};
export const BARK_GENERIC_BODY = "Open Sessions to see it";

/** Bounds on `ttl`: long enough to be seen, never past Bark's own month. */
const TTL_MIN_SECONDS = 60;
const TTL_MAX_SECONDS = 30 * 24 * 60 * 60;
/** Longest `markdown` sent; the sealed payload must fit APNs' 4 KB. */
const MARKDOWN_MAX = 1000;
/** The ringtone a spoken push falls back to when its sound can't load. */
export const BARK_FALLBACK_SOUND = "minuet";

/** Seconds from `now` until `expiresAt`, within the bounds above. */
export function barkTtl(expiresAt: number, now: number): string {
  const seconds = Math.round((expiresAt - now) / 1000);
  return String(Math.min(TTL_MAX_SECONDS, Math.max(TTL_MIN_SECONDS, seconds)));
}

/** Text that actually uses Markdown: emphasis, code, a link or a list. */
function hasMarkdown(text: string): boolean {
  return /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|^\s*(?:[-*+]|\d+\.)\s/m.test(
    text,
  );
}

export interface BarkMessageOptions {
  sealed: boolean;
  openIn?: BarkOpenIn;
  base?: string;
  now?: number;
  /** Open needs-you items: the app badge on a supervisor push. */
  badge?: number;
  /** Blob reading the push aloud (bark-sound.ts). */
  soundUrl?: string;
}

/**
 * The Bark message for a notification, from the Web Push payload `pushFor`
 * built. Sent in clear, a kind without fixed push copy says only its kind,
 * with no subtitle. A supervisor decision opens the item in Blob when the
 * person chose that; anything else opens its web page. A push from the
 * supervisor wears Blob's icon and sets the badge to the open needs-you
 * items; a count of 0 is left out, as Bark's 0 also clears its Notification
 * Center, this push included.
 */
export function barkMessageFor(
  thread: NotificationThread,
  event: NotificationEvent,
  delivery: Exclude<NotificationDelivery, "quiet">,
  payload: PushPayload,
  options: BarkMessageOptions,
): BarkMessage {
  const base = options.base ?? publicBase();
  const fixed = hasFixedPush(thread.subject.type);
  const plain = !options.sealed && !fixed;
  const url =
    thread.kind === "supervisor_needs_you" &&
    (options.openIn ?? "blob") === "blob"
      ? `blob://item/${encodeURIComponent(thread.subject.id)}`
      : absoluteUrl(base, thread.url);
  const supervisor = thread.subject.type === "supervisor";
  const icon = iconUrl(base, supervisor || isBlobActor(thread.actor));
  const level = barkLevel(thread, event, delivery);
  const subtitle = plain ? "" : pushSafeText(thread.subject.context ?? "");
  const expiresAt = fixed ? event.push?.expiresAt : undefined;
  // Agent text a sealed push may list; only when it is Markdown at all.
  const sealedMarkdown =
    options.sealed && fixed ? event.push?.sealedMarkdown?.trim() : undefined;
  const markdown =
    sealedMarkdown && hasMarkdown(sealedMarkdown)
      ? sealedMarkdown.slice(0, MARKDOWN_MAX)
      : undefined;
  return {
    title: plain
      ? (GENERIC_TITLE[thread.kind] ?? "New notification")
      : payload.title,
    ...(subtitle ? { subtitle } : {}),
    body: plain ? BARK_GENERIC_BODY : (payload.body ?? ""),
    ...(markdown ? { markdown } : {}),
    level,
    ...(level === "critical" ? { call: "1" as const } : {}),
    group: (!plain && subtitle) || (supervisor ? "Blob" : "Sessions"),
    ...(url ? { url } : {}),
    ...(icon ? { icon } : {}),
    ...(supervisor && options.badge
      ? { badge: String(Math.max(0, Math.floor(options.badge))) }
      : {}),
    ...(expiresAt !== undefined
      ? { ttl: barkTtl(expiresAt, options.now ?? Date.now()) }
      : {}),
    ...(options.soundUrl
      ? { soundUrl: options.soundUrl, sound: BARK_FALLBACK_SOUND }
      : {}),
    isArchive: "1",
  };
}

/** A random IV of `length` ASCII characters (Bark reads the IV's bytes). */
function randomIv(length: number): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

/** Encrypt as the Bark app decrypts (see the file header): base64
 *  ciphertext; CBC with pkcs7 padding; GCM unpadded with its 16-byte tag
 *  appended. */
export function encryptForBark(
  plaintext: string,
  encryption: BarkEncryption,
  iv = randomIv(IV_LENGTH[encryption.mode]),
): { ciphertext: string; iv: string } {
  const key = Buffer.from(encryption.key, "utf8");
  if (key.length !== BARK_ALGORITHMS[encryption.algorithm])
    throw new Error("Bark encryption key has the wrong length");
  const ivBytes = Buffer.from(iv, "utf8");
  if (ivBytes.length !== IV_LENGTH[encryption.mode])
    throw new Error("Bark IV has the wrong length");
  const bits = key.length * 8;
  const mode = encryption.mode.toLowerCase();
  // Node pads CBC with pkcs7 and never pads GCM, as Bark expects.
  const cipher = createCipheriv(`aes-${bits}-${mode}`, key, ivBytes);
  const parts = [cipher.update(plaintext, "utf8"), cipher.final()];
  if (encryption.mode === "GCM") parts.push((cipher as CipherGCM).getAuthTag());
  return { ciphertext: Buffer.concat(parts).toString("base64"), iv };
}

/**
 * The JSON body for `POST <server>/push`. With encryption the whole message
 * travels as `ciphertext` + `iv`; only the device key and the collapse id,
 * a hash, stay in clear. The id is sealed in as well: the app files the
 * history entry under the decrypted fields (see the file header).
 */
export function barkRequestBody(
  deviceKey: string,
  message: BarkMessage,
  options: { encryption?: BarkEncryption; collapseId?: string } = {},
): Record<string, string> {
  const body: Record<string, string> = { device_key: deviceKey };
  if (options.encryption) {
    const sealed = encryptForBark(
      JSON.stringify(
        options.collapseId ? { ...message, id: options.collapseId } : message,
      ),
      options.encryption,
    );
    body.ciphertext = sealed.ciphertext;
    body.iv = sealed.iv;
  } else
    for (const [key, value] of Object.entries(message))
      if (typeof value === "string") body[key] = value;
  if (options.collapseId) body.id = options.collapseId;
  return body;
}

/** The body that retracts the push filed under `collapseId`: always in
 *  clear, encrypted or not, as bark-server must see `delete` to send it as
 *  a silent push (see the file header). Says nothing but the hash. */
export function barkDeleteBody(
  deviceKey: string,
  collapseId: string,
): Record<string, string> {
  return { device_key: deviceKey, id: collapseId, delete: "1" };
}

// ── Sending ─────────────────────────────────────────────────────────────────

interface BarkTarget {
  serverUrl: string;
  deviceKey: string;
  openIn: BarkOpenIn;
  speak: boolean;
  /** Open needs-you items when the settings were read. */
  openNeedsYou: number;
  encryption?: BarkEncryption;
}

async function barkTarget(
  user: string,
  { requireEnabled }: { requireEnabled: boolean },
): Promise<BarkTarget | null> {
  const state = await readSupervisorBarkState(user);
  const record = cleanRecord(state.bark);
  if (!record.deviceKeyRef || (requireEnabled && !record.enabled)) return null;
  // Never fall back to sending in clear what was meant to be sealed.
  if (record.encryptionUnusable) {
    console.warn("[bark] the saved encryption setting is no longer supported");
    return null;
  }
  const serverUrl = cleanBarkServerUrl(record.serverUrl);
  if (!serverUrl) {
    console.warn("[bark] the saved server is not a public https address");
    return null;
  }
  const deviceKey = await resolveWorkspaceSecretAsync(record.deviceKeyRef);
  if (!deviceKey) {
    console.warn("[bark] the saved device key is missing");
    return null;
  }
  let encryption: BarkEncryption | undefined;
  if (record.encryption) {
    const key = await resolveWorkspaceSecretAsync(record.encryption.keyRef);
    if (!key) {
      console.warn("[bark] the saved encryption key is missing");
      return null;
    }
    encryption = {
      algorithm: record.encryption.algorithm,
      mode: record.encryption.mode,
      key,
    };
  }
  return {
    serverUrl,
    deviceKey,
    openIn: record.openIn,
    speak: record.speak,
    openNeedsYou: state.openNeedsYou,
    ...(encryption ? { encryption } : {}),
  };
}

export type BarkSendResult =
  | { ok: true }
  /** `setup`: nothing was sent, the settings are incomplete. */
  | { ok: false; error: string; setup?: true };

/** Errors raised before the request could reach the server, so a retry
 *  cannot deliver the push twice. A timeout or a reset might have. */
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function connectError(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_CONNECTED.has(code);
}

/** POST one push, with a timeout per attempt. Retries only what cannot have
 *  been delivered (no connection) or the server asked to (429, 5xx); never
 *  after a timeout. Logs status codes only, never the key. */
async function postBark(
  target: BarkTarget,
  message: BarkMessage,
  collapseId?: string,
): Promise<BarkSendResult> {
  return postBarkBody(
    target,
    barkRequestBody(target.deviceKey, message, {
      ...(target.encryption ? { encryption: target.encryption } : {}),
      ...(collapseId ? { collapseId } : {}),
    }),
  );
}

async function postBarkBody(
  target: BarkTarget,
  fields: Record<string, string>,
): Promise<BarkSendResult> {
  const body = JSON.stringify(fields);
  const attempts = timing.retryDelaysMs.length + 1;
  let error = "Bark did not answer";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, timing.retryDelaysMs[attempt - 1]),
      );
    try {
      const response = await pinnedFetch(
        `${target.serverUrl}/push`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body,
          signal: AbortSignal.timeout(timing.timeoutMs),
          redirect: "error",
        },
        net,
      );
      if (response.ok) return { ok: true };
      error = `Bark answered ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (cause) {
      if (cause instanceof BlockedAddressError) {
        error = "The Bark server is not a public address";
        break;
      }
      if (!connectError(cause)) {
        error =
          cause instanceof Error && cause.name === "TimeoutError"
            ? "Bark timed out"
            : "Couldn't reach the Bark server";
        break;
      }
      error = "Couldn't reach the Bark server";
    }
  }
  console.warn(`[bark] push failed: ${error}`);
  return { ok: false, error };
}

/**
 * Deliver a notification to the person's iPhone through Bark, when they set
 * it up and turned it on. Best-effort: never throws, so callers start it
 * without waiting.
 */
export async function sendBarkNotification(
  user: string,
  thread: NotificationThread,
  event: NotificationEvent,
  delivery: Exclude<NotificationDelivery, "quiet">,
  payload: PushPayload,
  collapseId?: string,
): Promise<void> {
  try {
    const target = await barkTarget(user, { requireEnabled: true });
    if (!target) return;
    const base = publicBase();
    const soundUrl =
      target.speak && delivery === "alert"
        ? await spokenSoundUrl(thread, event, base)
        : undefined;
    await postBark(
      target,
      barkMessageFor(thread, event, delivery, payload, {
        sealed: Boolean(target.encryption),
        openIn: target.openIn,
        base,
        badge: target.openNeedsYou,
        ...(soundUrl ? { soundUrl } : {}),
      }),
      collapseId,
    );
  } catch (error) {
    console.warn(
      "[bark] push failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

/** Kinds Blob may read aloud: their push says only fixed copy. */
const SPOKEN_KINDS = new Set<NotificationKind>([
  "supervisor_needs_you",
  "supervisor_digest",
]);
const SPOKEN_MAX = 200;

/** What Blob says for a push, or nothing: only a supervisor kind with fixed
 *  wording (its reason and the event's fixed push body), never the row. */
export function barkSpokenText(
  thread: Pick<NotificationThread, "kind" | "reason" | "subject">,
  event: Pick<NotificationEvent, "push">,
): string | undefined {
  if (!SPOKEN_KINDS.has(thread.kind) || thread.subject.type !== "supervisor")
    return undefined;
  const body = event.push?.body;
  if (!body) return undefined;
  const text = pushSafeText(`${thread.reason}. ${body}`);
  return text.slice(0, SPOKEN_MAX);
}

/** The spoken sound's URL, when the push may speak and the server can make
 *  it. Never throws and never waits for the audio itself. */
async function spokenSoundUrl(
  thread: NotificationThread,
  event: NotificationEvent,
  base: string,
): Promise<string | undefined> {
  const text = barkSpokenText(thread, event);
  if (!text || !base.startsWith("https://")) return undefined;
  try {
    return await (await import("./bark-sound")).barkSoundUrl(text, base);
  } catch {
    return undefined;
  }
}

/** Most pushes one mark retracts: marking everything done never turns into
 *  a burst of hundreds of requests. */
export const BARK_RETRACT_MAX = 20;

/**
 * Take the pushes filed under these collapse ids off the person's iPhone
 * (Notification Center and Bark's history), when Bark is on. Best-effort:
 * never throws, so callers start it without waiting. Needs Background App
 * Refresh on for Bark, as the command is a silent push.
 */
export async function retractBarkNotifications(
  user: string,
  collapseIds: string[],
): Promise<void> {
  try {
    const ids = [...new Set(collapseIds)].slice(0, BARK_RETRACT_MAX);
    if (!ids.length) return;
    const target = await barkTarget(user, { requireEnabled: true });
    if (!target) return;
    for (const id of ids)
      await postBarkBody(target, barkDeleteBody(target.deviceKey, id));
  } catch (error) {
    console.warn(
      "[bark] retract failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

export const BARK_TEST_MESSAGE = {
  title: "Bark works",
  body: "Pushes from this server will arrive here.",
} as const;

/** Send the fixed test push, whether or not Bark is turned on yet. */
export async function sendBarkTest(user: string): Promise<BarkSendResult> {
  const target = await barkTarget(user, { requireEnabled: false });
  if (!target)
    return {
      ok: false,
      error: "Add your Bark device key and a public https server first",
      setup: true,
    };
  const icon = iconUrl(publicBase());
  return postBark(target, {
    ...BARK_TEST_MESSAGE,
    level: "active",
    group: "Sessions",
    ...(icon ? { icon } : {}),
    isArchive: "1",
  });
}
