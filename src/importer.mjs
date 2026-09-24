import { StashcatClient } from "stashcat-api";
import { importAvatars } from "./avatars.mjs";
import { saveBlob } from "./blobs.mjs";
import { saveChat, saveMessage } from "./database.mjs";

const PAGE_SIZE = 50;

export async function importArchive(
  db,
  directory,
  credentials,
  output = console,
) {
  const run = db
    .prepare(
      `INSERT INTO import_runs (started_at, status)
    VALUES (?, 'running')`,
    )
    .run(new Date().toISOString());
  const runId = Number(run.lastInsertRowid);
  const client = new StashcatClient({ baseUrl: "https://api.stashcat.com/" });
  try {
    await client.login({
      email: credentials.email,
      password: credentials.password,
      securityPassword: credentials.securityPassword,
      encrypted: true,
      appName: "schulcloud-archive",
    });
    if (!client.isE2EUnlocked()) {
      throw new Error("Verschlüsselung konnte nicht entsperrt werden.");
    }
    const own = await client.getMe();
    db.prepare(
      `INSERT INTO metadata (key, value) VALUES ('own_user_id', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(String(own.id));
    const companies = await client.getCompanies();
    const seen = new Set();
    for (const company of companies) {
      const channels = await client.getChannels(String(company.id));
      for (const chat of channels) {
        const id = String(chat.id);
        const key = `channel:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        saveChat(db, "channel", { ...chat, company_id: company.id });
        await importChat(db, directory, client, "channel", id, output);
      }
    }
    for (const archived of [false, true]) {
      for await (const chat of listConversations(client, archived)) {
        const id = String(chat.id);
        const key = `conversation:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        saveChat(db, "conversation", chat, archived, String(own.id));
        await importChat(db, directory, client, "conversation", id, output);
      }
    }
    await importAvatars(db, directory, client, output);
    const failed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM chats
      WHERE import_state IN ('failed', 'needs-review')`,
      )
      .get().n;
    const failedFiles = db
      .prepare(
        `SELECT COUNT(*) AS n FROM files
      WHERE status='failed'`,
      )
      .get().n;
    db.prepare(
      `UPDATE import_runs SET finished_at=?, status=?, error=?
      WHERE id=?`,
    ).run(
      new Date().toISOString(),
      failed || failedFiles ? "partial" : "complete",
      failed || failedFiles
        ? `${failed} Chats und ${failedFiles} Dateien prüfen`
        : null,
      runId,
    );
    output.log(`Fertig: ${seen.size} Chats geprüft.`);
  } catch (error) {
    db.prepare(
      `UPDATE import_runs SET finished_at=?, status='failed', error=?
      WHERE id=?`,
    ).run(new Date().toISOString(), String(error), runId);
    throw error;
  } finally {
    client.logout();
  }
}

export async function* listConversations(client, archived) {
  let offset = 0;
  const seen = new Set();
  while (true) {
    const page = await client.getConversations({
      limit: PAGE_SIZE,
      offset,
      archive: archived ? 1 : 0,
    });
    if (!Array.isArray(page)) throw new Error("Ungültige Konversationsliste");
    if (page.length === 0) return;
    let fresh = 0;
    for (const chat of page) {
      const id = String(chat.id);
      if (seen.has(id)) continue;
      seen.add(id);
      fresh++;
      yield chat;
    }
    if (fresh === 0)
      throw new Error("Konversations-Paginierung wiederholt dieselbe Seite");
    offset += page.length;
  }
}

export async function importChat(db, directory, client, type, id, output) {
  const state = db
    .prepare(`SELECT import_state FROM chats WHERE type=? AND id=?`)
    .get(type, id);
  if (state?.import_state === "complete") return;
  output.log(`${type} ${id}: importiere …`);
  let count = 0;
  let unverified = 0;
  try {
    let aesKey;
    for await (const message of listMessages(client, type, id)) {
      const result = saveMessage(db, type, id, message);
      count++;
      if (result === "unverified") unverified++;
      for (const file of message.files || []) {
        if (file.encrypted && !aesKey) {
          try {
            aesKey =
              type === "channel"
                ? await client.getChannelAesKey(id)
                : await client.getConversationAesKey(id);
          } catch (error) {
            output.error(
              `${type} ${id}: Dateischlüssel nicht verfügbar: ${error}`,
            );
          }
        }
        await importFile(db, directory, client, file, aesKey, output);
      }
    }
    db.prepare(
      `UPDATE chats SET import_state=?, import_error=?, imported_at=?
      WHERE type=? AND id=?`,
    ).run(
      unverified ? "needs-review" : "complete",
      unverified
        ? `${unverified} verschlüsselte Nachrichten nicht verifiziert`
        : null,
      new Date().toISOString(),
      type,
      id,
    );
    output.log(`${type} ${id}: ${count} Nachrichten, ${unverified} ungeprüft`);
  } catch (error) {
    db.prepare(
      `UPDATE chats SET import_state='failed', import_error=?
      WHERE type=? AND id=?`,
    ).run(String(error), type, id);
    output.error(`${type} ${id}: ${error}`);
    // Continue with other chats. Failed chats are visible and retry on the next run.
  }
}

export async function* listMessages(client, type, id) {
  let offset = 0;
  const seen = new Set();
  while (true) {
    const page = await client.getMessages(id, type, {
      limit: PAGE_SIZE,
      offset,
    });
    if (!Array.isArray(page)) throw new Error("Ungültige Nachrichtenseite");
    if (page.length === 0) return;
    let fresh = 0;
    for (const message of page) {
      const messageId = String(message.id);
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      fresh++;
      yield message;
    }
    if (fresh === 0)
      throw new Error("Nachrichten-Paginierung wiederholt dieselbe Seite");
    offset += page.length;
  }
}

async function importFile(db, directory, client, file, aesKey, output) {
  if (file.id == null) return;
  const id = String(file.id);
  const current = db.prepare("SELECT status FROM files WHERE id=?").get(id);
  if (current?.status === "complete") return;
  try {
    if (file.encrypted && !aesKey)
      throw new Error("Kein Entschlüsselungsschlüssel");
    const bytes = await client.downloadFile(file, aesKey);
    const hash = await saveBlob(db, directory, bytes, file.mime);
    db.prepare(
      `UPDATE files SET blob_hash=?, status='complete', error=NULL
      WHERE id=?`,
    ).run(hash, id);
  } catch (error) {
    db.prepare(`UPDATE files SET status='failed', error=? WHERE id=?`).run(
      String(error),
      id,
    );
    output.error(`Datei ${id}: ${error}`);
  }
}
