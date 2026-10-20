import { useEffect, useState } from "react";
import { fetchHiddenRows, type HiddenRow } from "../lib/api";
import { hiddenRowsSignature } from "../lib/hidden-list";

/**
 * The server's names for the rows behind your hides. Refetched when the set of
 * hidden keys changes, and on demand (opening the list), so work archived since
 * the last fetch drops out before you see it. A failed fetch keeps the last
 * answer: the list is a convenience, not something to raise an error over.
 */
export function useHiddenRows(hides: Record<string, string>, user: string) {
  const [rows, setRows] = useState<HiddenRow[]>([]);
  const [revision, setRevision] = useState(0);
  const signature = hiddenRowsSignature(hides);
  useEffect(() => {
    // Nothing hidden: hiddenListEntries drops whatever is left over, so
    // there is nothing to ask for.
    if (!signature) return;
    let live = true;
    fetchHiddenRows(user)
      .then((next) => {
        if (live) setRows(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [signature, user, revision]);
  return { rows, refresh: () => setRevision((n) => n + 1) };
}
