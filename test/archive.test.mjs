import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openArchive, saveChat, saveMessage } from "../src/database.mjs";
import { listMessages } from "../src/importer.mjs";
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
    const write = await fetch(`${base}/api/chats`, { method: "POST" });
    assert.equal(write.status, 405);
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
