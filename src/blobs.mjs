import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function saveBlob(db, directory, bytes, mediaType) {
  const buffer = Buffer.from(bytes);
  const hash = createHash("sha256").update(buffer).digest("hex");
  const folder = join(directory, "blobs", hash.slice(0, 2));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(folder, hash), buffer, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  db.prepare(
    `INSERT OR IGNORE INTO blobs (hash, size_bytes, media_type)
    VALUES (?, ?, ?)`,
  ).run(hash, buffer.length, mediaType || null);
  return hash;
}

export function blobPath(directory, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return join(directory, "blobs", hash.slice(0, 2), hash);
}
