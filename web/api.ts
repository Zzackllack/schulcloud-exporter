import type { Chat, ChatType, Message, MessagePage, Summary } from "./types";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function loadArchive(signal: AbortSignal) {
  // The list and counters are independent; fetch them together.
  const [chats, summary] = await Promise.all([
    getJson<Chat[]>("/api/chats", signal),
    getJson<Summary>("/api/summary", signal),
  ]);
  return { chats, summary };
}

export function loadMessages(
  type: ChatType,
  id: string,
  cursor: Message | null,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) {
    params.set("before", cursor.created_at ?? "");
    params.set("before_id", cursor.id);
  }
  return getJson<MessagePage>(
    `/api/chats/${type}/${encodeURIComponent(id)}/messages?${params}`,
    signal,
  );
}

export function exportUrl(chat: Chat) {
  return `/api/chats/${chat.type}/${encodeURIComponent(chat.id)}/export`;
}
