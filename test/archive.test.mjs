import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { openArchive, saveChat, saveMessage } from "../src/database.mjs";
import { listMessages } from "../src/importer.mjs";
import { repairChatTitles, repairDeletions, repairTimestamps } from "../src/repair.mjs";
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
  // rather than on the totals repairDeletions reports.
  const db = openArchive(directory);
  saveChat(db, "channel", { id: "old", name: "Alt", encrypted: false });
  // An archive written before the columns existed: flags are NULL.
  saveMessage(db, "channel", "old", { id: "a", text: null, deleted: "1705186840" });
  saveMessage(db, "channel", "old", { id: "b", has_file_attached: true, files: [] });
  saveMessage(db, "channel", "old", { id: "c", text: "unverändert" });
  db.prepare("UPDATE messages SET deleted=NULL, attachment_missing=0 WHERE id IN ('a','b','c')").run();

  const result = repairDeletions(db, { log() {} });
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
