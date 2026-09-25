import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";

async function writeJsonLines(path, rows) {
  const stream = createWriteStream(path, { mode: 0o600 });
  try {
    for (const row of rows) {
      if (!stream.write(`${JSON.stringify(row)}\n`))
        await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export async function exportJson(db, directory) {
  const destination = join(directory, "json-export");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const datasets = [
    ["chats", "SELECT * FROM chats ORDER BY type, id"],
    ["people", "SELECT * FROM people ORDER BY id"],
    [
      "messages",
      "SELECT * FROM messages ORDER BY chat_type, chat_id, created_at, id",
    ],
    ["files", "SELECT * FROM files ORDER BY id"],
    [
      "message_files",
      "SELECT * FROM message_files ORDER BY message_id, file_id",
    ],
    ["blobs", "SELECT * FROM blobs ORDER BY hash"],
  ];
  for (const [name, query] of datasets) {
    await writeJsonLines(
      join(destination, `${name}.jsonl`),
      db.prepare(query).iterate(),
    );
  }
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify(
      {
        format: "schulcloud-archive-v1",
        exported_at: new Date().toISOString(),
        content: datasets.map(([name]) => `${name}.jsonl`),
        blobs: "../blobs/",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return destination;
}
