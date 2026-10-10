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
  /** Link previews the API unfurled; empty when the message had none. */
  links: LinkPreview[];
  decryption_state: string;
  files: ArchiveFile[];
}

export interface MessagePage {
  messages: Message[];
}

export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
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

export interface ImportRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "complete" | "partial" | "failed" | "running";
  error: string | null;
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
  history?: ImportRun[];
}

export type StorageBackend = "file" | "s3";

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  /**
   * Always empty: the server sends `secretStored` instead, so a browser never
   * holds a secret access key and cannot forget to clear it.
   */
  secretAccessKey: string;
  prefix: string;
  /** Path-style URLs, which MinIO and the smaller providers require. */
  pathStyle: boolean;
}

export interface StorageTotals {
  count: number;
  bytes: number;
}

export interface StorageCounts {
  file: StorageTotals;
  s3: StorageTotals;
}

export type StorageJobStatus = "idle" | "running" | "complete" | "failed";

export interface StorageJob {
  status: StorageJobStatus;
  backend: StorageBackend | null;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  copied: number;
  alreadyThere: number;
  failures: { hash: string; error: string }[];
  current: string | null;
  error: string | null;
}

export interface StorageSettings {
  backend: StorageBackend;
  s3: S3Settings;
  secretStored: boolean;
  /** Field paths pinned by the environment, e.g. `["s3.bucket"]`. */
  locked: string[];
  /** The archive directory, where settings.json sits beside the data. */
  directory: string;
  counts: StorageCounts;
  job: StorageJob;
  warning: string | null;
}
