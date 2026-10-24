import { describe, expect, test } from "bun:test";
import type {
  ProjectSettingsPatch,
  ProjectSettingsView,
} from "../../../shared/project-settings";
import { READY_4_OF_6 } from "../../../shared/project-settings-fixtures";
import { ApiError } from "../api/request";
import { sendProjectPatch } from "./save";

const cell = {
  row: { kind: "connection" as const, server: "linear" },
  role: "reviews" as const,
  value: false,
};

function fresh(revision: number): ProjectSettingsView {
  return {
    ...READY_4_OF_6,
    document: { ...READY_4_OF_6.document, revision },
  };
}

describe("sendProjectPatch", () => {
  test("sends the loaded revision", async () => {
    const sent: ProjectSettingsPatch[] = [];
    const out = await sendProjectPatch({ access: { cells: [cell] } }, 4, {
      send: async (patch) => {
        sent.push(patch);
        return fresh(5);
      },
      refetch: async () => undefined,
      onStale: () => {},
    });
    expect(sent).toEqual([{ expectedRevision: 4, access: { cells: [cell] } }]);
    expect(out.document.revision).toBe(5);
  });

  test("a 409 refetches, re-sends the same change once and says so", async () => {
    const sent: ProjectSettingsPatch[] = [];
    let stale = 0;
    let refetched = 0;
    const out = await sendProjectPatch({ access: { cells: [cell] } }, 4, {
      send: async (patch) => {
        sent.push(patch);
        if (patch.expectedRevision === 4)
          throw new ApiError("Settings changed since you loaded them", 409);
        return fresh(7);
      },
      refetch: async () => {
        refetched++;
        return fresh(6);
      },
      onStale: () => stale++,
    });
    expect(stale).toBe(1);
    expect(refetched).toBe(1);
    expect(sent).toEqual([
      { expectedRevision: 4, access: { cells: [cell] } },
      { expectedRevision: 6, access: { cells: [cell] } },
    ]);
    expect(out.document.revision).toBe(7);
  });

  test("a second 409 rejects instead of looping", async () => {
    let sends = 0;
    const run = sendProjectPatch({ sandbox: "podman" }, 4, {
      send: async () => {
        sends++;
        throw new ApiError("stale", 409);
      },
      refetch: async () => fresh(6),
      onStale: () => {},
    });
    await expect(run).rejects.toThrow("stale");
    expect(sends).toBe(2);
  });

  test("other errors reject without a refetch", async () => {
    let refetched = 0;
    const run = sendProjectPatch({ sandbox: "podman" }, 4, {
      send: async () => {
        throw new ApiError("Only a signed-in person can change this", 403);
      },
      refetch: async () => {
        refetched++;
        return fresh(6);
      },
      onStale: () => {},
    });
    await expect(run).rejects.toThrow("signed-in");
    expect(refetched).toBe(0);
  });
});
