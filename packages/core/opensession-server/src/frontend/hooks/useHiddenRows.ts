import { useEffect, useState } from "react";
import { fetchHiddenRows, type HiddenRow } from "../lib/api";
import { hiddenRowKeys } from "../lib/hidden-list";

/**
 * The server's names for the rows behind your hides. The request carries the
 * keys this client holds, so a hide just made is named even while its write is
 * still on the way to the server. Refetched when the set of hidden row keys
 * changes, and on demand (opening the list), so work archived since the last
 * fetch drops out before you see it. A failed fetch keeps the last answer: the
 * list is a convenience, not something to raise an error over.
 */
export function useHiddenRows(hides: Record<string, string>, user: string) {
  const [rows, setRows] = useState<HiddenRow[]>([]);
  const [revision, setRevision] = useState(0);
  const signature = hiddenRowKeys(hides).join("\n");
  useEffect(() => {
    // Nothing hidden: hiddenListEntries drops whatever is left over, so
    // there is nothing to ask for.
    if (!signature) return;
    // A response for a key set that has since changed is dropped: the newer
    // request answers for the newer keys.
    let live = true;
    fetchHiddenRows(user, signature.split("\n"))
      .then((next) => {
        if (live) setRows(next.rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [signature, user, revision]);
  return { rows, refresh: () => setRevision((n) => n + 1) };
}
