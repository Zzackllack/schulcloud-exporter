import { migrateBlobs } from "./storage.mjs";
import { saveSettings } from "./settings.mjs";

/**
 * One blob migration at a time, shared across requests.
 *
 * Same shape as import-state: the server is stateless per request, so "is one
 * already running?" has to live somewhere durable. Two concurrent migrations
 * would copy the same objects and race on the storage column of every row.
 */

const idle = () => ({
  status: "idle",
  backend: null,
  startedAt: null,
  finishedAt: null,
  total: 0,
  copied: 0,
  alreadyThere: 0,
  failures: [],
  current: null,
  error: null,
});

let state = idle();
let running = null;
const listeners = new Set();

export function storageJob() {
  return state;
}

/** Test seam: drops in-flight bookkeeping between cases. */
export function resetStorageJob() {
  state = idle();
  running = null;
  listeners.clear();
}

export function publicStorageJob() {
  return state;
}

export function subscribeStorage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken stream must not take the migration down with it.
    }
  }
}

function set(patch) {
  state = { ...state, ...patch };
  emit();
}

/**
 * Moves every blob into `backend`, then makes it the write target.
 *
 * The order matters. While the copy runs the switch is untouched, so an import
 * starting midway keeps writing where it was writing, and every row stays
 * readable because each names its own location. Only a complete copy flips the
 * switch: flipping first would send new blobs into a backend that has none of
 * the old ones yet, which still reads fine but splits the archive in two for as
 * long as the copy runs.
 *
 * Settings are persisted last, so a failed copy leaves both the archive and the
 * configuration exactly as they were.
 */
export async function startStorageJob(db, storage, backend) {
  if (running) {
    const error = new Error("Es läuft bereits ein Speicherwechsel.");
    error.status = 409;
    throw error;
  }
  if (backend !== "file" && backend !== "s3") {
    const error = new Error("Unbekannter Speicherort.");
    error.status = 400;
    throw error;
  }
  state = {
    ...idle(),
    status: "running",
    backend,
    startedAt: new Date().toISOString(),
  };

  const task = (async () => {
    const totals = await migrateBlobs(db, storage, backend, (progress) =>
      set({
        total: progress.total,
        copied: progress.copied,
        alreadyThere: progress.alreadyThere,
        failures: progress.failures,
        current: progress.hash,
      }),
    );
    if (totals.failures.length) {
      // Nothing has been switched: rows that did move keep their new location,
      // rows that failed keep the old one, and both are still readable.
      throw new Error(
        `${totals.failures.length} Objekte konnten nicht kopiert werden (${totals.failures[0].error}). Der Speicherort wurde nicht gewechselt.`,
      );
    }
    // Persisted last, so a failed copy leaves both the archive and the
    // configuration exactly as they were. Moving *to* S3 writes the bucket
    // credentials that were just used into settings.json as well: an archive
    // whose blobs live in that bucket has to be able to find them again after
    // a restart, including one where the environment is no longer set. Moving
    // back to the disk leaves the stored S3 configuration alone.
    const saved = await saveSettings(storage.directory, {
      backend,
      s3: backend === "s3" ? storage.settings.s3 : {},
    });
    storage.reconfigure(saved);
    return totals;
  })();

  running = task;
  const settle = (failed, error) => {
    running = null;
    set({
      status: failed ? "failed" : "complete",
      finishedAt: new Date().toISOString(),
      current: null,
      error: failed ? String(error?.message || error) : null,
    });
  };
  task.then(() => settle(false), (error) => settle(true, error));
  return publicStorageJob();
}
