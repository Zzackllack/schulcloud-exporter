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
      deleted TEXT,
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
      -- Timestamps the API scrubbed server-side; NULL means not deleted.
      deleted TEXT,
      -- The API advertised an attachment but shipped no file metadata.
      attachment_missing INTEGER NOT NULL DEFAULT 0,
      -- JSON array of {emoji, count}, busiest first. NULL when unreacted.
      reactions TEXT,
      -- JSON array of {url, title, description?}. NULL when no link previews.
      links TEXT,
      raw_json TEXT NOT NULL,
      FOREIGN KEY (chat_type, chat_id) REFERENCES chats(type, id),
      FOREIGN KEY (sender_id) REFERENCES people(id)
    );
    CREATE INDEX IF NOT EXISTS messages_chat_date
      ON messages(chat_type, chat_id, created_at, id);
    -- External-content FTS5 over messages.text, keyed on the implicit rowid.
    -- Search is the only way to find anything by what was said: with 10k
    -- messages and no index, "who mentioned the UNICEF run" is unanswerable.
    -- unicode61 folds accents, so "Ruckgabe" and "Ruckg" both find
    -- "Rückgabe". It does not expand to the German ue/oe/ss spelling, so
    -- "rueckgabe" finds nothing.
    -- The column must be named 'text' to match messages.text: an
    -- external-content FTS5 table reads its source column by name.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    -- Triggers keep the index in step with the upsert the importer does, so a
    -- re-import updates it without a separate pass.
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, coalesce(new.text, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text)
      VALUES ('delete', old.rowid, coalesce(old.text, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text)
      VALUES ('delete', old.rowid, coalesce(old.text, ''));
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, coalesce(new.text, ''));
    END;
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
  migrate(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS leaves an existing archive untouched, so columns
// added after a database was first created have to be applied separately.
function migrate(db) {
  const added = [];
  for (const [table, column, definition] of [
    ["people", "deleted", "TEXT"],
    ["messages", "deleted", "TEXT"],
    ["messages", "attachment_missing", "INTEGER NOT NULL DEFAULT 0"],
    ["messages", "reactions", "TEXT"],
    ["messages", "links", "TEXT"],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    added.push(`${table}.${column}`);
  }
  return added;
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

export function conversationTitle(chat, ownId) {
  // The API sends `members`; `participants` only exists in the client's own
  // types and never appears in a response, so it is kept as a fallback.
  const people = Array.isArray(chat.members)
    ? chat.members
    : Array.isArray(chat.participants)
      ? chat.participants
      : null;
  if (!people) return "";
  // `members` already omits the account owner, but `participants` may not.
  const others = people.filter((entry) => {
    const user = entry.user || entry;
    return String(user.id || entry.user_id) !== String(ownId);
  });
  return (others.length ? others : people)
    .map((entry) => {
      const user = entry.user || entry;
      // Deleted accounts come back with first_name/last_name scrubbed, so fall
      // back to the same "Nutzer <id>" label saveMessage uses for senders and
      // keep the title identical to what the message bubbles show.
      return (
        [user.first_name, user.last_name].filter(Boolean).join(" ") ||
        user.name ||
        (user.id ? `Nutzer ${user.id}` : "")
      );
    })
    .filter(Boolean)
    .join(", ");
}

// A school archive spans 2019 to today; anything outside this window means we
// misread the unit again and would rather store NULL than a wrong date.
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

export function messageDate(message) {
  const createdAt = message.created_at || message.created;
  if (typeof createdAt === "string" && createdAt.trim()) {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }

  // Despite the name (the upstream client documents it as "microsecond
  // precision"), stashcat's `micro_time` is unix *seconds* with a fractional
  // part: 1782042438.732 -> 2026-06-21T11:47:18.732Z. `time` is the same value
  // rounded to whole seconds. Treat both as seconds.
  for (const value of [message.micro_time, message.time]) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const ms = seconds * 1000;
    if (ms < MIN_PLAUSIBLE_MS || ms >= MAX_PLAUSIBLE_MS) continue;
    return new Date(ms).toISOString();
  }

  return null;
}

/**
 * Normalises the API's reaction buckets into {emoji, count}, busiest first.
 *
 * The wire format is [{emoji, num_reactions}]. Junk entries are dropped rather
 * than stored, since nothing renders a reaction it cannot count.
 */
export function normalizeReactions(value) {
  if (!Array.isArray(value)) return null;
  const merged = new Map();
  for (const entry of value) {
    const emoji = typeof entry?.emoji === "string" ? entry.emoji.trim() : "";
    const count = Number(entry?.num_reactions);
    if (!emoji || !Number.isFinite(count) || count <= 0) continue;
    merged.set(emoji, (merged.get(emoji) ?? 0) + Math.trunc(count));
  }
  if (!merged.size) return null;
  return [...merged.entries()]
    .map(([emoji, count]) => ({ emoji, count }))
    .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
}

/**
 * Rebuilds the full-text index from the messages table.
 *
 * Triggers keep it current for new writes, but an archive created before the
 * index existed has nothing indexed, and a rebuild is the only way to backfill
 * an external-content FTS table.
 */
export function rebuildSearchIndex(db) {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  return db.prepare("SELECT count(*) AS n FROM messages_fts").get().n;
}

/**
 * Normalises the API's unfurled link previews into {url, title, description}.
 *
 * These are rendered as clickable links, so the scheme is checked: an archive
 * of other people's messages must never be able to smuggle a `javascript:` href
 * into the viewer. Only http(s) survives.
 *
 * The preview image is deliberately dropped. All of them are remote, and the
 * viewer's CSP allows `img-src 'self' data:` only -- loading them would phone
 * out to third parties just to read a local archive, and would be blocked
 * anyway. provider/embedded/tags/time are of no use here either.
 */
export function normalizeLinks(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const links = [];
  for (const entry of value) {
    const raw = typeof entry?.url === "string" && entry.url
      ? entry.url
      : entry?.requested_url;
    if (typeof raw !== "string") continue;
    let parsed;
    try {
      parsed = new URL(raw.trim());
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    // Titles arrive with stray tabs and newlines from the unfurler.
    const title = collapse(entry?.title) || parsed.hostname.replace(/^www\./, "");
    const description = collapse(entry?.description).slice(0, 220);
    links.push(description ? { url, title, description } : { url, title });
    if (links.length >= 6) break;
  }
  return links.length ? links : null;
}

function collapse(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * Turns user input into a safe FTS5 MATCH expression.
 *
 * FTS5 has its own query syntax, so a bare "?" makes a search for `-` or `"` or
 * `OR` throw. Every token is stripped of syntax characters and quoted, then the
 * tokens are ANDed: all words must appear, which is what people expect from a
 * search box. A trailing `*` on the last token is preserved as a prefix match.
 */
export function searchQuery(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  // Punctuation separates words rather than disappearing: "Fahrrad,ORT" must
  // become two terms, not the single nonsense token "FahrradORT".
  const cleaned = raw
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!cleaned.length) return null;
  const last = cleaned.length - 1;
  return cleaned
    .map((term, index) => (index === last ? `"${term}"*` : `"${term}"`))
    .join(" AND ");
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
      `INSERT INTO people (id, display_name, deleted, raw_json)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      display_name=excluded.display_name, deleted=excluded.deleted,
      raw_json=excluded.raw_json`,
    ).run(
      senderId,
      displayName,
      sender.deleted == null ? null : String(sender.deleted),
      JSON.stringify(sender),
    );
  }
  // The upstream client silently keeps ciphertext when decryption fails.
  const decryptionState = message.encrypted
    ? !message.text
      ? "empty"
      : message.original_text != null
        ? "decrypted"
        : "unverified"
    : "plain";
  // `has_file_attached` is set even when the API ships no file metadata, which
  // is how an unavailable attachment shows up as a message with no content.
  const attachmentMissing =
    message.has_file_attached && !(message.files || []).length ? 1 : 0;
  const reactions = normalizeReactions(message.reactions);
  const links = normalizeLinks(message.links);
  db.prepare(
    `INSERT INTO messages
    (id, chat_type, chat_id, sender_id, text, created_at, kind,
     reply_to_id, decryption_state, deleted, attachment_missing,
     reactions, links, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sender_id=excluded.sender_id, text=excluded.text,
      created_at=excluded.created_at, kind=excluded.kind,
      reply_to_id=excluded.reply_to_id,
      decryption_state=excluded.decryption_state,
      deleted=excluded.deleted,
      attachment_missing=excluded.attachment_missing,
      reactions=excluded.reactions,
      links=excluded.links,
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
    message.deleted == null ? null : String(message.deleted),
    attachmentMissing,
    reactions ? JSON.stringify(reactions) : null,
    links ? JSON.stringify(links) : null,
    JSON.stringify(message),
  );
  for (const file of message.files || []) {
    if (file.id == null) continue;
    const fileId = String(file.id);
    const sizeValue = file.size_bytes ?? file.size_byte;
    const sizeBytes = sizeValue == null ? null : Number(sizeValue);
    db.prepare(
      `INSERT INTO files (id, name, mime, size_bytes, raw_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, mime=excluded.mime,
      size_bytes=excluded.size_bytes, raw_json=excluded.raw_json`,
    ).run(
      fileId,
      file.name || fileId,
      file.mime || null,
      Number.isFinite(sizeBytes) ? sizeBytes : null,
      JSON.stringify(file),
    );
    db.prepare(
      `INSERT OR IGNORE INTO message_files (message_id, file_id)
      VALUES (?, ?)`,
    ).run(String(message.id), fileId);
  }
  return decryptionState;
}
