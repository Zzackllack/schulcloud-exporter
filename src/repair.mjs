import { messageDate } from "./database.mjs";

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
