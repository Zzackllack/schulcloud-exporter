export type ChatType = "channel" | "conversation";

export interface Chat {
  type: ChatType;
  id: string;
  title: string;
  archived: number;
  encrypted: number;
  avatar_hash: string | null;
  import_state: string;
  import_error: string | null;
  message_count: number;
  latest_at: string | null;
}

export interface Summary {
  chats: number;
  messages: number;
  files: number;
  failed: number;
  ownUserId: string | null;
  lastRun: { status: string; finished_at: string | null } | null;
}

export interface Reaction {
  emoji: string;
  count: number;
}

export interface ArchiveFile {
  id: string;
  name: string;
  mime: string | null;
  blob_hash: string | null;
  status: string;
}

export interface Message {
  id: string;
  sender_id: string | null;
  /** Falls back to "Unbekannte Person" server-side; test sender_id instead. */
  sender_name: string;
  sender_avatar: string | null;
  /** The sender's account was deleted, so no name is recoverable. */
  sender_deleted: boolean;
  text: string | null;
  created_at: string | null;
  /** "message" for real posts, otherwise a system event like "joined". */
  kind: string;
  deleted: boolean;
  attachment_missing: boolean;
  /** Busiest first; empty when nobody reacted. */
  reactions: Reaction[];
  decryption_state: string;
  files: ArchiveFile[];
}

export interface MessagePage {
  messages: Message[];
}

export interface SearchHit {
  id: string;
  chat_type: ChatType;
  chat_id: string;
  chat_title: string;
  sender_name: string;
  created_at: string | null;
  kind: string;
  /** Match runs are wrapped in \u0001 / \u0002 sentinels, never HTML. */
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
}

export type ImportStatus =
  | "idle"
  | "running"
  | "complete"
  | "partial"
  | "failed";

export interface ImportChatRef {
  type: string;
  id: string;
  title?: string;
}

export interface ImportFeedLine {
  level: "info" | "error";
  message: string;
  at: string;
}

export interface ImportState {
  status: ImportStatus;
  running: boolean;
  hasEnvCredentials: boolean;
  credentialsInEnv?: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  chats: number;
  messages: number;
  files: number;
  errors: number;
  failedChats: number;
  failedFiles: number;
  current: ImportChatRef | null;
  error: string | null;
  feed: ImportFeedLine[];
}
