import { resolve } from "node:path";
import { openArchive } from "./database.mjs";
import { importArchive } from "./importer.mjs";
import { startServer } from "./server.mjs";
import { readCredentials } from "./credentials.mjs";
import { exportJson } from "./export.mjs";

const command = process.argv[2];
const directory = resolve(process.env.SCHULCLOUD_ARCHIVE_DIR || "archive-data");
const db = openArchive(directory);

if (command === "import") {
  try {
    const credentials = await readCredentials();
    await importArchive(db, directory, credentials);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  db.close();
} else if (command === "serve") {
  startServer(db, directory, Number(process.env.PORT) || 4317);
} else if (command === "export") {
  try {
    console.log(`JSON: ${await exportJson(db, directory)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  db.close();
} else {
  console.error("Aufruf: pnpm sync | pnpm serve | pnpm export");
  db.close();
  process.exitCode = 2;
}
