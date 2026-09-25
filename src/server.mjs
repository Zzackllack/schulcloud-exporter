import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { blobPath } from "./blobs.mjs";

const webDirectory = fileURLToPath(new URL("../web/", import.meta.url));
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

export function startServer(db, directory, port = 4317) {
  const server = createServer(async (request, response) => {
    try {
      await route(db, directory, request, response);
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { error: "Interner Archivfehler" });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Archiv: http://127.0.0.1:${server.address().port}`);
  });
  return server;
}

async function route(db, directory, request, response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  );
  if (request.method !== "GET")
    return sendJson(response, 405, { error: "Nur Lesen erlaubt" });
  const url = new URL(request.url, "http://localhost");
  const staticFile = staticFiles.get(url.pathname);
  if (staticFile) {
    const [name, type] = staticFile;
    const bytes = await readFile(join(webDirectory, name));
    return sendBytes(response, 200, bytes, type);
  }
  if (url.pathname === "/api/summary") {
    const chats = db.prepare("SELECT COUNT(*) AS n FROM chats").get().n;
    const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
    const files = db
      .prepare("SELECT COUNT(*) AS n FROM files WHERE status='complete'")
      .get().n;
    const failed = db
      .prepare(
        "SELECT COUNT(*) AS n FROM chats WHERE import_state IN ('failed', 'needs-review')",
      )
      .get().n;
    const lastRun = db
      .prepare("SELECT * FROM import_runs ORDER BY id DESC LIMIT 1")
      .get();
    const ownUserId = db
      .prepare("SELECT value FROM metadata WHERE key='own_user_id'")
      .get()?.value;
    return sendJson(response, 200, {
      chats,
      messages,
      files,
      failed,
      lastRun,
      ownUserId,
    });
  }
  if (url.pathname === "/api/chats") {
    const chats = db
      .prepare(
        `SELECT type, id, title, archived, encrypted,
      avatar_hash, import_state, import_error,
      (SELECT COUNT(*) FROM messages WHERE chat_type=chats.type AND chat_id=chats.id) AS message_count,
      (SELECT MAX(created_at) FROM messages WHERE chat_type=chats.type AND chat_id=chats.id) AS latest_at
      FROM chats ORDER BY latest_at DESC, title COLLATE NOCASE`,
      )
      .all();
    return sendJson(response, 200, chats);
  }
  const chatMatch = url.pathname.match(
    /^\/api\/chats\/(channel|conversation)\/([^/]+)\/messages$/,
  );
  if (chatMatch) {
    const [, type, id] = chatMatch;
    const chat = db
      .prepare("SELECT * FROM chats WHERE type=? AND id=?")
      .get(type, id);
    if (!chat) return sendJson(response, 404, { error: "Chat nicht gefunden" });
    const before = url.searchParams.get("before");
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || 100, 1),
      200,
    );
    const messages = url.searchParams.has("before")
      ? db
          .prepare(
            `SELECT m.*, p.display_name AS sender_name, p.avatar_hash AS sender_avatar,
          (SELECT json_group_array(json_object('id', f.id, 'name', f.name,
            'mime', f.mime, 'size_bytes', f.size_bytes,
            'blob_hash', f.blob_hash, 'status', f.status))
           FROM message_files mf JOIN files f ON f.id=mf.file_id
           WHERE mf.message_id=m.id) AS files_json
          FROM messages m LEFT JOIN people p ON p.id=m.sender_id
          WHERE m.chat_type=? AND m.chat_id=? AND (COALESCE(m.created_at, '') < ? OR
            (COALESCE(m.created_at, '') = ? AND m.id < ?))
          ORDER BY COALESCE(m.created_at, '') DESC, m.id DESC LIMIT ?`,
          )
          .all(
            type,
            id,
            before,
            before,
            url.searchParams.get("before_id") || "",
            limit,
          )
      : db
          .prepare(
            `SELECT m.*, p.display_name AS sender_name, p.avatar_hash AS sender_avatar,
          (SELECT json_group_array(json_object('id', f.id, 'name', f.name,
            'mime', f.mime, 'size_bytes', f.size_bytes,
            'blob_hash', f.blob_hash, 'status', f.status))
           FROM message_files mf JOIN files f ON f.id=mf.file_id
           WHERE mf.message_id=m.id) AS files_json
          FROM messages m LEFT JOIN people p ON p.id=m.sender_id
          WHERE m.chat_type=? AND m.chat_id=?
          ORDER BY COALESCE(m.created_at, '') DESC, m.id DESC LIMIT ?`,
          )
          .all(type, id, limit);
    return sendJson(response, 200, {
      chat: {
        type,
        id,
        title: chat.title,
        import_state: chat.import_state,
        import_error: chat.import_error,
      },
      messages: messages.reverse().map(toPublicMessage),
    });
  }
  const exportMatch = url.pathname.match(
    /^\/api\/chats\/(channel|conversation)\/([^/]+)\/export$/,
  );
  if (exportMatch) {
    const [, type, id] = exportMatch;
    const chat = db
      .prepare("SELECT * FROM chats WHERE type=? AND id=?")
      .get(type, id);
    if (!chat) return sendJson(response, 404, { error: "Chat nicht gefunden" });
    const messages = db
      .prepare(
        `SELECT raw_json FROM messages
      WHERE chat_type=? AND chat_id=? ORDER BY created_at, id`,
      )
      .all(type, id);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${type}-${id}.json"`,
    );
    return sendJson(response, 200, {
      format: "schulcloud-archive-v1",
      chat: JSON.parse(chat.raw_json),
      messages: messages.map((row) => JSON.parse(row.raw_json)),
    });
  }
  const blobMatch = url.pathname.match(/^\/media\/([0-9a-f]{64})$/);
  if (blobMatch) {
    const path = blobPath(directory, blobMatch[1]);
    const item = db
      .prepare("SELECT media_type FROM blobs WHERE hash=?")
      .get(blobMatch[1]);
    if (!item || !path)
      return sendJson(response, 404, { error: "Datei nicht gefunden" });
    const bytes = await readFile(path);
    return sendBytes(
      response,
      200,
      bytes,
      item.media_type || "application/octet-stream",
    );
  }
  sendJson(response, 404, { error: "Nicht gefunden" });
}

function toPublicMessage(row) {
  return {
    id: row.id,
    sender_id: row.sender_id,
    sender_name: row.sender_name || "Unbekannte Person",
    sender_avatar: row.sender_avatar,
    text: row.text,
    created_at: row.created_at,
    kind: row.kind,
    reply_to_id: row.reply_to_id,
    decryption_state: row.decryption_state,
    files: JSON.parse(row.files_json || "[]"),
  };
}

function sendJson(response, status, value) {
  sendBytes(
    response,
    status,
    Buffer.from(JSON.stringify(value)),
    "application/json; charset=utf-8",
  );
}

function sendBytes(response, status, bytes, type) {
  response.writeHead(status, {
    "Content-Type": type,
    "Content-Length": bytes.length,
  });
  response.end(bytes);
}
