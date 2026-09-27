import { conversationTitle, messageDate } from "./database.mjs";

/**
 * Recomputes `messages.created_at` from the preserved API response.
 *
 * Archives written before the `micro_time` unit fix have every timestamp
 * collapsed into 1970-01-01, which also scrambles message order, the date
 * dividers, the sidebar's `latest_at` and the `before` pagination cursor.
 * `raw_json` still holds the original `time`/`micro_time`, so the fix is exact
 * and needs no network access -- unlike `pnpm sync`, which skips chats that are
 * already marked `complete` and would therefore leave the bad rows untouched.
 */
export function repairTimestamps(db, output = console) {
  const rows = db
    .prepare("SELECT id, created_at, raw_json FROM messages")
    .all();
  const update = db.prepare("UPDATE messages SET created_at=? WHERE id=?");
  let changed = 0;
  let dropped = 0;

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const date = messageDate(JSON.parse(row.raw_json));
      if (date === row.created_at) continue;
      if (date === null) {
        // The stored date cannot be reproduced from raw_json. Rather than keep a
        // value we no longer trust, fall back to NULL (sorted first, as the
        // viewer already expects for undated messages).
        dropped++;
      }
      update.run(date, row.id);
      changed++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const undated = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE created_at IS NULL")
    .get().n;
  output.log(
    `${rows.length} Nachrichten geprüft, ${changed} korrigiert` +
      (dropped ? `, ${dropped} ohne Datum` : "") +
      `. Ohne Datum gesamt: ${undated}.`,
  );
  return { checked: rows.length, changed, dropped };
}

/**
 * Backfills the deletion and missing-attachment flags from `raw_json`.
 *
 * Both are visible properties of the API response, not something the importer
 * used to record, so older archives have them as NULL. Deriving them here keeps
 * them out of the per-request path -- the alternative, parsing `raw_json` in
 * SQL or per row, means megabytes of JSON per page because sender objects carry
 * large public keys.
 */
export function repairDeletions(db, output = console) {
  const messages = db
    .prepare("SELECT id, deleted, attachment_missing, raw_json FROM messages")
    .all();
  const updateMessage = db.prepare(
    "UPDATE messages SET deleted=?, attachment_missing=? WHERE id=?",
  );
  const people = db.prepare("SELECT id, deleted, raw_json FROM people").all();
  const updatePerson = db.prepare("UPDATE people SET deleted=? WHERE id=?");
  let deletedMessages = 0;
  let missingAttachments = 0;
  let deletedPeople = 0;

  db.exec("BEGIN");
  try {
    for (const row of messages) {
      const message = JSON.parse(row.raw_json);
      const deleted =
        message.deleted == null ? null : String(message.deleted);
      const missing =
        message.has_file_attached && !(message.files || []).length ? 1 : 0;
      if (deleted !== row.deleted || missing !== row.attachment_missing) {
        updateMessage.run(deleted, missing, row.id);
      }
      if (deleted) deletedMessages++;
      if (missing) missingAttachments++;
    }
    for (const row of people) {
      const person = JSON.parse(row.raw_json);
      const deleted = person.deleted == null ? null : String(person.deleted);
      if (deleted === row.deleted) continue;
      updatePerson.run(deleted, row.id);
      if (deleted) deletedPeople++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  output.log(
    `${deletedMessages} gelöschte Nachrichten, ` +
      `${missingAttachments} mit fehlendem Anhang, ` +
      `${deletedPeople} gelöschte Konten erkannt.`,
  );
  return { deletedMessages, missingAttachments, deletedPeople };
}

/**
 * Rebuilds conversation titles from the preserved `members` list.
 *
 * Archives written before the `members`/`participants` fix titled every
 * conversation "Konversation <id>", because the importer looked for a field the
 * API never sends. `raw_json` still holds `members`, so this needs no network
 * access. Channels carry their own `name` and are left alone.
 */
export function repairChatTitles(db, output = console) {
  const ownId = db
    .prepare("SELECT value FROM metadata WHERE key='own_user_id'")
    .get()?.value;
  if (!ownId) {
    output.log("Übersprungen: own_user_id fehlt, Konversationstitel nicht reparierbar.");
    return { checked: 0, changed: 0 };
  }
  const rows = db
    .prepare("SELECT type, id, title, raw_json FROM chats")
    .all();
  const update = db.prepare("UPDATE chats SET title=? WHERE type=? AND id=?");
  let changed = 0;
  let unresolved = 0;

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      if (row.type !== "conversation") continue;
      const chat = JSON.parse(row.raw_json);
      // A conversation the user renamed keeps that name; only fall back to a
      // derived one when the stored title is just the id placeholder.
      const placeholder = `Konversation ${row.id}`;
      if (row.title !== placeholder) continue;
      const title = conversationTitle(chat, ownId);
      if (!title) {
        unresolved++;
        continue;
      }
      update.run(title, row.type, row.id);
      changed++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  output.log(
    `${rows.length} Chats geprüft, ${changed} Konversationstitel korrigiert` +
      (unresolved ? `, ${unresolved} ohne Teilnehmerliste` : "") +
      ".",
  );
  return { checked: rows.length, changed, unresolved };
}
