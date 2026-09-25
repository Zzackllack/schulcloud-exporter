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
  sender_name: string;
  sender_avatar: string | null;
  text: string | null;
  created_at: string | null;
  decryption_state: string;
  files: ArchiveFile[];
}

export interface MessagePage {
  messages: Message[];
}
