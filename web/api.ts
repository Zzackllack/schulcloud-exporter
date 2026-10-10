import type {
  Chat,
  ChatType,
  ImportState,
  Message,
  MessagePage,
  SearchResponse,
  StorageBackend,
  StorageJob,
  StorageSettings,
  Summary,
} from "./types";

export const MESSAGE_PAGE_SIZE = 100;

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
  const params = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
  if (cursor) {
    params.set("before", cursor.created_at ?? "");
    params.set("before_id", cursor.id);
  }
  return getJson<MessagePage>(
    `/api/chats/${type}/${encodeURIComponent(id)}/messages?${params}`,
    signal,
  );
}

export function loadMessagesAround(
  type: ChatType,
  id: string,
  date: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({ date });
  return getJson<MessagePage>(
    `/api/chats/${type}/${encodeURIComponent(id)}/around?${params}`,
    signal,
  );
}

export function searchMessages(query: string, signal: AbortSignal) {
  const params = new URLSearchParams({ q: query, limit: "50" });
  return getJson<SearchResponse>(`/api/search?${params}`, signal);
}

export function exportUrl(chat: Chat) {
  return `/api/chats/${chat.type}/${encodeURIComponent(chat.id)}/export`;
}

export interface ImportCredentials {
  email: string;
  password: string;
  securityPassword: string;
}

export async function loadImportState(signal?: AbortSignal) {
  return getJson<ImportState>("/api/import", signal);
}

export async function startImport(credentials?: Partial<ImportCredentials>) {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // An empty object means "use the environment credentials", which keeps
    // secrets out of the browser entirely.
    body: JSON.stringify(credentials ?? {}),
  });
  const data = (await response.json()) as ImportState & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/**
 * Subscribes to import progress. Returns an unsubscribe function.
 *
 * The server sends a `snapshot` before any deltas, so a reload or a
 * reconnect picks up an import that is already running. Only `snapshot` and
 * `progress` carry state -- the keepalive frames are deliberately ignored
 * rather than applied, since treating one as a state update would replace the
 * whole object with an empty shell.
 */
export function streamImport(onState: (state: ImportState) => void) {
  const source = new EventSource("/api/import/events");
  const apply = (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ImportState).status === "string" &&
      Array.isArray((parsed as ImportState).feed)
    ) {
      onState(parsed as ImportState);
    }
  };
  source.addEventListener("snapshot", apply);
  source.addEventListener("progress", apply);
  return () => source.close();
}

export interface StorageDraft {
  backend: StorageBackend;
  s3: Omit<StorageSettings["s3"], "secretAccessKey"> & { secretAccessKey?: string };
}

export async function loadStorageSettings(signal?: AbortSignal) {
  return getJson<StorageSettings>("/api/settings", signal);
}

/**
 * Validates and stores the draft, then returns what the server now runs with.
 *
 * The response is the source of truth, not the draft: the environment can
 * override a field, and a save that ignores that would leave the viewer
 * disagreeing with the server about where blobs go.
 */
export async function saveStorageSettings(draft: StorageDraft) {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  const data = (await response.json()) as StorageSettings & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/** Checks a bucket without saving it, so a typo is caught before it is used. */
export async function testStorageSettings(draft: StorageDraft) {
  const response = await fetch("/api/settings/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend: "s3", s3: draft.s3 }),
  });
  const data = (await response.json()) as { ok?: boolean; error?: string };
  if (data.ok) return { ok: true as const, error: "" };
  // A 400 is a validation failure and a 502 a provider refusal; both carry the
  // reason in the body, so the message matters more than the status.
  return { ok: false as const, error: data.error || `HTTP ${response.status}` };
}

export async function startStorageMigration(backend: StorageBackend) {
  const response = await fetch("/api/settings/migrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend }),
  });
  const data = (await response.json()) as StorageJob & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/**
 * Subscribes to migration progress. Returns an unsubscribe function.
 *
 * Same one-way shape as the import stream, including the snapshot first, so a
 * page reload during a copy shows where it stands instead of restarting it.
 */
export function streamStorage(onJob: (job: StorageJob) => void) {
  const source = new EventSource("/api/settings/events");
  const apply = (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StorageJob).status === "string"
    ) {
      onJob(parsed as StorageJob);
    }
  };
  source.addEventListener("snapshot", apply);
  source.addEventListener("progress", apply);
  return () => source.close();
}
