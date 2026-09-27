import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import {
  normalizeLinks,
  normalizeReactions,
  openArchive,
  rebuildSearchIndex,
  saveChat,
  saveMessage,
  searchQuery,
} from "../src/database.mjs";
import { listMessages } from "../src/importer.mjs";
import {
  repairChatTitles,
  repairMessageState,
  repairTimestamps,
} from "../src/repair.mjs";
import { importStatus, resetImportState, startImport } from "../src/import-state.mjs";
import { startServer } from "../src/server.mjs";

const directory = await mkdtemp(join(tmpdir(), "schulcloud-archive-test-"));
after(() => rm(directory, { recursive: true, force: true }));

test("pages through an older history without the PDF date limit", async () => {
  const messages = Array.from({ length: 121 }, (_, index) => ({
    id: String(index + 1),
  }));
  const client = {
    async getMessages(_id, _type, { limit, offset }) {
      // The server may impose a smaller page size than requested.
      return messages.slice(offset, offset + Math.min(limit, 30));
    },
  };
  const ids = [];
  for await (const message of listMessages(client, "channel", "old-chat"))
    ids.push(message.id);
  assert.equal(ids.length, 121);
  assert.equal(ids.at(-1), "121");
});

test("flags a repeated API page instead of claiming a complete archive", async () => {
  const page = Array.from({ length: 50 }, (_, index) => ({
    id: String(index),
  }));
  const client = {
    async getMessages() {
      return page;
    },
  };
  await assert.rejects(async () => {
    for await (const _message of listMessages(client, "channel", "stuck")) {
      /* drain */
    }
  }, /wiederholt/);
});

test("normalizes messages once and serves read-only chat JSON", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "7", name: "Alt", encrypted: false });
  const message = {
    id: "42",
    text: "Eine alte Nachricht",
    time: 1620000000,
    sender: { id: "5", first_name: "Ada", last_name: "Lovelace" },
    files: [{ id: "9", name: "plan.pdf", mime: "application/pdf" }],
  };
  saveMessage(db, "channel", "7", message);
  saveMessage(db, "channel", "7", message);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 1);
  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/chats/channel/7/messages`);
    const data = await response.json();
    assert.equal(data.messages[0].text, "Eine alte Nachricht");
    assert.equal(data.messages[0].sender_name, "Ada Lovelace");
    assert.equal(data.messages[0].files[0].name, "plan.pdf");
    const summary = await fetch(`${base}/api/summary`);
    assert.equal((await summary.json()).messages, 1);
    const exportResponse = await fetch(`${base}/api/chats/channel/7/export`);
    assert.equal((await exportResponse.json()).messages.length, 1);
    const viewer = await fetch(base);
    assert.equal(viewer.status, 200);
    assert.match(await viewer.text(), /Schulcloud Archiv/);
    assert.match(viewer.headers.get("content-security-policy"), /default-src 'none'/);
    const favicon = await fetch(`${base}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
    assert.match(await favicon.text(), /<svg/);
    assert.equal((await fetch(`${base}/assets/nope.svg`)).status, 404);
    const write = await fetch(`${base}/api/chats`, { method: "POST" });
    assert.equal(write.status, 405);
  } finally {
    server.close();
    db.close();
  }
});

test("prefers absolute created_at timestamps over relative time fields", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "8", name: "Zeit", encrypted: false });
  saveMessage(db, "channel", "8", {
    id: "43",
    text: "Zeitstempel",
    created_at: "2024-01-02T03:04:05.000Z",
    time: 88,
    micro_time: 88000000,
  });
  const row = db.prepare("SELECT created_at FROM messages WHERE id=?").get("43");
  assert.equal(row.created_at, "2024-01-02T03:04:05.000Z");
  db.close();
});

test("reads stashcat micro_time as unix seconds, not microseconds", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "micro", name: "Mikrozeit", encrypted: false });
  // Shape taken verbatim from a real api.stashcat.com response.
  saveMessage(db, "channel", "micro", {
    id: "44",
    text: "Mit Mikrosekunden",
    time: "1782042438",
    micro_time: "1782042438.732",
  });
  const row = db.prepare("SELECT created_at FROM messages WHERE id=?").get("44");
  assert.equal(row.created_at, "2026-06-21T11:47:18.732Z");
  db.close();
});

test("falls back to whole-second time and rejects implausible units", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "fallback", name: "Fallback", encrypted: false });
  saveMessage(db, "channel", "fallback", { id: "45", time: "1782042438" });
  assert.equal(
    db.prepare("SELECT created_at FROM messages WHERE id=?").get("45").created_at,
    "2026-06-21T11:47:18.000Z",
  );
  // A value that only makes sense as milliseconds would land in the 16th
  // century once multiplied by 1000, so it must be discarded instead of stored.
  saveMessage(db, "channel", "fallback", { id: "46", micro_time: "94668480000000" });
  assert.equal(
    db.prepare("SELECT created_at FROM messages WHERE id=?").get("46").created_at,
    null,
  );
  db.close();
});

test("repairs archived timestamps from the preserved API response", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "repair", name: "Reparatur", encrypted: false });
  const original = {
    id: "47",
    text: "Alte Zeit",
    time: "1782042438",
    micro_time: "1782042438.732",
  };
  saveMessage(db, "channel", "repair", original);
  // Simulate the archive written by the buggy unit conversion.
  db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(
    "1970-01-01T00:29:42.042Z",
    "47",
  );

  const result = repairTimestamps(db, { log() {} });
  assert.equal(result.changed, 1);
  assert.equal(
    db.prepare("SELECT created_at FROM messages WHERE id=?").get("47").created_at,
    "2026-06-21T11:47:18.732Z",
  );
  // A second run has nothing left to do.
  assert.equal(repairTimestamps(db, { log() {} }).changed, 0);
  db.close();
});

test("titles conversations from the members list the API actually sends", async () => {
  const db = openArchive(directory);
  // Shape taken from a real api.stashcat.com conversation response: the
  // participants arrive as `members`, and the owner is not among them.
  saveChat(
    db,
    "conversation",
    {
      id: "members",
      user_count: 4,
      members: [
        { id: "1", first_name: "Christopher", last_name: "Kern" },
        { id: "2", first_name: "Katharina", last_name: "Fechner" },
        { id: "3", first_name: "Florian", last_name: "Baumert" },
      ],
    },
    false,
    "9",
  );
  assert.equal(
    db.prepare("SELECT title FROM chats WHERE type='conversation' AND id='members'").get().title,
    "Christopher Kern, Katharina Fechner, Florian Baumert",
  );

  // A one-to-one chat collapses to the other person's name.
  saveChat(
    db,
    "conversation",
    { id: "dm", user_count: 2, members: [{ id: "2", first_name: "Tobias", last_name: "Lukaschewitz" }] },
    false,
    "9",
  );
  assert.equal(
    db.prepare("SELECT title FROM chats WHERE type='conversation' AND id='dm'").get().title,
    "Tobias Lukaschewitz",
  );
  db.close();
});

test("keeps a renamed conversation and tolerates a missing member list", async () => {
  const db = openArchive(directory);
  saveChat(db, "conversation", { id: "renamed", name: "Elternabend", members: [{ id: "2", first_name: "X", last_name: "Y" }] }, false, "9");
  assert.equal(
    db.prepare("SELECT title FROM chats WHERE type='conversation' AND id='renamed'").get().title,
    "Elternabend",
  );
  // No members at all: fall back to the id rather than inventing a name.
  saveChat(db, "conversation", { id: "empty" }, false, "9");
  assert.equal(
    db.prepare("SELECT title FROM chats WHERE type='conversation' AND id='empty'").get().title,
    "Konversation empty",
  );
  // A deleted member keeps the "Nutzer <id>" label used for message senders.
  saveChat(
    db,
    "conversation",
    { id: "deleted", members: [{ id: "2", first_name: null, last_name: null, deleted: "1782999466" }] },
    false,
    "9",
  );
  assert.equal(
    db.prepare("SELECT title FROM chats WHERE type='conversation' AND id='deleted'").get().title,
    "Nutzer 2",
  );
  db.close();
});

test("repairs placeholder conversation titles from the stored response", async () => {
  const db = openArchive(directory);
  db.prepare("INSERT INTO metadata (key, value) VALUES ('own_user_id', '9')").run();
  saveChat(
    db,
    "conversation",
    { id: "stale", members: [{ id: "2", first_name: "Katharina", last_name: "Fechner" }] },
    false,
    "9",
  );
  db.prepare("UPDATE chats SET title=? WHERE type='conversation' AND id='stale'").run(
    "Konversation stale",
  );

  const result = repairChatTitles(db, { log() {} });
  assert.equal(result.changed, 1);
  assert.equal(
    db.prepare("SELECT title FROM chats WHERE type='conversation' AND id='stale'").get().title,
    "Katharina Fechner",
  );
  // Idempotent, and a user-set name is never overwritten.
  assert.equal(repairChatTitles(db, { log() {} }).changed, 0);
  db.prepare("UPDATE chats SET title=? WHERE type='conversation' AND id='stale'").run("Elternabend");
  assert.equal(repairChatTitles(db, { log() {} }).changed, 0);
  assert.equal(
    db.prepare("SELECT title FROM chats WHERE type='conversation' AND id='stale'").get().title,
    "Elternabend",
  );
  db.close();
});

test("records deleted messages, missing attachments and deleted accounts", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "gaps", name: "Lücken", encrypted: false });
  saveMessage(db, "channel", "gaps", {
    id: "gone",
    text: null,
    deleted: "1782824371",
    sender: { id: "5", first_name: "Ada", last_name: "Lovelace" },
  });
  saveMessage(db, "channel", "gaps", {
    id: "no-file",
    has_file_attached: true,
    files: [],
    sender: { id: "6", first_name: "Grace", last_name: "Hopper", deleted: "1705186840" },
  });
  saveMessage(db, "channel", "gaps", {
    id: "intact",
    text: "Alles gut",
    files: [{ id: "9", name: "plan.pdf" }],
    sender: { id: "7", first_name: "Alan", last_name: "Turing" },
  });

  const read = (id) => db.prepare("SELECT deleted, attachment_missing FROM messages WHERE id=?").get(id);
  assert.equal(read("gone").deleted, "1782824371");
  assert.equal(read("gone").attachment_missing, 0);
  // Advertised as attached but the API shipped no metadata: an import gap.
  assert.equal(read("no-file").attachment_missing, 1);
  assert.equal(read("no-file").deleted, null);
  assert.equal(read("intact").attachment_missing, 0);

  assert.equal(
    db.prepare("SELECT deleted FROM people WHERE id=?").get("6").deleted,
    "1705186840",
  );
  assert.equal(db.prepare("SELECT deleted FROM people WHERE id=?").get("7").deleted, null);
  db.close();
});

test("backfills deletion flags from the stored response", async () => {
  // This file shares one temp archive, so assert on the rows created here
  // rather than on the totals repairMessageState reports.
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "old", name: "Alt", encrypted: false });
  // An archive written before the columns existed: flags are NULL.
  saveMessage(db, "channel", "old", { id: "a", text: null, deleted: "1705186840" });
  saveMessage(db, "channel", "old", { id: "b", has_file_attached: true, files: [] });
  saveMessage(db, "channel", "old", { id: "c", text: "unverändert" });
  db.prepare("UPDATE messages SET deleted=NULL, attachment_missing=0 WHERE id IN ('a','b','c')").run();

  const result = repairMessageState(db, { log() {} });
  assert.ok(result.deletedMessages >= 1);
  assert.ok(result.missingAttachments >= 1);
  const flag = (id) => db.prepare("SELECT deleted, attachment_missing FROM messages WHERE id=?").get(id);
  assert.equal(flag("a").deleted, "1705186840");
  assert.equal(flag("a").attachment_missing, 0);
  assert.equal(flag("b").deleted, null);
  assert.equal(flag("b").attachment_missing, 1);
  // A normal message must stay untouched.
  assert.equal(flag("c").deleted, null);
  assert.equal(flag("c").attachment_missing, 0);
  db.close();
});

test("adds the deletion columns to a database created by an older version", async () => {
  const legacy = await mkdtemp(join(tmpdir(), "schulcloud-legacy-"));
  const path = join(legacy, "archive.sqlite");
  const old = new DatabaseSync(path);
  // The schema as it looked before the deleted-state columns were added.
  old.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      avatar_hash TEXT, raw_json TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_type TEXT NOT NULL,
      chat_id TEXT NOT NULL, sender_id TEXT, text TEXT, created_at TEXT, kind TEXT,
      reply_to_id TEXT, decryption_state TEXT NOT NULL, raw_json TEXT NOT NULL);`);
  old.close();

  const db = openArchive(legacy);
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(columns("people").includes("deleted"), "people.deleted added");
  assert.ok(columns("messages").includes("deleted"), "messages.deleted added");
  assert.ok(columns("messages").includes("attachment_missing"), "messages.attachment_missing added");
  // Re-opening must not fail or duplicate the columns.
  db.close();
  const again = openArchive(legacy);
  assert.equal(
    again.prepare("PRAGMA table_info(messages)").all().filter((c) => c.name === "deleted").length,
    1,
  );
  again.close();
  await rm(legacy, { recursive: true, force: true });
});

test("serves deletion state and names deleted accounts honestly", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "api-gaps", name: "API", encrypted: false });
  saveMessage(db, "channel", "api-gaps", {
    id: "d1",
    text: null,
    deleted: "1705186840",
    sender: { id: "11", first_name: "Ada", last_name: "Lovelace" },
  });
  saveMessage(db, "channel", "api-gaps", {
    id: "d2",
    text: "Hallo",
    sender: { id: "12", deleted: "1705186840" },
  });
  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/api/chats/channel/api-gaps/messages`)).json();
    const [first, second] = page.messages;
    assert.equal(first.deleted, true);
    assert.equal(first.attachment_missing, false);
    // The sender of the first message still has a name.
    assert.equal(first.sender_name, "Ada Lovelace");
    assert.equal(first.sender_deleted, false);
    // The second sender's account was deleted, so no name is recoverable.
    assert.equal(second.sender_deleted, true);
    assert.equal(second.sender_name, "Gelöschtes Konto");
  } finally {
    server.close();
    db.close();
  }
});

test("keeps the archive read-only and only allows a guarded import trigger", async () => {
  const db = openArchive(directory);
  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, init = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      ...init,
    });
  try {
    // Everything that is not the import trigger stays read-only.
    for (const path of ["/api/chats", "/api/summary", "/api/chats/7/messages"]) {
      assert.equal((await post(path)).status, 405, `${path} must reject writes`);
    }
    assert.equal((await post("/api/import/../chats")).status, 405);

    // The import routes answer, but a write without JSON is refused: a
    // cross-origin form cannot set that content type, and a cross-origin
    // fetch would need a preflight this server never answers.
    assert.equal((await post("/api/import", { headers: {} })).status, 415);
    assert.equal(
      (
        await post("/api/import", {
          headers: { "content-type": "text/plain" },
        })
      ).status,
      415,
    );
    // No credentials anywhere -> a clear 400 rather than a stack trace.
    const missing = await post("/api/import");
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /SCHULCLOUD_EMAIL|Zugangsdaten/);

    // Reading the state stays a GET and is always available.
    const state = await fetch(`${base}/api/import`);
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.running, false);
    assert.equal(body.status, "idle");
  } finally {
    server.close();
    db.close();
  }
});

test("rejects import triggers that did not come from this machine", async () => {
  const db = openArchive(directory);
  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const port = server.address().port;
  // fetch silently drops `host` -- it is a forbidden header name -- so this has
  // to be a raw request for the check to mean anything.
  const raw = (host) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/import",
          method: "POST",
          headers: { host, "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end("{}");
    });
  try {
    // A remote page can point a name it controls at 127.0.0.1, so the Host
    // header -- not the socket -- is what proves the caller meant this viewer.
    assert.equal(await raw("attacker.example.com"), 403);
    assert.equal(await raw("127.0.0.1.attacker.example"), 403);
    // Local names are allowed through to the handler, which then rejects the
    // request for having no credentials.
    assert.equal(await raw("localhost"), 400);
    assert.equal(await raw(`127.0.0.1:${port}`), 400);
  } finally {
    server.close();
    db.close();
  }
});

test("runs at most one import at a time", async () => {
  resetImportState();
  const db = openArchive(directory);
  // No credentials and no env: the attempt must fail before any network work.
  await assert.rejects(() => startImport(db, directory, null), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
  // Fake credentials get past validation, so the second call has to collide.
  process.env.SCHULCLOUD_EMAIL = "a@example.org";
  process.env.SCHULCLOUD_PASSWORD = "x";
  process.env.SCHULCLOUD_SECURITY_PASSWORD = "y";
  const first = startImport(db, directory, null).catch(() => {});
  try {
    assert.equal(importStatus().status, "running");
    const second = await startImport(db, directory, null).then(
      () => null,
      (error) => error,
    );
    assert.equal(second?.status, 409);
  } finally {
    delete process.env.SCHULCLOUD_EMAIL;
    delete process.env.SCHULCLOUD_PASSWORD;
    delete process.env.SCHULCLOUD_SECURITY_PASSWORD;
    resetImportState();
    db.close();
  }
});

test("normalises reactions and drops unusable entries", async () => {
  assert.deepEqual(normalizeReactions(undefined), null);
  assert.deepEqual(normalizeReactions([]), null);
  // The wire shape is {emoji, num_reactions}, not a count field.
  assert.deepEqual(
    normalizeReactions([{ emoji: "👍", num_reactions: 7 }]),
    [{ emoji: "👍", count: 7 }],
  );
  // Busiest first.
  assert.deepEqual(
    normalizeReactions([
      { emoji: "🎉", num_reactions: 2 },
      { emoji: "👍", num_reactions: 30 },
    ]),
    [
      { emoji: "👍", count: 30 },
      { emoji: "🎉", count: 2 },
    ],
  );
  // Duplicate emoji merge rather than showing two pills for one glyph.
  assert.deepEqual(
    normalizeReactions([
      { emoji: "👍", num_reactions: 3 },
      { emoji: "👍", num_reactions: 4 },
    ]),
    [{ emoji: "👍", count: 7 }],
  );
  // Junk must not reach the UI, where it would render an uncounted pill.
  assert.deepEqual(
    normalizeReactions([
      { emoji: "", num_reactions: 5 },
      { emoji: "👍", num_reactions: 0 },
      { emoji: "👍", num_reactions: "many" },
      { num_reactions: 5 },
      null,
      { emoji: "✅", num_reactions: 1.7 },
    ]),
    [{ emoji: "✅", count: 1 }],
  );
});

test("stores reactions on import and backfills them from the response", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "react", name: "Reaktionen", encrypted: false });
  saveMessage(db, "channel", "react", {
    id: "r1",
    text: "Da",
    reactions: [{ emoji: "👍", num_reactions: 12 }],
  });
  saveMessage(db, "channel", "react", { id: "r2", text: "Ohne" });
  const read = (id) => db.prepare("SELECT reactions FROM messages WHERE id=?").get(id).reactions;
  assert.equal(read("r1"), JSON.stringify([{ emoji: "👍", count: 12 }]));
  assert.equal(read("r2"), null);

  // A pre-reactions archive has NULL, and the repair recovers it from raw_json.
  db.prepare("UPDATE messages SET reactions=NULL WHERE id='r1'").run();
  const result = repairMessageState(db, { log() {} });
  assert.equal(result.withReactions, 1);
  assert.equal(result.reactionCount, 12);
  assert.equal(read("r1"), JSON.stringify([{ emoji: "👍", count: 12 }]));

  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (
      await fetch(`${base}/api/chats/channel/react/messages`)
    ).json();
    const withReaction = page.messages.find((m) => m.id === "r1");
    const without = page.messages.find((m) => m.id === "r2");
    assert.deepEqual(withReaction.reactions, [{ emoji: "👍", count: 12 }]);
    // Never null: the UI maps over it unconditionally.
    assert.deepEqual(without.reactions, []);
  } finally {
    server.close();
    db.close();
  }
});

test("turns user input into a safe FTS5 match expression", () => {
  // Every token is quoted and ANDed, so FTS5 syntax in the input is inert
  // rather than a parse error.
  assert.equal(searchQuery("Fahrrad"), '"Fahrrad"*');
  assert.equal(searchQuery("Fahrrad Aktionstag"), '"Fahrrad" AND "Aktionstag"*');
  // The prefix goes on the last searchable word, so a trailing "-" is dropped
  // and "NEAR" keeps its prefix match.
  assert.equal(searchQuery('" OR NEAR -'), '"OR" AND "NEAR"*');
  assert.equal(searchQuery("a* b"), '"a" AND "b"*');
  // Punctuation separates words instead of gluing them together.
  assert.equal(searchQuery("Fahrrad,ORT"), '"Fahrrad" AND "ORT"*');
  assert.equal(searchQuery("Hallo.Welt"), '"Hallo" AND "Welt"*');
  // Nothing searchable left after stripping.
  assert.equal(searchQuery(""), null);
  assert.equal(searchQuery("   "), null);
  assert.equal(searchQuery("-"), null);
  assert.equal(searchQuery('"*()'), null);
  assert.equal(searchQuery(undefined), null);
});

test("indexes message bodies and finds them again", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "fts", name: "Suche", encrypted: false });
  saveMessage(db, "channel", "fts", { id: "s1", text: "Fahrrad Aktionstag am Foyer" });
  saveMessage(db, "channel", "fts", { id: "s2", text: "Unicef Spendenlauf" });
  saveMessage(db, "channel", "fts", { id: "s3", text: null });
  saveMessage(db, "channel", "fts", { id: "s4", text: "Rückgabe der Lehrwerke" });

  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const hit = await (await fetch(`${base}/api/search?q=Fahrrad`)).json();
    assert.equal(hit.results.length, 1);
    assert.equal(hit.results[0].id, "s1");
    assert.equal(hit.results[0].chat_title, "Suche");
    // Matches come back wrapped in control sentinels, never HTML.
    assert.match(hit.results[0].snippet, /\u0001Fahrrad\u0002/);
    assert.doesNotMatch(hit.results[0].snippet, /<[a-z]/i);

    // Both terms must be present.
    assert.equal(
      (await (await fetch(`${base}/api/search?q=${encodeURIComponent("Fahrrad Aktionstag")}`)).json()).results.length,
      1,
    );
    assert.equal(
      (await (await fetch(`${base}/api/search?q=${encodeURIComponent("Fahrrad Unicef")}`)).json()).results.length,
      0,
    );
    // unicode61 folds accents, so "Ruckgabe" finds "Rückgabe" and a prefix of
    // the folded form matches too. It does not expand to the German ue/oe/ss
    // spelling, so "rueckgabe" finds nothing.
    for (const [q, expected] of [
      ["R%C3%BCckgabe", 1],
      ["Ruckgabe", 1],
      ["Ruckg", 1],
      ["rueckgabe", 0],
    ]) {
      assert.equal(
        (await (await fetch(`${base}/api/search?q=${q}`)).json()).results.length,
        expected,
        `q=${q}`,
      );
    }
    // Hostile and empty input must not 500.
    for (const q of ['"><img src=x>', "NEAR(", "*", ""]) {
      const response = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(response.status, 200, `q=${q}`);
    }

    // Re-saving a message must update the index, not duplicate or orphan it.
    saveMessage(db, "channel", "fts", { id: "s1", text: "Fahrrad, jetzt in der Turnhalle" });
    assert.equal(
      (await (await fetch(`${base}/api/search?q=Turnhalle`)).json()).results.length,
      1,
    );
    // The previous text is gone from the index, not merely superseded.
    assert.equal(
      (await (await fetch(`${base}/api/search?q=Aktionstag`)).json())
        .results.filter((r) => r.id === "s1").length,
      0,
    );
  } finally {
    server.close();
    db.close();
  }
});

test("rebuilds the search index for archives created before it existed", async () => {
  const legacy = await mkdtemp(join(tmpdir(), "schulcloud-fts-"));
  const db = openArchive(legacy);
  db.prepare("INSERT INTO chats (type, id, title, raw_json) VALUES ('channel','old','Alt','{}')").run();
  // Written with the index triggers disabled, as if the table predates them.
  db.exec("DROP TRIGGER messages_fts_insert");
  db.prepare("INSERT INTO messages (id, chat_type, chat_id, text, decryption_state, raw_json) VALUES ('o1','channel','old','Fahrrad Aktionstag','plain','{}')").run();
  db.exec("CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, coalesce(new.text, '')); END");
  // An external-content FTS table reads count(*) from the content table, so
  // ask the index itself whether the row is findable.
  const indexed = () =>
    db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Fahrrad'").get().n;
  assert.equal(indexed(), 0);

  assert.equal(rebuildSearchIndex(db), 1);
  assert.equal(indexed(), 1);
  const server = startServer(db, legacy, 0);
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/search?q=Fahrrad`,
    );
    assert.equal((await response.json()).results.length, 1);
  } finally {
    server.close();
    db.close();
    await rm(legacy, { recursive: true, force: true });
  }
});

test("normalises link previews and refuses unsafe urls", () => {
  assert.equal(normalizeLinks(undefined), null);
  assert.equal(normalizeLinks([]), null);
  // Titles come back from the unfurler with stray tabs and newlines.
  assert.deepEqual(
    normalizeLinks([{ url: "https://a.test/x", title: "\n\tNextcloud\t" }]),
    [{ url: "https://a.test/x", title: "Nextcloud" }],
  );
  // No usable title falls back to the host, without the www prefix.
  assert.deepEqual(
    normalizeLinks([{ url: "https://www.a.test/x", title: "   " }]),
    [{ url: "https://www.a.test/x", title: "a.test" }],
  );
  // These become clickable links, so a script URL must never survive.
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(normalizeLinks([{ url, title: "x" }]), null, url);
  }
  // requested_url is the fallback when url is absent.
  assert.deepEqual(
    normalizeLinks([{ requested_url: "https://b.test/y", title: "B" }]),
    [{ url: "https://b.test/y", title: "B" }],
  );
  // Same url twice is one card.
  assert.deepEqual(
    normalizeLinks([
      { url: "https://c.test/z", title: "C" },
      { url: "https://c.test/z", title: "C again" },
    ]),
    [{ url: "https://c.test/z", title: "C" }],
  );
  // The preview image is dropped, never carried into the viewer.
  const [only] = normalizeLinks([
    { url: "https://d.test/i", title: "D", image: "https://tracker.test/p.png" },
  ]);
  assert.equal("image" in only, false);
});

test("stores link previews and backfills them from the response", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "links", name: "Links", encrypted: false });
  saveMessage(db, "channel", "links", {
    id: "l1",
    text: "Siehe dazu",
    links: [
      { url: "https://example.org/angebot", title: "Angebot", description: "Kurzfassung" },
      { url: "javascript:alert(1)", title: "böse" },
    ],
  });
  saveMessage(db, "channel", "links", { id: "l2", text: "Ohne Link" });
  const read = (id) => db.prepare("SELECT links FROM messages WHERE id=?").get(id).links;
  assert.deepEqual(JSON.parse(read("l1")), [
    { url: "https://example.org/angebot", title: "Angebot", description: "Kurzfassung" },
  ]);
  assert.equal(read("l2"), null);

  db.prepare("UPDATE messages SET links=NULL WHERE id='l1'").run();
  const result = repairMessageState(db, { log() {} });
  assert.equal(result.withLinks, 1);
  assert.equal(result.linkCount, 1);
  assert.equal(JSON.parse(read("l1")).length, 1);

  const server = startServer(db, directory, 0);
  await once(server, "listening");
  try {
    const page = await (
      await fetch(`http://127.0.0.1:${server.address().port}/api/chats/channel/links/messages`)
    ).json();
    const withLink = page.messages.find((m) => m.id === "l1");
    const without = page.messages.find((m) => m.id === "l2");
    assert.equal(withLink.links.length, 1);
    assert.equal(withLink.links[0].url, "https://example.org/angebot");
    // Never null: the component maps over it unconditionally.
    assert.deepEqual(without.links, []);
  } finally {
    server.close();
    db.close();
  }
});

test("opens a window of messages around a requested date", async () => {
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "jump", name: "Sprung", encrypted: false });
  // Three messages a month apart, so a window is guaranteed to exist.
  const days = ["2021-01-10", "2021-02-10", "2021-03-10", "2021-04-10", "2021-05-10"];
  for (const [index, day] of days.entries()) {
    saveMessage(db, "channel", "jump", {
      // ids are the primary key of messages, so they must be unique across
      // this whole file, not just within this chat.
      id: `jump-${index}`,
      text: `Tag ${day}`,
      time: String(Date.parse(`${day}T10:00:00Z`) / 1000),
      sender: { id: "5", first_name: "Ada", last_name: "Lovelace" },
    });
  }
  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const around = (date) =>
    fetch(`${base}/api/chats/channel/jump/around?date=${date}`).then((r) =>
      r.json().then((body) => ({ status: r.status, body })),
    );
  try {
    // The requested day has to be inside the window, not merely near it.
    const { body } = await around("2021-02-15");
    const texts = body.messages.map((m) => m.text);
    assert.ok(texts.includes("Tag 2021-02-10"), JSON.stringify(texts));
    assert.ok(texts.includes("Tag 2021-01-10"), "context before the target");
    // Still ascending, as the timeline expects.
    assert.deepEqual(
      body.messages.map((m) => m.created_at),
      [...body.messages.map((m) => m.created_at)].sort(),
    );
    assert.equal(body.chat.title, "Sprung");

    // A day before the chat existed falls back to the first message rather
    // than returning nothing.
    const early = await around("2019-01-01");
    assert.equal(early.body.messages[0].text, "Tag 2021-01-10");
    // And a day after it ends with the last message.
    const late = await around("2030-01-01");
    assert.equal(late.body.messages.at(-1).text, "Tag 2021-05-10");

    assert.equal((await around("nonsense")).status, 400);
    assert.equal((await around("")).status, 400);
    assert.equal(
      (await fetch(`${base}/api/chats/channel/missing/around?date=2021-01-01`)).status,
      404,
    );
  } finally {
    server.close();
    db.close();
  }
});

test("loads older messages even when timestamps are missing", async () => {
  const db = openArchive(directory);
  saveChat(db, "conversation", { id: "missing-date", name: "Alt" });
  for (const id of ["1", "2", "3"]) {
    saveMessage(db, "conversation", "missing-date", {
      id: `missing-${id}`,
      text: id,
    });
  }
  const server = startServer(db, directory, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(
      `${base}/api/chats/conversation/missing-date/messages?limit=2`,
    );
    const firstPage = (await first.json()).messages;
    assert.equal(firstPage.length, 2);
    const cursor = firstPage[0];
    const older = await fetch(
      `${base}/api/chats/conversation/missing-date/messages?limit=2&before=&before_id=${cursor.id}`,
    );
    const olderPage = (await older.json()).messages;
    assert.equal(olderPage.length, 1);
    assert.notEqual(olderPage[0].id, cursor.id);
  } finally {
    server.close();
    db.close();
  }
});
