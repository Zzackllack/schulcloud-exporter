import { saveBlob } from "./blobs.mjs";

function imageUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value, "https://api.stashcat.com/");
    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "schul.cloud" ||
        url.hostname.endsWith(".schul.cloud") ||
        url.hostname === "stashcat.com" ||
        url.hostname.endsWith(".stashcat.com")
      )
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function fetchImage(value) {
  const url = imageUrl(value);
  if (!url) return null;
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  const mediaType = response.headers.get("content-type")?.split(";")[0];
  const length = Number(response.headers.get("content-length"));
  if (!mediaType?.startsWith("image/") || length > 5_000_000) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 5_000_000) return null;
  return { bytes, mediaType };
}

export async function importAvatars(db, directory, client, output = console) {
  const people = db
    .prepare("SELECT id FROM people WHERE avatar_hash IS NULL")
    .all();
  for (const person of people) {
    try {
      const user = await client.getUserInfo(person.id, false);
      db.prepare(`UPDATE people SET display_name=?, raw_json=? WHERE id=?`).run(
        [user.first_name, user.last_name].filter(Boolean).join(" ") ||
          `Nutzer ${person.id}`,
        JSON.stringify(user),
        person.id,
      );
      const image = await fetchImage(user.image || user.avatar);
      if (!image) continue;
      const hash = await saveBlob(db, directory, image.bytes, image.mediaType);
      db.prepare("UPDATE people SET avatar_hash=? WHERE id=?").run(
        hash,
        person.id,
      );
    } catch {
      // Deleted accounts and inaccessible profile images are common in old chats.
      output.log(`Profil ${person.id}: Bild nicht verfügbar`);
    }
  }
  const chats = db
    .prepare("SELECT type, id, raw_json FROM chats WHERE avatar_hash IS NULL")
    .all();
  const ownId = db
    .prepare("SELECT value FROM metadata WHERE key='own_user_id'")
    .get()?.value;
  for (const chat of chats) {
    try {
      const raw = JSON.parse(chat.raw_json);
      if (chat.type === "conversation" && Array.isArray(raw.participants)) {
        const others = raw.participants.filter(
          (entry) =>
            String(entry.user?.id || entry.user_id || entry.id) !== ownId,
        );
        if (others.length === 1) {
          const otherId = String(
            others[0].user?.id || others[0].user_id || others[0].id,
          );
          const avatar = db
            .prepare("SELECT avatar_hash FROM people WHERE id=?")
            .get(otherId)?.avatar_hash;
          if (avatar) {
            db.prepare(
              "UPDATE chats SET avatar_hash=? WHERE type=? AND id=?",
            ).run(avatar, chat.type, chat.id);
            continue;
          }
        }
      }
      const image = await fetchImage(raw.image);
      if (!image) continue;
      const hash = await saveBlob(db, directory, image.bytes, image.mediaType);
      db.prepare("UPDATE chats SET avatar_hash=? WHERE type=? AND id=?").run(
        hash,
        chat.type,
        chat.id,
      );
    } catch {
      // The chat remains usable without its icon.
    }
  }
}
