import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { blobCounts, createS3Store, describeStoreError } from "./storage.mjs";
import {
  publicImportState,
  startImport,
  subscribe,
} from "./import-state.mjs";
import {
  describeSettings,
  lockedFields,
  loadSettings,
  saveSettings,
  validateSettings,
} from "./settings.mjs";
import { publicStorageJob, startStorageJob, subscribeStorage } from "./storage-jobs.mjs";
import { searchQuery } from "./database.mjs";

const webDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
// Kept in step with MESSAGE_PAGE_SIZE in web/api.ts.
const MESSAGE_PAGE_SIZE = 100;
const assetTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

// The only routes allowed to change anything. Everything else stays read-only,
// which is the guarantee the rest of the API is built on. The settings routes
// are here because they decide where future blobs go and can move the archive
// between disk and a bucket.
const WRITABLE = /^\/(api\/import|api\/settings)(\/|$)/;

// A remote page can point a hostname it controls at 127.0.0.1, so the Host
// header -- not the socket -- is what proves the caller meant this viewer.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isLocalHost(headers) {
  const host = (headers.get("host") || "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTS.has(name) || LOCAL_HOSTS.has(host);
}

export function createApp(db, storage) {
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
    // A storage failure keeps the useful part behind $response, which
    // console.error does not print on its own.
    console.error(error?.$metadata ? describeStoreError(error) : error);
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

  app.get("/api/import", (context) => context.json(publicImportState(db)));

  app.post("/api/import", async (context) => {
    let body = {};
    try {
      body = await context.req.json();
    } catch {
      // Empty body is fine: it means "use the environment credentials".
    }
    try {
      await startImport(db, storage, body);
      return context.json(publicImportState(db), 202);
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
          .writeSSE({ event: "progress", data: JSON.stringify(publicImportState(db)) })
          .catch(() => {
            open = false;
          });
      });
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(publicImportState(db)),
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

  // ---------------------------------------------------------------------------
  // Storage settings. Writes here decide where the next blob lands, so they sit
  // behind the same localhost-and-JSON gate as the import.
  // ---------------------------------------------------------------------------

  app.get("/api/settings", (context) =>
    context.json(settingsResponse(db, storage)),
  );

  app.put("/api/settings", async (context) => {
    let body = {};
    try {
      body = await context.req.json();
    } catch {
      // An empty body means "nothing changed", which is not worth rejecting.
    }
    let saved;
    try {
      saved = await saveSettings(storage.directory, body);
    } catch (error) {
      return context.json({ error: String(error.message || error) }, error.status || 500);
    }
    // Re-read rather than reusing the written file: the environment still
    // overrides it, and the storage has to run with what would actually be read
    // on the next start.
    const effective = await loadSettings(storage.directory);
    storage.reconfigure(effective);
    return context.json(settingsResponse(db, storage));
  });

  // Probes a draft, so a bucket can be checked before it is saved. The secret is
  // never part of the answer.
  app.post("/api/settings/test", async (context) => {
    let body = {};
    try {
      body = await context.req.json();
    } catch {
      /* no draft: falls back to the stored settings */
    }
    const submitted = body.s3 ?? {};
    // The form never receives the stored secret, so an empty field means "the
    // key already on disk", not "remove the key".
    const draft = {
      ...storage.settings.s3,
      ...submitted,
      secretAccessKey: submitted.secretAccessKey || storage.settings.s3.secretAccessKey,
    };
    const errors = validateSettings({ backend: "s3", s3: draft });
    if (errors.length) return context.json({ ok: false, error: errors.join(" ") }, 400);
    try {
      await createS3Store(draft).probe();
      return context.json({ ok: true });
    } catch (error) {
      // The status line and the raw reply are the useful part of a failed probe,
      // and a bucket behind a proxy spells neither of them out.
      return context.json({ ok: false, error: describeStoreError(error) }, 502);
    }
  });

  app.post("/api/settings/migrate", async (context) => {
    let body = {};
    try {
      body = await context.req.json();
    } catch {
      /* empty body is rejected below */
    }
    try {
      return context.json(await startStorageJob(db, storage, body.backend), 202);
    } catch (error) {
      return context.json({ error: String(error.message || error) }, error.status || 500);
    }
  });

  // Migration progress, same one-way shape as the import stream. A copy of a
  // real archive takes minutes, so the viewer needs to show it without polling.
  app.get("/api/settings/events", (context) =>
    streamSSE(context, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      const unsubscribe = subscribeStorage(() => {
        stream
          .writeSSE({ event: "progress", data: JSON.stringify(publicStorageJob()) })
          .catch(() => {
            open = false;
          });
      });
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(publicStorageJob()),
      });
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

  // Loads a window of messages around a date.
  //
  // Paging backwards through "Ältere Nachrichten laden" is the only other way to
  // reach 2021 in a channel with a thousand messages, which is click-hostile.
  // The window starts a little before the requested day and fills forward from
  // there, so the target lands near the top instead of at either edge.
  app.get("/api/chats/:type/:id/around", (context) => {
    const chat = findChat(db, context);
    if (!chat) return context.json({ error: "Chat nicht gefunden" }, 404);
    const { type, id } = context.req.param();
    const day = String(context.req.query("date") || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return context.json({ error: "Datum muss JJJJ-MM-TT sein" }, 400);
    }
    // Midday avoids landing on the wrong side of a timezone boundary.
    const target = new Date(`${day}T12:00:00.000Z`).toISOString();

    // Anchor on the last message at or before the requested day. A single
    // "(<= ? OR >= ?) ORDER BY created_at" query looks equivalent but is not:
    // every row satisfies one branch, so it just returns the channel's first
    // message. When the day predates the chat, fall back to the first message
    // after it.
    const anchor =
      db
        .prepare(
          `SELECT m.created_at FROM messages m
           WHERE m.chat_type=? AND m.chat_id=? AND m.created_at IS NOT NULL
             AND m.created_at <= ?
           ORDER BY m.created_at DESC LIMIT 1`,
        )
        .get(type, id, target) ??
      db
        .prepare(
          `SELECT m.created_at FROM messages m
           WHERE m.chat_type=? AND m.chat_id=? AND m.created_at IS NOT NULL
             AND m.created_at >= ?
           ORDER BY m.created_at ASC LIMIT 1`,
        )
        .get(type, id, target);
    if (!anchor) {
      return context.json({ error: "Keine Nachrichten im Chat", messages: [] }, 404);
    }

    // Step back half a page so the target is not the first thing on screen.
    const lead = db
      .prepare(
        `SELECT m.created_at FROM messages m
         WHERE m.chat_type=? AND m.chat_id=? AND m.created_at < ?
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .get(type, id, anchor.created_at, Math.floor(MESSAGE_PAGE_SIZE / 2));
    const from = lead?.created_at ?? anchor.created_at;

    const messages = db
      .prepare(
        `SELECT m.*, p.display_name AS sender_name, p.avatar_hash AS sender_avatar,
           p.deleted AS sender_deleted,
           (SELECT json_group_array(json_object('id', f.id, 'name', f.name,
             'mime', f.mime, 'size_bytes', f.size_bytes,
             'blob_hash', f.blob_hash, 'status', f.status))
            FROM message_files mf JOIN files f ON f.id=mf.file_id
            WHERE mf.message_id=m.id) AS files_json
         FROM messages m LEFT JOIN people p ON p.id=m.sender_id
         WHERE m.chat_type=? AND m.chat_id=?
           AND COALESCE(m.created_at,'') >= ?
         ORDER BY COALESCE(m.created_at,'') ASC, m.id ASC LIMIT ?`,
      )
      .all(type, id, from, MESSAGE_PAGE_SIZE);

    return context.json({
      chat: {
        type,
        id,
        title: chat.title,
        import_state: chat.import_state,
        import_error: chat.import_error,
      },
      messages: messages.map(toPublicMessage),
    });
  });

  // The whole archive as newline-delimited JSON.
  //
  // `pnpm export` writes the same tables as separate files, but that needs a
  // terminal, and a browser cannot zip a 975 MB blob directory. One streamed
  // NDJSON file is the shape a browser can actually download, and streaming
  // keeps memory flat instead of assembling a 40 MB string in one go.
  //
  // The first line is a manifest, so the file is self-describing and can be
  // read line by line without knowing the table order in advance.
  app.get("/api/export", (context) => {
    const datasets = [
      ["chats", "SELECT * FROM chats ORDER BY type, id"],
      ["people", "SELECT * FROM people ORDER BY id"],
      [
        "messages",
        "SELECT * FROM messages ORDER BY chat_type, chat_id, created_at, id",
      ],
      ["files", "SELECT * FROM files ORDER BY id"],
      ["message_files", "SELECT * FROM message_files ORDER BY message_id, file_id"],
      ["blobs", "SELECT * FROM blobs ORDER BY hash"],
      ["metadata", "SELECT * FROM metadata ORDER BY key"],
      ["import_runs", "SELECT * FROM import_runs ORDER BY id"],
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const write = (line) => controller.enqueue(encoder.encode(`${line}\n`));
        try {
          write(
            JSON.stringify({
              record: "manifest",
              format: "schulcloud-archive-v1",
              exported_at: new Date().toISOString(),
              tables: datasets.map(([name]) => name),
              // Where the bytes are: a directory name, or an object key prefix
              // that includes the scheme and bucket. Each row's storage and
              // object_key columns say the same thing for one blob.
              blobs: storageManifest(storage),
            }),
          );
          for (const [table, query] of datasets) {
            for (const row of db.prepare(query).iterate()) {
              write(JSON.stringify({ record: table, row }));
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    // context.body rather than a bare Response: Hono only carries the
    // middleware headers into what it builds itself, and a file that holds
    // every message in the archive should not be the one response without
    // nosniff and no-store.
    return context.body(stream, 200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": buildContentDisposition("schulcloud-archiv.ndjson"),
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

  // Attachments and avatars, whichever backend holds them. The body is streamed
  // rather than buffered: a 200 MB video should not sit in one array, and the
  // browser shows progress only if bytes start moving before the last one
  // arrives.
  app.get("/media/:hash", async (context) => {
    const hash = context.req.param("hash");
    if (!/^[0-9a-f]{64}$/.test(hash)) return context.json({ error: "Datei nicht gefunden" }, 404);
    const row = db
      .prepare("SELECT hash, storage, object_key, media_type FROM blobs WHERE hash=?")
      .get(hash);
    if (!row) return context.json({ error: "Datei nicht gefunden" }, 404);
    const object = await storage.open(row);
    if (!object) return context.json({ error: "Datei nicht gefunden" }, 404);
    // context.body rather than a bare Response: Hono only merges the middleware
    // headers into what it builds itself, and a body the browser renders must
    // not lose nosniff.
    return context.body(object.body, 200, {
      "Content-Type": row.media_type || "application/octet-stream",
      ...(object.size == null ? {} : { "Content-Length": String(object.size) }),
    });
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

function settingsResponse(db, storage) {
  const counts = blobCounts(db);
  return {
    ...describeSettings(storage.settings, lockedFields()),
    // Where settings.json lives, so the viewer can name the file instead of
    // guessing when the archive is somewhere other than ./archive-data.
    directory: storage.directory,
    counts,
    job: publicStorageJob(),
    warning: switchWarning(storage, counts),
  };
}

/**
 * Says so while blobs are stranded on the way out of S3.
 *
 * Rows keep their own location, so nothing vanishes the moment a switch flips
 * -- but an archive running on the disk would then depend on credentials the
 * operator is in the middle of moving away from. The next time those change,
 * every blob still named 's3' stops being reachable.
 */
function switchWarning(storage, counts) {
  if (storage.backend !== "file" || !counts.s3.count) return null;
  return `${counts.s3.count} Objekte liegen noch in S3. Ziehe sie um, solange die Zugangsdaten gelten; danach sind sie nicht mehr erreichbar.`;
}

function storageManifest(storage) {
  if (storage.backend !== "s3") return "archive-data/blobs/";
  const s3 = storage.settings.s3;
  // Object storage gets a URI rather than a path: there is no directory to point
  // at, and the per-row object_key column says the same thing for one blob.
  return `s3://${s3.bucket}/${s3.prefix || ""}`;
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

// `host` defaults to the loopback interface: a desktop run should not be
// reachable from the network. It is a parameter rather than a constant only
// because a container cannot be entered on 127.0.0.1, so the image passes
// 0.0.0.0 and leaves the port publishing to whoever runs it.
//
// `storage` is the live blob store rather than a directory: it owns the archive
// path (that is where settings.json lives next to the data it describes) and it
// is what the settings routes mutate in place.
export function startServer(db, storage, port = 4317, host = "127.0.0.1") {
  // A wildcard bind is not an address you can visit; print the loopback one.
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return serve(
    { fetch: createApp(db, storage).fetch, hostname: host, port },
    (info) => console.log(`Archiv: http://${shown}:${info.port}`),
  );
}
