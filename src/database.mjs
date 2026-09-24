import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openArchive(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "archive.sqlite"), {
    timeout: 5000,
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS chats (
      type TEXT NOT NULL CHECK (type IN ('channel', 'conversation')),
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      company_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      encrypted INTEGER NOT NULL DEFAULT 0,
      avatar_hash TEXT,
      raw_json TEXT NOT NULL,
      import_state TEXT NOT NULL DEFAULT 'pending',
      import_error TEXT,
      imported_at TEXT,
      PRIMARY KEY (type, id)
    );
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_hash TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      text TEXT,
      created_at TEXT,
      kind TEXT,
      reply_to_id TEXT,
      decryption_state TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      FOREIGN KEY (chat_type, chat_id) REFERENCES chats(type, id),
      FOREIGN KEY (sender_id) REFERENCES people(id)
    );
    CREATE INDEX IF NOT EXISTS messages_chat_date
      ON messages(chat_type, chat_id, created_at, id);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT,
      size_bytes INTEGER,
      blob_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_files (
      message_id TEXT NOT NULL REFERENCES messages(id),
      file_id TEXT NOT NULL REFERENCES files(id),
      PRIMARY KEY (message_id, file_id)
    );
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      media_type TEXT
    );
    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function saveChat(db, type, chat, archived = false, ownId = null) {
  const id = String(chat.id);
  const title =
    type === "channel"
      ? chat.name || `Channel ${id}`
      : chat.name || conversationTitle(chat, ownId) || `Konversation ${id}`;
  db.prepare(
    `INSERT INTO chats
    (type, id, title, company_id, archived, encrypted, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, id) DO UPDATE SET
      title=excluded.title, company_id=excluded.company_id,
      archived=excluded.archived, encrypted=excluded.encrypted,
      raw_json=excluded.raw_json`,
  ).run(
    type,
    id,
    title,
    chat.company_id ? String(chat.company_id) : null,
    archived ? 1 : 0,
    chat.encrypted ? 1 : 0,
    JSON.stringify(chat),
  );
  return id;
}

function conversationTitle(chat, ownId) {
  if (!Array.isArray(chat.participants)) return "";
  const others = chat.participants.filter((entry) => {
    const user = entry.user || entry;
    return String(user.id || entry.user_id) !== String(ownId);
  });
  return (others.length ? others : chat.participants)
    .map((entry) => {
      const user = entry.user || entry;
      return (
        [user.first_name, user.last_name].filter(Boolean).join(" ") || user.name
      );
    })
    .filter(Boolean)
    .join(", ");
}

function messageDate(message) {
  if (message.micro_time) {
    const value = Number(message.micro_time);
    if (Number.isFinite(value)) return new Date(value / 1000).toISOString();
  }
  if (message.time) {
    const value = Number(message.time);
    if (Number.isFinite(value)) return new Date(value * 1000).toISOString();
  }
  const value = message.created_at || message.created;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

export function saveMessage(db, type, chatId, message) {
  const sender =
    typeof message.sender === "object" && message.sender
      ? message.sender
      : null;
  const senderId = sender?.id == null ? null : String(sender.id);
  if (senderId) {
    const displayName =
      sender.name ||
      [sender.first_name, sender.last_name].filter(Boolean).join(" ") ||
      `Nutzer ${senderId}`;
    db.prepare(
      `INSERT INTO people (id, display_name, raw_json)
      VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      display_name=excluded.display_name, raw_json=excluded.raw_json`,
    ).run(senderId, displayName, JSON.stringify(sender));
  }
  // The upstream client silently keeps ciphertext when decryption fails.
  const decryptionState = message.encrypted
    ? !message.text
      ? "empty"
      : message.original_text != null
        ? "decrypted"
        : "unverified"
    : "plain";
  db.prepare(
    `INSERT INTO messages
    (id, chat_type, chat_id, sender_id, text, created_at, kind,
     reply_to_id, decryption_state, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sender_id=excluded.sender_id, text=excluded.text,
      created_at=excluded.created_at, kind=excluded.kind,
      reply_to_id=excluded.reply_to_id,
      decryption_state=excluded.decryption_state,
      raw_json=excluded.raw_json`,
  ).run(
    String(message.id),
    type,
    chatId,
    senderId,
    message.text ?? null,
    messageDate(message),
    message.kind || message.type || "message",
    message.reply_to_id ? String(message.reply_to_id) : null,
    decryptionState,
    JSON.stringify(message),
  );
  for (const file of message.files || []) {
    if (file.id == null) continue;
    const fileId = String(file.id);
    db.prepare(
      `INSERT INTO files (id, name, mime, size_bytes, raw_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, mime=excluded.mime,
      size_bytes=excluded.size_bytes, raw_json=excluded.raw_json`,
    ).run(
      fileId,
      file.name || fileId,
      file.mime || null,
      Number(file.size_byte) || null,
      JSON.stringify(file),
    );
    db.prepare(
      `INSERT OR IGNORE INTO message_files (message_id, file_id)
      VALUES (?, ?)`,
    ).run(String(message.id), fileId);
  }
  return decryptionState;
}
