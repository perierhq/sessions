// Whether a running turn's reply types out as the model writes it, or appears
// a block at a time as each block finishes.
//
// The server streams either way. This is a per-VIEWER choice, not a per-run
// one: several people can watch the same session, the frames cost nothing to
// drop, and it covers every engine rather than only the one whose runner has
// a kill switch. Off means the live bubble stays quiet and the transcript
// fills in from the durable entries, which land as each block completes.
//
// Default on. Each live block streams into its own row by blockId and is
// swapped for its durable row by the same id, so the text you are reading is
// never rewritten under you, and the transcript only follows while you are at
// the bottom (follow mode). An explicit "off", here or on another device,
// still wins: the server keeps it, and hydration brings it back.
//
// A makeUserPref instance, so the answer follows you across devices (see
// lib/user-pref).

import * as UserPref from "./user-pref";

const pref = UserPref.makeUserPref<boolean>({
  localKey: "opensession-live-typing",
  prefKey: "live-typing",
  changeEvent: "opensession-live-typing-changed",
  defaultValue: true,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getLiveTypingPref = pref.get;
export const setLiveTypingPref = pref.set;
export const onLiveTypingChanged = pref.onChanged;
