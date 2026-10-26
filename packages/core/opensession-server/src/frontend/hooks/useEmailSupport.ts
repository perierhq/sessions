import useSWR from "swr";
import { apiSWRKey } from "../lib/api-swr";
import { fetchInboxes } from "../lib/api/support";

/** Whether email support is on for this server: the Inboxes page's own
 *  request (same key), so every surface asking shares one answer. False
 *  until it arrives. */
export function useEmailSupport(): boolean {
  const { data } = useSWR(apiSWRKey.supportInboxes(), fetchInboxes);
  return data?.enabled === true;
}
