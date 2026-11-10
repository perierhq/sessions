import { describe, expect, test } from "bun:test";
import { PINNED_ONLY_YOU } from "../../../shared/project-lead";
import { READY_4_OF_6 } from "../../../shared/project-settings-fixtures";
import { ApiError } from "../api/request";
import {
  applyLeadPatch,
  leadRuleRows,
  leadSaveErrorText,
  leadStageHelp,
  leadStatus,
} from "./lead-model";
import { STALE_SETTINGS_MESSAGE } from "./save";

const lead = READY_4_OF_6.document.lead;

describe("lead section model", () => {
  test("one rule row per category, pinned ones always only you", () => {
    const rows = leadRuleRows({
      ...lead,
      rules: { ...lead.rules, refund: "alone", "ci-repair": "asks-first" },
    });
    expect(rows).toHaveLength(14);
    const refund = rows.find((r) => r.category === "refund");
    expect(refund).toMatchObject({ level: "only-you", pinned: true });
    expect(rows.find((r) => r.category === "ci-repair")).toMatchObject({
      level: "asks-first",
      pinned: false,
      label: "CI repair",
    });
    expect(rows.filter((r) => r.pinned).map((r) => r.category)).toEqual([
      ...PINNED_ONLY_YOU,
    ]);
  });

  test("status: off, starting until the goal exists, then running", () => {
    expect(leadStatus({ ...lead, enabled: false, goalId: "g1" })).toBe("off");
    expect(leadStatus({ ...lead, enabled: true })).toBe("starting");
    expect(leadStatus({ ...lead, enabled: true, goalId: "g1" })).toBe(
      "running",
    );
  });

  test("stage help", () => {
    expect(leadStageHelp("watch")).toBe("Reads and proposes, changes nothing");
    expect(leadStageHelp("act")).toBe("Does what you allow without asking");
  });

  test("a patch paints over the stored lead without dropping rules", () => {
    const base = applyLeadPatch(READY_4_OF_6, { owner: "Ada" });
    const next = applyLeadPatch(base, {
      enabled: true,
      rules: { "ci-repair": "only-you" },
    });
    expect(next.document.lead.enabled).toBe(true);
    expect(next.document.lead.owner).toBe("Ada");
    expect(next.document.lead.rules["ci-repair"]).toBe("only-you");
    expect(next.document.lead.rules["fix-verified"]).toBe(
      lead.rules["fix-verified"],
    );
    expect(applyLeadPatch(next, { owner: null }).document.lead.owner).toBe(
      undefined,
    );
    expect(READY_4_OF_6.document.lead.owner).toBeUndefined();
  });

  test("refusals keep the server's reason", () => {
    const reason =
      "Only the instance owner or the lead's owner can give the project lead more room";
    expect(leadSaveErrorText(new ApiError(reason, 403))).toBe(reason);
    expect(leadSaveErrorText(new ApiError("x", 409))).toBe(
      STALE_SETTINGS_MESSAGE,
    );
    expect(leadSaveErrorText(null)).toBe("Couldn't save the setting");
  });
});
