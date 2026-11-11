import { z } from "zod";
import { request } from "./request";

// Wire model of the server's Bark settings (src/server/bark.ts). The device
// key and the encryption key never come back: `deviceKey` is masked. The
// server reads the person from the sign-in, never from the request.

export const BARK_ALGORITHMS = ["AES128", "AES192", "AES256"] as const;
export const BARK_MODES = ["GCM", "CBC"] as const;
export const BARK_OPEN_IN = ["blob", "web"] as const;
export type BarkAlgorithm = (typeof BARK_ALGORITHMS)[number];
export type BarkMode = (typeof BARK_MODES)[number];
export type BarkOpenIn = (typeof BARK_OPEN_IN)[number];

/** Key length in characters, as the Bark app checks it. */
export const BARK_KEY_LENGTH: Record<BarkAlgorithm, number> = {
  AES128: 16,
  AES192: 24,
  AES256: 32,
};

export const barkSettingsSchema = z.object({
  enabled: z.boolean(),
  serverUrl: z.string(),
  openIn: z.enum(BARK_OPEN_IN),
  speak: z.boolean().default(false),
  /** Whether the server can make Blob's spoken sound (ffmpeg, Fish key). */
  speakAvailable: z.boolean().default(false),
  deviceKey: z.string().nullable(),
  encryption: z
    .object({ algorithm: z.enum(BARK_ALGORITHMS), mode: z.enum(BARK_MODES) })
    .nullable(),
});
export type BarkSettings = z.infer<typeof barkSettingsSchema>;

export interface BarkPatch {
  enabled?: boolean;
  serverUrl?: string;
  openIn?: BarkOpenIn;
  speak?: boolean;
  deviceKey?: string | null;
  encryption?: {
    algorithm: BarkAlgorithm;
    mode: BarkMode;
    key?: string;
  } | null;
}

const responseSchema = z.object({ bark: barkSettingsSchema });

export async function fetchBarkSettings(): Promise<BarkSettings> {
  return responseSchema.parse(
    await request<unknown>("/supervisor/bark", {
      label: "Couldn't load Bark settings",
    }),
  ).bark;
}

export async function saveBarkSettings(
  patch: BarkPatch,
): Promise<BarkSettings> {
  return responseSchema.parse(
    await request<unknown>("/supervisor/bark", {
      method: "PUT",
      body: patch,
      label: "Couldn't save Bark settings",
    }),
  ).bark;
}

export async function sendBarkTest(): Promise<void> {
  await request<unknown>("/supervisor/bark/test", {
    method: "POST",
    body: {},
    label: "Couldn't send the test",
  });
}
