import { importArchive } from "./importer.mjs";
import { credentialsFromEnv } from "./credentials.mjs";

// How many activity lines to keep. The full log of a real import runs to
// thousands of entries and the UI only ever shows a tail, so an unbounded
// array would grow for no reason.
const LOG_LIMIT = 400;
const FEED_LIMIT = 60;

const idle = () => ({
  status: "idle",
  startedAt: null,
  finishedAt: null,
  chats: 0,
  messages: 0,
  files: 0,
  errors: 0,
  failedChats: 0,
  failedFiles: 0,
  current: null,
  error: null,
  feed: [],
  log: [],
});

let state = idle();
let running = null;
const listeners = new Set();

/**
 * A single import at a time, shared across requests.
 *
 * The server is stateless per request, so the "is one already running?" answer
 * has to live somewhere durable -- otherwise two clicks would start two imports
 * fighting over the same SQLite file and blob directory.
 */
export function importStatus() {
  return state;
}

/**
 * The subset the viewer needs.
 *
 * The full `log` is kept server-side for the CLI and for debugging; shipping
 * it on every progress frame would mean re-sending hundreds of lines to a
 * browser that only ever renders the tail.
 */
export function publicImportState() {
  const {
    status,
    startedAt,
    finishedAt,
    chats,
    messages,
    files,
    errors,
    failedChats,
    failedFiles,
    current,
    error,
    feed,
    credentialsInEnv,
  } = state;
  return {
    status,
    running: Boolean(running),
    hasEnvCredentials: Boolean(credentialsFromEnv()),
    credentialsInEnv: Boolean(credentialsInEnv),
    startedAt,
    finishedAt,
    chats,
    messages,
    files,
    errors,
    failedChats,
    failedFiles,
    current,
    error,
    feed,
  };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event) {
  for (const listener of listeners) {
    try {
      listener(event, state);
    } catch {
      // A broken stream must not take the import down with it.
    }
  }
}

function set(patch, event = { type: "status" }) {
  state = { ...state, ...patch };
  emit(event);
}

function note(level, message) {
  const entry = { level, message, at: new Date().toISOString() };
  set(
    {
      log: [...state.log, entry].slice(-LOG_LIMIT),
      // Error lines are what the reader counts, so the "Probleme" tile is
      // derived from the same place the feed is built. Counting them in the
      // chat events as well would double-count, since a failing chat both
      // logs a line and reports chat-failed.
      errors: level === "error" ? state.errors + 1 : state.errors,
      // Errors earn a place in the feed because they are what the reader is
      // looking for; routine progress would drown them out.
      feed:
        level === "error"
          ? [...state.feed, entry].slice(-FEED_LIMIT)
          : state.feed,
    },
    { type: "log", level, message },
  );
}

export function isImporting() {
  return Boolean(running);
}

/**
 * Starts an import, or throws if one is already in flight.
 *
 * Credentials come from the environment when it is fully configured, so a
 * browser never has to handle a secret at all. Otherwise the caller supplies
 * them for this run only: they live in this closure and are never written to
 * the database, to disk, or into the log.
 */
export async function startImport(db, directory, submitted) {
  if (running) {
    const error = new Error("Es läuft bereits ein Import.");
    error.status = 409;
    throw error;
  }
  const fromEnv = credentialsFromEnv();
  if (!fromEnv && !submitted?.email) {
    const error = new Error(
      "Zugangsdaten fehlen. Setze SCHULCLOUD_EMAIL, SCHULCLOUD_PASSWORD und SCHULCLOUD_SECURITY_PASSWORD oder trage sie im Dialog ein.",
    );
    error.status = 400;
    throw error;
  }
  const credentials = fromEnv ?? {
    email: String(submitted.email || ""),
    password: String(submitted.password || ""),
    securityPassword: String(submitted.securityPassword || ""),
  };
  if (!credentials.email || !credentials.password || !credentials.securityPassword) {
    const error = new Error("Alle drei Anmeldedaten werden benötigt.");
    error.status = 400;
    throw error;
  }

  state = {
    ...idle(),
    status: "running",
    startedAt: new Date().toISOString(),
    // Make it obvious in the UI that no secret is stored anywhere.
    credentialsInEnv: Boolean(fromEnv),
  };

  const task = importArchive(
    db,
    directory,
    credentials,
    {
      log: (message) => note("info", message),
      error: (message) => note("error", message),
    },
    onProgress,
  );
  running = task;
  // The terminal `done`/`failed` event fires while `running` is still set, so
  // the client would keep seeing `running: true` forever. Clear it first, then
  // push one final frame -- otherwise the UI hangs on a finished import.
  const settle = () => {
    running = null;
    // A run that ends without a terminal event must not leave the viewer
    // showing "running" while nothing is running, so normalise the status here
    // rather than trusting the importer to have reported one.
    const terminal = ["complete", "partial", "failed"].includes(state.status);
    set(
      {
        status: terminal ? state.status : "failed",
        finishedAt: state.finishedAt ?? new Date().toISOString(),
        current: null,
      },
      { type: "settled" },
    );
  };
  task.then(settle, settle);
  return publicImportState();
}

function onProgress(event) {
  switch (event.type) {
    case "chat-start":
      set({ current: event.chat }, { type: "chat-start", chat: event.chat });
      break;
    case "chat-done":
      set(
        {
          chats: state.chats + 1,
          messages: state.messages + event.messages,
          files: state.files + event.files,
          current: null,
        },
        { type: "chat-done", chat: event.chat, messages: event.messages },
      );
      break;
    case "chat-failed":
      set(
        {
          chats: state.chats + 1,
          messages: state.messages + event.messages,
          files: state.files + event.files,
          failedChats: state.failedChats + 1,
          current: null,
        },
        { type: "chat-failed", chat: event.chat, error: event.error },
      );
      break;
    case "done":
      set(
        {
          status: event.status,
          current: null,
          finishedAt: event.at,
          failedChats: event.failedChats,
          failedFiles: event.failedFiles,
        },
        { type: "done", status: event.status },
      );
      break;
    case "failed":
      set(
        {
          status: "failed",
          current: null,
          finishedAt: new Date().toISOString(),
          error: event.error,
          // The thrown message is surfaced separately from the log feed, so it
          // is not counted a second time here.
        },
        { type: "failed", error: event.error },
      );
      break;
    default:
      set({}, { type: event.type });
      break;
  }
}

/** Test seam: drops any in-flight bookkeeping between cases. */
export function resetImportState() {
  state = idle();
  running = null;
  listeners.clear();
}
