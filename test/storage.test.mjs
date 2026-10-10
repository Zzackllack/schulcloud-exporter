import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
import { openArchive } from "../src/database.mjs";
import {
  blobCounts,
  createBlobStorage,
  describeStoreError,
  migrateBlobs,
  saveBlob,
} from "../src/storage.mjs";
import {
  describeSettings,
  loadSettings,
  lockedFields,
  saveSettings,
} from "../src/settings.mjs";
import {
  publicStorageJob,
  startStorageJob,
  storageJob,
} from "../src/storage-jobs.mjs";
import { startServer } from "../src/server.mjs";

/**
 * A bucket is the one part of this feature that cannot be stubbed credibly: the
 * code under test is a request, and the request only exists if something
 * answers it. So these tests speak real SigV4 to a local server that records
 * what arrived -- which is also the only way to catch a bucket layout that no
 * real provider would accept.
 */
function startFakeBucket(options = {}) {
  const objects = new Map();
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname.slice(1).split("/").slice(1).join("/"));
    seen.push({
      method: request.method,
      key,
      authorization: request.headers.authorization ?? "",
      checksum: Object.keys(request.headers).filter((name) =>
        name.startsWith("x-amz-checksum-"),
      ),
    });
    if (request.method === "PUT") {
      if (options.failUploads) {
        response.writeHead(403, { "content-type": "application/xml" });
        response.end(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code></Error>`,
        );
        return;
      }
      if (options.failWithHtml) {
        response.writeHead(502, { "content-type": "text/html" });
        response.end(
          "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
        );
        return;
      }
      if (options.failWithText) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("upstream is starting, try again later");
        return;
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: request.headers["content-type"] ?? "",
        });
        response.writeHead(200, { etag: '"deadbeef"' });
        response.end();
      });
      return;
    }
    if (request.method === "HEAD") {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-length": object.body.length,
        "content-type": object.contentType || "application/octet-stream",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix));
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <Name>archive</Name><Prefix>${prefix}</Prefix>
          <KeyCount>${keys.length}</KeyCount><MaxKeys>1</MaxKeys>
          <IsTruncated>false</IsTruncated>
          ${keys.slice(0, 1).map((name) => `<Contents><Key>${name}</Key><Size>0</Size></Contents>`).join("")}
        </ListBucketResult>`,
      );
      return;
    }
    if (request.method === "GET") {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-length": object.body.length,
        "content-type": object.contentType || "application/octet-stream",
      });
      response.end(object.body);
      return;
    }
    response.writeHead(501).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        objects,
        seen,
        port: server.address().port,
        close: () => server.close(),
      }),
    );
  });
}

// Each test gets its own archive: the storage columns are the state under test,
// and sharing one database would make every count a running total of whatever
// ran before it.
const archives = [];async function freshArchive(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "schulcloud-storage-"));
  const settings = await loadSettings(directory, {});
  const db = openArchive(directory);
  const storage = createBlobStorage({ ...settings, ...overrides }, directory);
  const archive = { directory, db, storage };
  archives.push(archive);
  return archive;
}
after(async () => {
  await Promise.all(
    archives.map(({ db, directory }) => {
      try {
        db.close();
      } catch {
        /* already closed by the test */
      }
      return rm(directory, { recursive: true, force: true });
    }),
  );
});

function bucketConfig(bucket, extra = {}) {
  return {
    endpoint: `http://127.0.0.1:${bucket.port}`,
    region: "us-east-1",
    bucket: "archive",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "supersecret",
    prefix: "",
    // Path style, which is what a local bucket needs: there is no subdomain to
    // put the bucket name in.
    pathStyle: true,
    ...extra,
  };
}

/** A bucket that accepts reads and refuses every upload. */
function startBrokenBucket() {
  return startFakeBucket({
    failUploads: true,
  });
}

test("saves a blob on the disk and streams it back from the API", async () => {
  const { directory, db, storage } = await freshArchive();
  const hash = await saveBlob(db, storage, Buffer.from("%PDF-1.4 test"), "application/pdf");
  const row = db.prepare("SELECT * FROM blobs WHERE hash=?").get(hash);
  // An archive that predates the storage columns has storage='file' on every
  // row, which is exactly what the default has to be.
  assert.equal(row.storage, "file");
  assert.equal(row.object_key, null);
  // The bytes are where they always were, so an old archive is not moved.
  assert.equal(
    (await readFile(join(directory, "blobs", hash.slice(0, 2), hash))).toString(),
    "%PDF-1.4 test",
  );

  const server = startServer(db, storage, 0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/media/${hash}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-length"), "13");
    // Middleware sets these headers, so a handler that returns a raw Response
    // must not lose them -- media is exactly where nosniff counts.
    assert.match(response.headers.get("x-content-type-options"), /nosniff/);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(await response.text(), "%PDF-1.4 test");
    // A blob that was never stored has no row, and a row without bytes has
    // nothing to serve: both are a 404, never a half answer.
    assert.equal((await fetch(`${base}/media/${"0".repeat(64)}`)).status, 404);
  } finally {
    server.close();
  }
});

test("puts blobs into an S3 bucket under a content-addressed key", async () => {
  const bucket = await startFakeBucket();
  try {
    const { db, storage } = await freshArchive({
      backend: "s3",
      s3: bucketConfig(bucket, { prefix: "schulcloud/" }),
    });
    const hash = await saveBlob(db, storage, Buffer.from("anhang"), "image/png");

    const expectedKey = `schulcloud/blobs/${hash.slice(0, 2)}/${hash}`;
    const upload = bucket.seen.find((entry) => entry.method === "PUT");
    assert.ok(upload, "no upload reached the bucket");
    assert.equal(upload.key, expectedKey);
    // AWS wants a checksum header, half the compatible providers hard-fail on
    // one. Anything sent here has to be deliberate.
    assert.deepEqual(upload.checksum, []);
    assert.match(upload.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    assert.equal(bucket.objects.get(expectedKey).body.toString(), "anhang");

    const server = startServer(db, storage, 0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // The viewer reads through the archive, never from the bucket directly, so
      // the CSP can keep images to 'self'.
      const response = await fetch(`${base}/media/${hash}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(await response.text(), "anhang");
      assert.equal(bucket.seen.filter((e) => e.method === "GET").at(-1).key, expectedKey);
    } finally {
      server.close();
    }
  } finally {
    await bucket.close();
  }
});

test("answers 404 when the bucket no longer holds an object", async () => {
  const bucket = await startFakeBucket();
  try {
    const { db, storage } = await freshArchive({
      backend: "s3",
      s3: bucketConfig(bucket),
    });
    const hash = await saveBlob(db, storage, Buffer.from("fortune"), "text/plain");
    bucket.objects.clear();

    const server = startServer(db, storage, 0);
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/media/${hash}`);
      assert.equal(response.status, 404);
    } finally {
      server.close();
    }
  } finally {
    await bucket.close();
  }
});

test("moves a disk archive into a bucket and reads the old rows from it", async () => {
  const bucket = await startFakeBucket();
  try {
    const { db, directory } = await freshArchive();
    const disk = createBlobStorage(
      { backend: "file", s3: bucketConfig(bucket) },
      directory,
    );
    const hash = await saveBlob(db, disk, Buffer.from("migrated"), "application/pdf");
    assert.equal(db.prepare("SELECT storage FROM blobs WHERE hash=?").get(hash).storage, "file");
    assert.equal(blobCounts(db).file.count, 1);

    // A configuration that points at the bucket while the archive holds nothing
    // but disk rows: the copy is what fills it.
    const migrated = createBlobStorage(
      { backend: "s3", s3: bucketConfig(bucket, { prefix: "archive" }) },
      directory,
    );
    const totals = await migrateBlobs(db, migrated, "s3");
    assert.equal(totals.copied, 1);
    assert.equal(totals.failures.length, 0);
    const key = `archive/blobs/${hash.slice(0, 2)}/${hash}`;
    assert.equal(bucket.objects.get(key).body.toString(), "migrated");

    // The row moved with the bytes, so the media route now reads from the bucket
    // without anything having told it to change its mind.
    const row = db.prepare("SELECT storage, object_key FROM blobs WHERE hash=?").get(hash);
    assert.equal(row.storage, "s3");
    assert.equal(row.object_key, key);

    const server = startServer(db, migrated, 0);
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/media/${hash}`);
      assert.equal(await response.text(), "migrated");
    } finally {
      server.close();
    }

    // A second run has nothing left to do, which is what makes an interrupted
    // migration safe to repeat.
    const again = await migrateBlobs(db, migrated, "s3");
    assert.equal(again.copied, 0);
    assert.equal(again.alreadyThere, 1);
  } finally {
    await bucket.close();
  }
});

test("keeps a half-migrated archive readable by dispatching on the row", async () => {
  const bucket = await startFakeBucket();
  try {
    const { db, storage } = await freshArchive();
    const config = bucketConfig(bucket);
    storage.reconfigure({ backend: "file", s3: config });
    const onDisk = await saveBlob(db, storage, Buffer.from("alt"), "image/png");
    // The write target has changed, so the next blob lands somewhere else while
    // the old row still points at the disk.
    storage.reconfigure({ backend: "s3", s3: config });
    const inBucket = await saveBlob(db, storage, Buffer.from("neu"), "image/png");
    assert.equal(db.prepare("SELECT storage FROM blobs WHERE hash=?").get(inBucket).storage, "s3");
    assert.equal(blobCounts(db).file.count, 1);
    assert.equal(blobCounts(db).s3.count, 1);

    const server = startServer(db, storage, 0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal(await (await fetch(`${base}/media/${onDisk}`)).text(), "alt");
      assert.equal(await (await fetch(`${base}/media/${inBucket}`)).text(), "neu");
    } finally {
      server.close();
    }
  } finally {
    await bucket.close();
  }
});

test("lets the environment override settings.json and says so", async () => {
  const { directory } = await freshArchive();
  const saved = await saveSettings(directory, {
    backend: "file",
    s3: { bucket: "from-file", accessKeyId: "file-key", secretAccessKey: "file-secret" },
  });
  assert.equal(saved.backend, "file");
  assert.equal(saved.s3.bucket, "from-file");
  assert.deepEqual(lockedFields({}), []);

  const env = {
    SCHULCLOUD_STORAGE: "s3",
    SCHULCLOUD_S3_BUCKET: "from-env",
    SCHULCLOUD_S3_PREFIX: "/team/",
  };
  const overridden = await loadSettings(directory, env);
  assert.equal(overridden.backend, "s3");
  // An unrecognised value is not a backend; it falls back to the file rather
  // than sending blobs to a place nobody configured.
  assert.equal((await loadSettings(directory, { SCHULCLOUD_STORAGE: "ftp" })).backend, "file");
  assert.equal(overridden.s3.bucket, "from-env");
  assert.equal(overridden.s3.prefix, "team/");
  assert.equal(overridden.s3.accessKeyId, "file-key");
  const locked = lockedFields(env);
  assert.ok(locked.includes("backend"));
  assert.ok(locked.includes("s3.bucket"));
  assert.ok(!locked.includes("s3.accessKeyId"));

  // The viewer never learns the secret, only whether one exists.
  const described = describeSettings(overridden, locked);
  assert.equal(described.s3.secretAccessKey, "");
  assert.equal(described.secretStored, true);
});

test("refuses a storage switch from a remote host", async () => {
  const { db, storage } = await freshArchive();
  const server = startServer(db, storage, 0);
  await once(server, "listening");
  try {
    // Same gate as the import: a page on another machine must not be able to
    // point this archive at a bucket it controls.
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: "/api/settings",
          method: "PUT",
          headers: { host: "archive.example.org", "content-type": "application/json" },
        },
        (response) => resolve(response.statusCode),
      );
      request.on("error", reject);
      request.end(JSON.stringify({ backend: "file" }));
    });
    assert.equal(status, 403);
    assert.equal(storage.backend, "file");
  } finally {
    server.close();
  }
});

test("counts what each backend holds", async () => {
  const { db, storage } = await freshArchive();
  assert.deepEqual(blobCounts(db), {
    file: { count: 0, bytes: 0 },
    s3: { count: 0, bytes: 0 },
  });
  await saveBlob(db, storage, Buffer.from("bytes"), "image/png");
  const counts = blobCounts(db);
  assert.equal(counts.file.count, 1);
  assert.equal(counts.file.bytes, 5);
  // An unknown value would be a row written by a future version of this file;
  // it must not turn into a NaN in the settings dialog.
  db.prepare("UPDATE blobs SET storage='something-else'").run();
  assert.deepEqual(blobCounts(db).file, { count: 0, bytes: 0 });
  assert.deepEqual(blobCounts(db).s3, { count: 0, bytes: 0 });
});

test("has nothing to migrate when every blob is already where it should be", async () => {
  const { db, storage } = await freshArchive();
  await saveBlob(db, storage, Buffer.from("hier"), "image/png");
  const totals = await migrateBlobs(db, storage, "file");
  assert.equal(totals.total, 1);
  assert.equal(totals.copied, 0);
  assert.equal(totals.alreadyThere, 1);
});

test("switches the write target only after a complete migration", async () => {
  const bucket = await startFakeBucket();
  try {
    const { db, directory } = await freshArchive();
    const disk = createBlobStorage({ backend: "file", s3: bucketConfig(bucket) }, directory);
    const first = await saveBlob(db, disk, Buffer.from("eins"), "image/png");
    const second = await saveBlob(db, disk, Buffer.from("zwei"), "image/png");

    // Exactly what the settings dialog writes: the bucket configuration, with
    // the backend left on the disk until the copy is done.
    await saveSettings(directory, { backend: "file", s3: bucketConfig(bucket, { prefix: "archiv" }) });
    const storage = createBlobStorage(await loadSettings(directory), directory);
    assert.equal(storage.backend, "file");

    const starting = await startStorageJob(db, storage, "s3");
    assert.equal(starting.status, "running");
    const job = await settleStorageJob();
    assert.equal(job.status, "complete");
    assert.equal(job.copied, 2);
    assert.equal(job.total, 2);

    // The switch flipped, so the next blob goes straight into the bucket.
    assert.equal(storage.backend, "s3");
    const third = await saveBlob(db, storage, Buffer.from("drei"), "image/png");
    assert.equal(bucket.objects.get(`archiv/blobs/${third.slice(0, 2)}/${third}`).body.toString(), "drei");

    const server = startServer(db, storage, 0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // Both old rows were moved, so all three read back from the bucket.
      for (const [hash, text] of [[first, "eins"], [second, "zwei"], [third, "drei"]]) {
        assert.equal(await (await fetch(`${base}/media/${hash}`)).text(), text);
      }
    } finally {
      server.close();
    }

    // And the settings file now holds the switch, so a restart keeps it.
    const restarted = await loadSettings(directory);
    assert.equal(restarted.backend, "s3");
    assert.equal(restarted.s3.prefix, "archiv/");
    // Persisted on the way in, so the archive can find its bucket again without
    // the environment being set.
    assert.equal(restarted.s3.secretAccessKey, "supersecret");
  } finally {
    await bucket.close();
  }
});

test("leaves the write target alone when the migration fails", async () => {
  const bucket = await startBrokenBucket();
  try {
    const { db, directory } = await freshArchive();
    const disk = createBlobStorage({ backend: "file", s3: bucketConfig(bucket) }, directory);
    const hash = await saveBlob(db, disk, Buffer.from("wichtig"), "image/png");
    await saveSettings(directory, { backend: "file", s3: bucketConfig(bucket) });
    const storage = createBlobStorage(await loadSettings(directory), directory);

    await startStorageJob(db, storage, "s3");
    const job = await settleStorageJob();
    assert.equal(job.status, "failed");
    assert.match(job.error, /Speicherort wurde nicht gewechselt/);
    // Still on the disk, and the file that says so was not rewritten.
    assert.equal(storage.backend, "file");
    assert.equal((await loadSettings(directory)).backend, "file");
    assert.equal(blobCounts(db).file.count, 1);

    const server = startServer(db, storage, 0);
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/media/${hash}`);
      assert.equal(await response.text(), "wichtig");
    } finally {
      server.close();
    }
  } finally {
    await bucket.close();
  }
});

test("names the reason a bucket refused a blob", async () => {
  const bucket = await startBrokenBucket();
  try {
    const { db, directory } = await freshArchive();
    const disk = createBlobStorage({ backend: "file", s3: bucketConfig(bucket) }, directory);
    await saveBlob(db, disk, Buffer.from("abgelehnt"), "image/png");
    const storage = createBlobStorage({ backend: "s3", s3: bucketConfig(bucket) }, directory);
    const totals = await migrateBlobs(db, storage, "s3");
    assert.equal(totals.failures.length, 1);
    // A bucket that refuses with S3's own XML at least gets its status across,
    // which is the difference between "wrong credentials" and trying again.
    assert.match(totals.failures[0].error, /^HTTP 403/);

    // The refusals that matter are the silent ones behind a proxy: an HTML 502
    // from a gateway, or plain text from a service that is still booting. Both
    // reach the reader as "XML parse error: unexpected content", which names
    // neither, so the reason is rebuilt from the status line and the raw reply.
    for (const [option, expected] of [
      ["failWithHtml", /^HTTP 502: UnknownError — der Endpunkt hat nicht mit S3-XML geantwortet \(text\/html\)$/],
      [
        "failWithText",
        /^HTTP 503: upstream is starting, try again later — der Endpunkt hat nicht mit S3-XML geantwortet \(text\/plain\)$/,
      ],
    ]) {
      const noisy = await startFakeBucket({ [option]: true });
      try {
        const broken = createBlobStorage({ backend: "s3", s3: bucketConfig(noisy) }, directory);
        const result = await migrateBlobs(db, broken, "s3");
        assert.equal(result.failures.length, 1, option);
        assert.match(result.failures[0].error, expected, option);
      } finally {
        await noisy.close();
      }
    }
  } finally {
    await bucket.close();
  }
});

test("says when an endpoint did not answer as S3 at all", async () => {
  const parseFailure = {
    name: "DeserializationError",
    message: "@aws-sdk XML parse error: unexpected content.",
  };
  // A proxy page that the client could not read at all: the parse error is all
  // there is, and it reads like a transport bug rather than a wrong endpoint.
  assert.equal(
    describeStoreError(parseFailure),
    "DeserializationError: @aws-sdk XML parse error: unexpected content. — der Endpunkt hat nicht mit S3-XML geantwortet",
  );
  // With a status and headers, the reply says more than the SDK does: whatever
  // answered was not a bucket, and its content type is the evidence.
  assert.equal(
    describeStoreError({
      ...parseFailure,
      $metadata: { httpStatusCode: 502, requestId: "xyz" },
      $response: { headers: new Headers({ "content-type": "text/html; charset=utf-8" }) },
    }),
    "HTTP 502: @aws-sdk XML parse error: unexpected content. — der Endpunkt hat nicht mit S3-XML geantwortet (text/html) (Anfrage xyz)",
  );
  // A bucket that refuses with S3's own XML error needs no help: the status and
  // the message already say what to fix.
  assert.equal(
    describeStoreError({
      name: "AccessDenied",
      message: "Access Denied",
      $metadata: { httpStatusCode: 403 },
      $response: { headers: new Headers({ "content-type": "application/xml" }) },
    }),
    "HTTP 403: Access Denied",
  );
});

test("reports one blob as a single object, not a count", async () => {
  const bucket = await startBrokenBucket();
  try {
    const { db, directory } = await freshArchive();
    const disk = createBlobStorage({ backend: "file", s3: bucketConfig(bucket) }, directory);
    await saveBlob(db, disk, Buffer.from("eins"), "image/png");
    await saveSettings(directory, { backend: "file", s3: bucketConfig(bucket) });
    const storage = createBlobStorage(await loadSettings(directory), directory);

    await startStorageJob(db, storage, "s3");
    const job = await settleStorageJob();
    assert.match(job.error, /^Ein Objekt konnte nicht kopiert werden: /);
    // The hash prefix is what lets the reader find the offending row.
    assert.match(job.error, /\([0-9a-f]{8}…\)/);
    // And the message says what to do about it: the copy is resumable, so a
    // single bad blob is a repeat, not a dead end.
    assert.match(job.error, /wiederholt werden/);
  } finally {
    await bucket.close();
  }
});

test("runs one migration at a time", async () => {
  const bucket = await startFakeBucket();
  try {
    const { db, directory } = await freshArchive();
    const storage = createBlobStorage({ backend: "file", s3: bucketConfig(bucket) }, directory);
    await saveBlob(db, storage, Buffer.from("ein Blob"), "image/png");
    // A nonsense target is refused before anything is copied.
    await assert.rejects(() => startStorageJob(db, storage, "ftp"), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
    await startStorageJob(db, storage, "file");
    await assert.rejects(() => startStorageJob(db, storage, "file"), (error) => {
      assert.equal(error.status, 409);
      return true;
    });
    await settleStorageJob();
    assert.equal(publicStorageJob().status, "complete");
  } finally {
    await bucket.close();
  }
});

/** Waits for the background job to reach a terminal state. */
async function settleStorageJob() {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = storageJob();
    if (job.status !== "running" && job.status !== "idle") return publicStorageJob();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Speicherwechsel ist nicht beendet");
}
