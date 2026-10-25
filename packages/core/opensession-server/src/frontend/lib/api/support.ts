import type {
  SupportChannelKind,
  SupportConversationView,
  SupportListItem,
} from "../../../shared/support";
import { request } from "./request";

export interface SupportItems {
  items: SupportListItem[];
  channels: Array<{
    channel: SupportChannelKind;
    label: string;
    error: string | null;
  }>;
}

/** The Support list across channels (email conversations and Plain's queue). */
export async function fetchSupportItems(): Promise<SupportItems> {
  const body = await request<SupportItems | null>("/support/conversations", {
    label: "Failed to load the support list",
  });
  return { items: body?.items ?? [], channels: body?.channels ?? [] };
}

/** One email conversation, by conversation id or list item id. */
export function fetchSupportConversation(
  id: string,
): Promise<SupportConversationView> {
  return request<SupportConversationView>(
    `/support/conversations/${encodeURIComponent(id)}`,
    { label: "Failed to load the conversation" },
  );
}
