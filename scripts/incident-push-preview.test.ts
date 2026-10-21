import { expect, test } from "bun:test";
import { INCIDENT_NOTIFICATION_KINDS } from "../packages/core/opensession-server/src/server/notification-threads";
import {
  parsePreviewArgs,
  previewNotifications,
} from "./incident-push-preview";

test("one preview per kind, with the design's veto text, aimed at the given incident", () => {
  const events = previewNotifications(
    "inc-9",
    Date.parse("2026-10-20T10:31:00Z"),
  );
  expect(events.map((e) => e.kind).sort()).toEqual(
    [...INCIDENT_NOTIFICATION_KINDS].sort(),
  );
  expect(
    events.every(
      (e) => e.subject.id === "inc-9" && e.url === "/incidents/inc-9",
    ),
  ).toBe(true);
  expect(events.find((e) => e.kind === "incident_veto")).toMatchObject({
    reason: "Search is down",
    body: expect.stringMatching(
      /^The fix is verified and deploys at \d\d:\d\d unless you stop it$/,
    ),
    push: {
      actions: [
        { action: "stop", url: "/incidents/inc-9?intent=stop" },
        { action: "deploy-now", url: "/incidents/inc-9?intent=deploy-now" },
        { action: "open", url: "/incidents/inc-9" },
      ],
    },
  });
  expect(events.every((e) => e.subject.context === "acme")).toBe(true);
});

test("the CLI needs a person and an incident, and a known kind", () => {
  expect(parsePreviewArgs(["--user", "Ada", "--incident", "inc-9"])).toEqual({
    user: "Ada",
    incident: "inc-9",
  });
  expect(
    parsePreviewArgs([
      "--user",
      "Ada",
      "--incident",
      "inc-9",
      "--kind",
      "incident_veto",
    ]),
  ).toEqual({ user: "Ada", incident: "inc-9", kind: "incident_veto" });
  expect(parsePreviewArgs(["--user", "Ada"])).toBeNull();
  expect(parsePreviewArgs(["--incident", "inc-9"])).toBeNull();
  expect(
    parsePreviewArgs(["--user", "Ada", "--incident", "inc-9", "--kind", "x"]),
  ).toBeNull();
});
