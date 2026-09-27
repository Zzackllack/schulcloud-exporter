import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { blobPath } from "./blobs.mjs";
import { publicImportState, startImport, subscribe } from "./import-state.mjs";
import { searchQuery } from "./database.mjs";

const webDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const assetTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

// The only routes allowed to change anything. Everything else stays read-only,
// which is the guarantee the rest of the API is built on.
const WRITABLE = /^\/api\/import(\/|$)/;

// A remote page can point a hostname it controls at 127.0.0.1, so the Host
// header -- not the socket -- is what proves the caller meant this viewer.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isLocalHost(headers) {
  const host = (headers.get("host") || "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTS.has(name) || LOCAL_HOSTS.has(host);
}

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
      const path = new URL(context.req.url).pathname;
      if (!WRITABLE.test(path)) {
        return context.json({ error: "Nur Lesen erlaubt" }, 405);
      }
      if (!isLocalHost(context.req.raw.headers)) {
        return context.json({ error: "Nur lokal erlaubt" }, 403);
      }
      // Requiring JSON means a cross-origin form cannot post here, and a
      // cross-origin fetch would need a preflight this server never answers.
      // Together with the Host check that closes localhost CSRF and rebinding.
      if (!context.req.header("content-type")?.startsWith("application/json")) {
        return context.json({ error: "application/json erforderlich" }, 415);
      }
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

  app.get("/api/search", (context) => {
    const match = searchQuery(context.req.query("q"));
    if (!match) return context.json({ query: "", results: [] });
    const limit = Math.min(
      Math.max(Number(context.req.query("limit")) || 50, 1),
      200,
    );
    const chatId = context.req.query("chat") || null;
    // bm25 ranks lower-is-better, so ascending is best-first. The snippet is
    // delimited with sentinels rather than HTML tags: message bodies are other
    // people's text, and this must never become an injection point.
    let sql = `SELECT m.id, m.chat_type, m.chat_id, m.created_at, m.kind,
        c.title AS chat_title,
        coalesce(p.display_name, 'Unbekannte Person') AS sender_name,
        snippet(messages_fts, 0, char(1), char(2), '…', 14) AS snippet,
        bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN chats c ON c.type = m.chat_type AND c.id = m.chat_id
      LEFT JOIN people p ON p.id = m.sender_id
      WHERE messages_fts MATCH ? AND m.text IS NOT NULL AND m.text <> ''`;
    const params = [match];
    if (chatId) {
      sql += " AND m.chat_type = ? AND m.chat_id = ?";
      params.push(context.req.query("type") === "conversation" ? "conversation" : "channel", chatId);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);
    let results;
    try {
      results = db.prepare(sql).all(...params);
    } catch {
      // Defence in depth: searchQuery already neutralises FTS syntax, so this
      // should be unreachable. Answer with nothing rather than a 500.
      return context.json({ query: String(context.req.query("q") || ""), results: [] });
    }
    return context.json({
      query: String(context.req.query("q") || ""),
      results: results.map((row) => ({
        id: row.id,
        chat_type: row.chat_type,
        chat_id: row.chat_id,
        chat_title: row.chat_title,
        sender_name: row.sender_name,
        created_at: row.created_at,
        kind: row.kind,
        snippet: row.snippet,
      })),
    });
  });

  app.get("/api/import", (context) => context.json(publicImportState()));

  app.post("/api/import", async (context) => {
    let body = {};
    try {
      body = await context.req.json();
    } catch {
      // Empty body is fine: it means "use the environment credentials".
    }
    try {
      await startImport(db, directory, body);
      return context.json(publicImportState(), 202);
    } catch (error) {
      return context.json(
        { error: String(error.message || error) },
        error.status || 500,
      );
    }
  });

  // One-way progress stream. A snapshot goes out first so a reload rejoins the
  // run in progress rather than starting from zero. Each frame carries the
  // whole visible state rather than a delta, so a missed or reordered frame
  // can never leave the UI showing something that never happened.
  app.get("/api/import/events", (context) =>
    streamSSE(context, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      const unsubscribe = subscribe(() => {
        stream
          .writeSSE({ event: "progress", data: JSON.stringify(publicImportState()) })
          .catch(() => {
            open = false;
          });
      });
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(publicImportState()),
      });
      // Keep intermediaries from closing an idle connection during a long
      // download, and notice when the client goes away. Sent without an event
      // name so it arrives as a plain `message`, which the client does not
      // treat as state.
      while (open) {
        await stream.sleep(15000);
        if (!open) break;
        await stream.writeSSE({ data: "" }).catch(() => {
          open = false;
        });
      }
    }),
  );

  app.get("/api/chats/:type/:id/messages", (context) => {
    const chat = findChat(db, context);
    if (!chat) return context.json({ error: "Chat nicht gefunden" }, 404);
    const { type, id } = context.req.param();
    const before = context.req.query("before");
    const limit = Math.min(Math.max(Number(context.req.query("limit")) || 100, 1), 200);
    const selection = `SELECT m.*, p.display_name AS sender_name, p.avatar_hash AS sender_avatar,
      p.deleted AS sender_deleted,
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
    context.header(
      "Content-Disposition",
      buildContentDisposition(`${type}-${id}.json`),
    );
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

  app.get("/assets/:name", (context) =>
    serveFile(context, "assets", context.req.param("name")),
  );
  // Vite copies public/ to the build root, not into dist/assets/.
  app.get("/favicon.svg", (context) => serveFile(context, ".", "favicon.svg"));
  app.get("/", serveIndex);
  app.get("/chats/:type/:id", serveIndex);
  return app;
}

function findChat(db, context) {
  const { type, id } = context.req.param();
  if (type !== "channel" && type !== "conversation") return null;
  return db.prepare("SELECT * FROM chats WHERE type=? AND id=?").get(type, id);
}

async function serveFile(context, directory, name) {
  if (!/^[\w.-]+$/.test(name)) return context.json({ error: "Nicht gefunden" }, 404);
  const type = assetTypes.get(name.slice(name.lastIndexOf(".")));
  if (!type) return context.json({ error: "Nicht gefunden" }, 404);
  try {
    const bytes = await readFile(join(webDirectory, directory, name));
    context.header("Content-Type", type);
    return context.body(bytes);
  } catch (error) {
    if (error.code === "ENOENT") return context.json({ error: "Nicht gefunden" }, 404);
    throw error;
  }
}

async function serveIndex(context) {
  const bytes = await readFile(join(webDirectory, "index.html"));
  context.header("Content-Type", "text/html; charset=utf-8");
  return context.body(bytes);
}

function buildContentDisposition(filename) {
  const asciiFallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[\\"]/g, "_")
    .trim() || "download.json";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function encodeRFC5987ValueChars(value) {
  return encodeURIComponent(value)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}

// Stored columns are written by the importer or by `pnpm repair`, so a NULL or
// unparseable value means "no reactions" rather than an error worth surfacing.
function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toPublicMessage(row) {
  // A deleted account has its name scrubbed by the API, so say so rather than
  // showing the "Nutzer <id>" placeholder as if it were a real name.
  const senderDeleted = Boolean(row.sender_deleted);
  return {
    id: row.id,
    sender_id: row.sender_id,
    sender_name: senderDeleted ? "Gelöschtes Konto" : row.sender_name || "Unbekannte Person",
    sender_avatar: row.sender_avatar,
    sender_deleted: senderDeleted,
    text: row.text,
    created_at: row.created_at,
    kind: row.kind,
    reply_to_id: row.reply_to_id,
    deleted: Boolean(row.deleted),
    attachment_missing: Boolean(row.attachment_missing),
    reactions: parseJsonArray(row.reactions),
    links: parseJsonArray(row.links),
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
