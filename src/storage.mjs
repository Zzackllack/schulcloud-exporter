import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { BACKENDS, normalizeS3 } from "./settings.mjs";

/**
 * Blob storage: two backends behind one interface, and a record of which one
 * holds each blob.
 *
 * The bytes are content-addressed by SHA-256, which is what makes the backend
 * switch safe to make at any time: a hash means the same thing on disk and in a
 * bucket, so a blob can be copied between them without renaming anything, and
 * two rows can share one blob without the copy being visible.
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Local disk: `archive-data/blobs/<first byte>/<hash>`, 0600. */
export function createFileStore(directory) {
  const root = join(directory, "blobs");
  const pathFor = (hash) => join(root, hash.slice(0, 2), hash);

  return {
    name: "file",
    locationKey: () => null,
    async put(hash, bytes) {
      const folder = join(root, hash.slice(0, 2));
      await mkdir(folder, { recursive: true, mode: 0o700 });
      try {
        await writeFile(pathFor(hash), bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        // A second attachment with the same hash is the same bytes; the flag
        // keeps a partial write from being clobbered mid-import.
        if (error.code !== "EEXIST") throw error;
      }
      return { storage: "file", key: null };
    },
    async open(row) {
      const path = pathFor(row.hash);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return null;
      return {
        body: Readable.toWeb(createReadStream(path)),
        size: info.size,
      };
    },
    async has(hash) {
      return Boolean(await stat(pathFor(hash)).catch(() => null));
    },
  };
}

/**
 * S3 and everything that speaks the same REST API: AWS, MinIO, Wasabi,
 * Backblaze B2, Cloudflare R2, Hetzner, Scaleway.
 *
 * `client` is a parameter only so a test can hand in a stub; nothing else in
 * this file needs it.
 */
export function createS3Store(config, client = null) {
  const s3 = normalizeS3(config);
  if (!s3.bucket) {
    throw new Error("S3-Bucket fehlt; gespeicherte Objekte sind nicht erreichbar.");
  }
  const client_ = client ?? new S3Client({
    region: s3.region || "us-east-1",
    // Without an endpoint the SDK derives the regional AWS one, which is what
    // "just my bucket" should mean.
    endpoint: s3.endpoint || undefined,
    // MinIO and the smaller providers are path-style only; AWS and most others
    // are virtual-host. Getting this wrong fails as a 404 on every object.
    forcePathStyle: s3.pathStyle,
    credentials: {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
    // AWS wants a checksum header on upload; a good half of the compatible
    // providers answer with a hard error when they see one. Sending it only
    // when the endpoint demands it is what makes both work.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
  });
  const keyFor = (hash) => `${s3.prefix}blobs/${hash.slice(0, 2)}/${hash}`;

  return {
    name: "s3",
    bucket: s3.bucket,
    keyFor,
    locationKey: keyFor,
    client: client_,
    async put(hash, bytes, mediaType) {
      await client_.send(
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: keyFor(hash),
          Body: bytes,
          ContentType: mediaType || undefined,
          ContentLength: bytes.length,
        }),
      );
      return { storage: "s3", key: keyFor(hash) };
    },
    async open(row) {
      const out = await client_.send(
        new GetObjectCommand({
          Bucket: s3.bucket,
          // The recorded key wins over the derived one: it is what keeps
          // objects readable after the prefix changes.
          Key: row.object_key || keyFor(row.hash),
        }),
      );
      if (!out.Body) return null;
      return {
        body: Readable.toWeb(out.Body),
        size: out.ContentLength,
      };
    },
    async has(hash) {
      try {
        await client_.send(
          new HeadObjectCommand({ Bucket: s3.bucket, Key: keyFor(hash) }),
        );
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    /** Cheap reachability probe for the settings dialog: one listing call. */
    async probe() {
      const out = await client_.send(
        new ListObjectsV2Command({
          Bucket: s3.bucket,
          Prefix: s3.prefix || undefined,
          MaxKeys: 1,
        }),
      );
      return out.$metadata?.httpStatusCode ?? 200;
    },
  };
}

// A missing object is a 404 with one of three names, depending on which of the
// two key paths reported it. Anything else -- bad credentials, no such bucket,
// a dead endpoint -- is a real error and must not be read as "absent".
function isMissing(error) {
  return error?.name === "NoSuchKey" || error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;
}

/**
 * The archive's view of blob storage for the lifetime of the process.
 *
 * One object, mutated rather than replaced: the importer, the media route and
 * the settings route all hold this reference, so saving new settings has to
 * change what it returns without anything re-reading a stale constant. Rebuilt
 * S3 clients are cached by configuration, because a client caches credentials
 * and a revoked key would otherwise keep signing valid requests.
 */
export function createBlobStorage(settings, directory) {
  const file = createFileStore(directory);
  let current = settings;
  let cachedConfig = null;
  let cachedStore = null;

  function remote() {
    const signature = JSON.stringify(current.s3);
    if (cachedConfig !== signature) {
      cachedConfig = signature;
      cachedStore = createS3Store(current.s3);
    }
    return cachedStore;
  }

  const storage = {
    name: "blobs",
    directory,
    file,
    get settings() {
      return current;
    },
    get backend() {
      return current.backend;
    },
    reconfigure(next) {
      current = next;
    },
    /** S3 access for a migration, which may run before the switch flips. */
    requireRemote() {
      return remote();
    },
    async put(hash, bytes, mediaType) {
      return (current.backend === "s3" ? remote() : file).put(hash, bytes, mediaType);
    },
    /**
     * Reads a blob from wherever its row says it is, which is the one thing
     * that makes a half-migrated archive still work: old rows keep pointing at
     * the disk while new ones point at the bucket.
     */
    async open(row) {
      if (!HASH_PATTERN.test(row.hash)) return null;
      const store = row.storage === "s3" ? remote() : row.storage === "file" ? file : null;
      if (!store) return null;
      try {
        return await store.open(row);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async has(hash, location) {
      const store = location === "s3" ? remote() : file;
      return store.has(hash);
    },
  };
  return storage;
}

/**
 * Stores a blob and records where it landed.
 *
 * The row is upserted rather than inserted: a row from before the storage
 * columns existed has storage='file' and no key, and a re-import that now
 * writes to S3 must move that row with it.
 */
export async function saveBlob(db, storage, bytes, mediaType) {
  const buffer = Buffer.from(bytes);
  const hash = createHash("sha256").update(buffer).digest("hex");
  const location = await storage.put(hash, buffer, mediaType);
  db.prepare(
    `INSERT INTO blobs (hash, size_bytes, media_type, storage, object_key)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       size_bytes=excluded.size_bytes, media_type=excluded.media_type,
       storage=excluded.storage, object_key=excluded.object_key`,
  ).run(hash, buffer.length, mediaType || null, location.storage, location.key);
  return hash;
}

/** `{file: {count, bytes}, s3: {...}}` -- what the settings dialog reports. */
export function blobCounts(db) {
  const rows = db
    .prepare(
      `SELECT storage AS location, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM blobs GROUP BY storage`,
    )
    .all();
  const counts = {
    file: { count: 0, bytes: 0 },
    s3: { count: 0, bytes: 0 },
  };
  for (const row of rows) {
    // An unknown value means a row written by a future version of this file.
    if (!counts[row.location]) continue;
    counts[row.location] = { count: row.count, bytes: row.bytes };
  }
  return counts;
}

/**
 * Copies every blob into `backend`.
 *
 * Blobs already there are counted, not re-uploaded: content addressing means
 * the key alone decides whether the bytes are present, so an interrupted run
 * can simply be repeated.
 *
 * Each blob is buffered in full for the copy. `client.downloadFile` already
 * hands the whole file to `saveBlob` in one piece, and streaming an upload into
 * a non-AWS endpoint needs the chunked signature most of them reject, so this
 * keeps the two paths equally simple.
 */
export async function migrateBlobs(db, storage, backend, onProgress = () => {}) {
  if (!BACKENDS.includes(backend)) {
    throw new Error(`Unbekannter Speicherort: ${backend}`);
  }
  const target = backend === "s3" ? storage.requireRemote() : storage.file;
  const rows = db
    .prepare(
      `SELECT hash, size_bytes, media_type, storage, object_key
       FROM blobs ORDER BY hash`,
    )
    .all();
  const totals = { total: rows.length, copied: 0, alreadyThere: 0, failures: [] };
  const report = (hash) =>
    onProgress({
      ...totals,
      hash,
      // Shares the row count so the caller can show one progress bar.
      done: totals.copied + totals.alreadyThere + totals.failures.length,
    });

  for (const row of rows) {
    report(row.hash);
    if (row.storage === backend) {
      totals.alreadyThere++;
      continue;
    }
    try {
      if (!(await target.has(row.hash))) {
        const object = await storage.open(row);
        if (!object) throw new Error("Quelldatei fehlt im Ausgangsspeicher");
        const bytes = Buffer.from(await new Response(object.body).arrayBuffer());
        await target.put(row.hash, bytes, row.media_type);
      }
      db.prepare("UPDATE blobs SET storage=?, object_key=? WHERE hash=?").run(
        backend,
        target.locationKey(row.hash),
        row.hash,
      );
      totals.copied++;
    } catch (error) {
      totals.failures.push({ hash: row.hash, error: String(error?.message || error) });
    }
  }
  report(rows.at(-1)?.hash ?? null);
  return totals;
}
