import { describe, expect, test } from "bun:test";
import {
  approvedCopy,
  selectionModel,
  suggestionBatch,
  type SuggestionBatchDeps,
  type SuggestionConfirm,
} from "./selection";

const A = "suggestions/export.md";
const B = "suggestions/billing.md";
const C = "suggestions/login.md";

describe("selectionModel", () => {
  test("toggles paths in list order and counts them", () => {
    const none = selectionModel([A, B, C]);
    expect(none.count).toBe(0);
    const two = none.toggle(C).toggle(A);
    expect(two.selected).toEqual([A, C]);
    expect(two.count).toBe(2);
    expect(two.has(A)).toBe(true);
    expect(two.has(B)).toBe(false);
    expect(two.toggle(A).selected).toEqual([C]);
    // The model is a value: toggling made new ones.
    expect(none.count).toBe(0);
  });

  test("select all, then select all again clears", () => {
    const all = selectionModel([A, B]).toggle(A).selectAll();
    expect(all.selected).toEqual([A, B]);
    expect(all.allSelected).toBe(true);
    expect(all.selectAll().count).toBe(0);
  });

  test("an empty list is never all selected", () => {
    const empty = selectionModel([]);
    expect(empty.allSelected).toBe(false);
    expect(empty.selectAll().count).toBe(0);
  });

  test("keeps only paths still listed, and ignores unknown ones", () => {
    const sel = selectionModel([A, C], [A, B, C]);
    expect(sel.selected).toEqual([A, C]);
    expect(sel.toggle(B).selected).toEqual([A, C]);
  });

  test("clear empties it and keeps the list", () => {
    const cleared = selectionModel([A, B]).selectAll().clear();
    expect(cleared.count).toBe(0);
    expect(cleared.paths).toEqual([A, B]);
  });
});

test("approvedCopy counts articles", () => {
  expect(approvedCopy(1)).toBe("Approved 1 article");
  expect(approvedCopy(3)).toBe("Approved 3 articles");
});

/** A batch with fakes that record every call. */
function harness(over: Partial<SuggestionBatchDeps> = {}) {
  const calls = {
    approve: [] as Array<{ paths: string[]; edits?: unknown }>,
    discard: [] as string[][],
    confirm: [] as SuggestionConfirm[],
    reload: 0,
    notify: [] as Array<{ message: string; error: boolean }>,
    selection: [] as string[][],
    busy: [] as boolean[],
  };
  const deps: SuggestionBatchDeps = {
    approve: async (paths, edits) => {
      calls.approve.push(edits ? { paths, edits } : { paths });
      return {
        approved: paths.map((p) => p.replace("suggestions/", "articles/")),
      };
    },
    discard: async (paths) => {
      calls.discard.push(paths);
    },
    confirm: (request) => {
      calls.confirm.push(request);
    },
    reload: async () => {
      calls.reload++;
    },
    notify: (message, error) => {
      calls.notify.push({ message, error });
    },
    onSelection: (next) => {
      calls.selection.push([...next.selected]);
    },
    onBusy: (busy) => {
      calls.busy.push(busy);
    },
    ...over,
  };
  return { calls, batch: suggestionBatch(deps) };
}

describe("suggestionBatch", () => {
  test("Approve sends both selected paths, reloads, then empties the selection", async () => {
    const { calls, batch } = harness();
    const sel = selectionModel([A, B, C]).toggle(A).toggle(B);
    await batch.approve(sel);
    expect(calls.approve).toEqual([{ paths: [A, B] }]);
    expect(calls.reload).toBe(1);
    expect(calls.selection).toEqual([[]]);
    expect(calls.notify).toEqual([
      { message: "Approved 2 articles", error: false },
    ]);
    expect(calls.busy).toEqual([true, false]);
  });

  test("Approve with nothing selected does nothing", async () => {
    const { calls, batch } = harness();
    await batch.approve(selectionModel([A]));
    expect(calls.approve).toEqual([]);
    expect(calls.reload).toBe(0);
  });

  test("a failed approve keeps the selection and says why", async () => {
    const { calls, batch } = harness({
      approve: async () => {
        throw new Error("Someone changed it");
      },
    });
    await batch.approve(selectionModel([A, B]).selectAll());
    expect(calls.selection).toEqual([]);
    expect(calls.reload).toBe(0);
    expect(calls.notify).toEqual([
      { message: "Someone changed it", error: true },
    ]);
    expect(calls.busy).toEqual([true, false]);
  });

  test("Discard asks first, and only discards once confirmed", async () => {
    const { calls, batch } = harness();
    const sel = selectionModel([A, B, C]).toggle(B).toggle(C);
    batch.discard(sel);
    expect(calls.discard).toEqual([]);
    expect(calls.confirm).toHaveLength(1);
    const ask = calls.confirm[0]!;
    expect(ask.title).toBe("Discard 2 suggestions?");
    expect(ask.confirmLabel).toBe("Discard");
    expect(ask.destructive).toBe(true);
    await ask.onConfirm();
    expect(calls.discard).toEqual([[B, C]]);
    expect(calls.reload).toBe(1);
    expect(calls.selection).toEqual([[]]);
    expect(calls.notify).toEqual([
      { message: "Discarded 2 suggestions", error: false },
    ]);
  });

  test("Discard of one says so in the singular", () => {
    const { calls, batch } = harness();
    batch.discard(selectionModel([A]).toggle(A));
    expect(calls.confirm[0]!.title).toBe("Discard this suggestion?");
  });

  test("a failed discard keeps the selection", async () => {
    const { calls, batch } = harness({
      discard: async () => {
        throw new Error("Couldn't discard");
      },
    });
    batch.discard(selectionModel([A]).toggle(A));
    await calls.confirm[0]!.onConfirm();
    expect(calls.selection).toEqual([]);
    expect(calls.notify).toEqual([
      { message: "Couldn't discard", error: true },
    ]);
  });

  test("approving one edited suggestion sends its edits", async () => {
    const { calls, batch } = harness();
    const edit = {
      fm: {
        title: "Exporting as CSV",
        kind: "answer" as const,
        trust: "reference" as const,
        status: "active" as const,
        validAsOf: "2026-10-20",
      },
      body: "Open Settings, then Export.",
    };
    const ok = await batch.approveEdited(A, edit);
    expect(ok).toBe(true);
    expect(calls.approve).toEqual([{ paths: [A], edits: { [A]: edit } }]);
    expect(calls.reload).toBe(1);
    expect(calls.notify).toEqual([
      { message: "Approved 1 article", error: false },
    ]);
  });

  test("a failed edited approve answers false", async () => {
    const { calls, batch } = harness({
      approve: async () => {
        throw new Error("Invalid edit");
      },
    });
    const ok = await batch.approveEdited(A, {
      fm: {
        title: "x",
        kind: "answer",
        trust: "reference",
        status: "active",
        validAsOf: "2026-10-20",
      },
      body: "",
    });
    expect(ok).toBe(false);
    expect(calls.notify).toEqual([{ message: "Invalid edit", error: true }]);
  });
});
