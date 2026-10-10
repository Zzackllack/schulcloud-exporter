import { resolve } from "node:path";
import { openArchive } from "./database.mjs";
import { importArchive } from "./importer.mjs";
import { startServer } from "./server.mjs";
import { readCredentials } from "./credentials.mjs";
import { exportJson } from "./export.mjs";
import { loadSettings, saveSettings } from "./settings.mjs";
import { createBlobStorage, migrateBlobs } from "./storage.mjs";
import {
  repairChatTitles,
  repairMessageState,
  repairTimestamps,
} from "./repair.mjs";

const command = process.argv[2];
const target = process.argv[3];
const directory = resolve(process.env.SCHULCLOUD_ARCHIVE_DIR || "archive-data");
const settings = await loadSettings(directory);
const db = openArchive(directory);
const storage = createBlobStorage(settings, directory);

if (command === "import") {
  try {
    const credentials = await readCredentials();
    await importArchive(db, storage, credentials);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  db.close();
} else if (command === "serve") {
  // HOST is only interesting in a container, where 127.0.0.1 would keep the
  // port unreachable from the host. Left unset, this stays a desktop-local
  // server.
  startServer(
    db,
    storage,
    Number(process.env.PORT) || 4317,
    process.env.HOST || "127.0.0.1",
  );
} else if (command === "export") {
  try {
    console.log(`JSON: ${await exportJson(db, directory)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  db.close();
} else if (command === "repair") {
  try {
    repairTimestamps(db);
    repairChatTitles(db);
    repairMessageState(db);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  db.close();
} else if (command === "migrate") {
  // The same copy the viewer runs, without a browser: a headless container
  // moving a 40 GB archive needs the progress on a terminal, not an SSE stream.
  if (target !== "file" && target !== "s3") {
    console.error("Aufruf: node src/cli.mjs migrate file | migrate s3");
    db.close();
    process.exitCode = 2;
  }
  try {
    const totals = await migrateBlobs(db, storage, target, (progress) => {
      process.stdout.write(
        `\r${progress.done}/${progress.total} Objekte … `,
      );
    });
    process.stdout.write("\n");
    if (totals.failures.length) {
      console.error(`${totals.failures.length} Objekte fehlgeschlagen; Speicherort bleibt unverändert.`);
      process.exitCode = 1;
    } else {
      // The same switch the viewer flips through PUT /api/settings/migrate:
      // only a complete copy changes the write target.
      storage.reconfigure(
        await saveSettings(directory, { backend: target, s3: target === "s3" ? storage.settings.s3 : {} }),
      );
      console.log(
        `${totals.copied} kopiert, ${totals.alreadyThere} bereits vorhanden. Speicherort: ${target}`,
      );
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  db.close();
} else {
  console.error(
    "Aufruf: pnpm sync | pnpm serve | pnpm dev | pnpm export | pnpm repair | pnpm migrate",
  );
  db.close();
  process.exitCode = 2;
}
