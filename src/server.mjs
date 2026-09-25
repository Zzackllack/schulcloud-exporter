import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { blobPath } from "./blobs.mjs";

const webDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const assetTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export function createApp(db, directory) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("Cache-Control", "no-store");
    context.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    if (context.req.method !== "GET") {
      return context.json({ error: "Nur Lesen erlaubt" }, 405);
    }
    await next();
  });
  app.onError((error, context) => {
    console.error(error);
    return context.json({ error: "Interner Archivfehler" }, 500);
  });
  app.notFound((context) => context.json({ error: "Nicht gefunden" }, 404));

  app.get("/api/summary", (context) => {
    const chats = db.prepare("SELECT COUNT(*) AS n FROM chats").get().n;
    const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
    const files = db.prepare("SELECT COUNT(*) AS n FROM files WHERE status='complete'").get().n;
    const failed = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE import_state IN ('failed', 'needs-review')").get().n;
    const lastRun = db.prepare("SELECT * FROM import_runs ORDER BY id DESC LIMIT 1").get();
    const ownUserId = db.prepare("SELECT value FROM metadata WHERE key='own_user_id'").get()?.value;
    return context.json({ chats, messages, files, failed, lastRun, ownUserId });
  });

  app.get("/api/chats", (context) => {
    const chats = db.prepare(`SELECT type, id, title, archived, encrypted,
      avatar_hash, import_state, import_error,
      (SELECT COUNT(*) FROM messages WHERE chat_type=chats.type AND chat_id=chats.id) AS message_count,
      (SELECT MAX(created_at) FROM messages WHERE chat_type=chats.type AND chat_id=chats.id) AS latest_at
      FROM chats ORDER BY latest_at DESC, title COLLATE NOCASE`).all();
    return context.json(chats);
  });

  app.get("/api/chats/:type/:id/messages", (context) => {
    const chat = findChat(db, context);
    if (!chat) return context.json({ error: "Chat nicht gefunden" }, 404);
    const { type, id } = context.req.param();
    const before = context.req.query("before");
    const limit = Math.min(Math.max(Number(context.req.query("limit")) || 100, 1), 200);
    const selection = `SELECT m.*, p.display_name AS sender_name, p.avatar_hash AS sender_avatar,
      (SELECT json_group_array(json_object('id', f.id, 'name', f.name,
        'mime', f.mime, 'size_bytes', f.size_bytes,
        'blob_hash', f.blob_hash, 'status', f.status))
       FROM message_files mf JOIN files f ON f.id=mf.file_id
       WHERE mf.message_id=m.id) AS files_json
      FROM messages m LEFT JOIN people p ON p.id=m.sender_id
      WHERE m.chat_type=? AND m.chat_id=?`;
    const cursor = ` AND (COALESCE(m.created_at, '') < ? OR
      (COALESCE(m.created_at, '') = ? AND m.id < ?))`;
    const order = " ORDER BY COALESCE(m.created_at, '') DESC, m.id DESC LIMIT ?";
    const messages = before !== undefined
      ? db.prepare(selection + cursor + order).all(type, id, before, before, context.req.query("before_id") || "", limit)
      : db.prepare(selection + order).all(type, id, limit);
    return context.json({
      chat: { type, id, title: chat.title, import_state: chat.import_state, import_error: chat.import_error },
      messages: messages.reverse().map(toPublicMessage),
    });
  });

  app.get("/api/chats/:type/:id/export", (context) => {
    const chat = findChat(db, context);
    if (!chat) return context.json({ error: "Chat nicht gefunden" }, 404);
    const { type, id } = context.req.param();
    const messages = db.prepare(`SELECT raw_json FROM messages
      WHERE chat_type=? AND chat_id=? ORDER BY created_at, id`).all(type, id);
    context.header("Content-Disposition", `attachment; filename="${type}-${encodeURIComponent(id)}.json"`);
    return context.json({
      format: "schulcloud-archive-v1",
      chat: JSON.parse(chat.raw_json),
      messages: messages.map((row) => JSON.parse(row.raw_json)),
    });
  });

  app.get("/media/:hash", async (context) => {
    const hash = context.req.param("hash");
    if (!/^[0-9a-f]{64}$/.test(hash)) return context.json({ error: "Datei nicht gefunden" }, 404);
    const item = db.prepare("SELECT media_type FROM blobs WHERE hash=?").get(hash);
    if (!item) return context.json({ error: "Datei nicht gefunden" }, 404);
    try {
      const bytes = await readFile(blobPath(directory, hash));
      context.header("Content-Type", item.media_type || "application/octet-stream");
      return context.body(bytes);
    } catch (error) {
      if (error.code === "ENOENT") return context.json({ error: "Datei nicht gefunden" }, 404);
      throw error;
    }
  });

  app.get("/assets/:name", async (context) => {
    const name = context.req.param("name");
    if (!/^[\w.-]+$/.test(name)) return context.json({ error: "Nicht gefunden" }, 404);
    const type = assetTypes.get(name.slice(name.lastIndexOf(".")));
    if (!type) return context.json({ error: "Nicht gefunden" }, 404);
    try {
      const bytes = await readFile(join(webDirectory, "assets", name));
      context.header("Content-Type", type);
      return context.body(bytes);
    } catch (error) {
      if (error.code === "ENOENT") return context.json({ error: "Nicht gefunden" }, 404);
      throw error;
    }
  });
  app.get("/", serveIndex);
  app.get("/chats/:type/:id", serveIndex);
  return app;
}

function findChat(db, context) {
  const { type, id } = context.req.param();
  if (type !== "channel" && type !== "conversation") return null;
  return db.prepare("SELECT * FROM chats WHERE type=? AND id=?").get(type, id);
}

async function serveIndex(context) {
  const bytes = await readFile(join(webDirectory, "index.html"));
  context.header("Content-Type", "text/html; charset=utf-8");
  return context.body(bytes);
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

export function startServer(db, directory, port = 4317) {
  return serve(
    { fetch: createApp(db, directory).fetch, hostname: "127.0.0.1", port },
    (info) => console.log(`Archiv: http://127.0.0.1:${info.port}`),
  );
}
