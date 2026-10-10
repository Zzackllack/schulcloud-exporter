import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where blobs live: on the local disk, or in S3-compatible object storage.
 *
 * An archive can hold both at the same time -- every blob row records where its
 * bytes actually are -- but only one of them receives new blobs. That single
 * switch is `backend`, and everything else here exists to keep it trustworthy:
 * the file survives a restart, the environment wins over the file (a container
 * has no other way to configure this, and an operator who exports a variable
 * expects it to stick), and the secret access key never leaves the process.
 *
 * The SQLite database deliberately stays on disk in either mode. WAL over an
 * object store is not a thing, so "not everything on the disk" means the blobs,
 * which are the bulk of the archive anyway.
 */

const SETTINGS_FILE = "settings.json";

export const BACKENDS = ["file", "s3"];

// Only variables that are actually set take part in the merge, so a lone
// SCHULCLOUD_S3_BUCKET in the environment still leaves the endpoint to the file.
const S3_ENV_VARS = {
  endpoint: "SCHULCLOUD_S3_ENDPOINT",
  region: "SCHULCLOUD_S3_REGION",
  bucket: "SCHULCLOUD_S3_BUCKET",
  accessKeyId: "SCHULCLOUD_S3_ACCESS_KEY_ID",
  secretAccessKey: "SCHULCLOUD_S3_SECRET_ACCESS_KEY",
  prefix: "SCHULCLOUD_S3_PREFIX",
  pathStyle: "SCHULCLOUD_S3_PATH_STYLE",
};

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// Plain http is allowed only against a loopback endpoint: anything else would
// send the secret access key across a network we do not control. That one
// exception is what makes a MinIO on 127.0.0.1 work in development.
const LOOPBACK = /^(127\.|localhost$|\[::1\]$|::1$)/;

export function settingsPath(directory) {
  return join(directory, SETTINGS_FILE);
}

export function emptyS3() {
  return {
    endpoint: "",
    region: "",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "",
    pathStyle: false,
  };
}

export function defaultSettings() {
  return { backend: "file", s3: emptyS3() };
}

/** `""` or `"prefix/"` -- an S3 key prefix must be slash-free at both ends. */
export function normalizePrefix(value) {
  const trimmed = String(value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

export function normalizeS3(raw = {}) {
  const source = raw ?? {};
  return {
    endpoint: String(source.endpoint ?? "").trim(),
    region: String(source.region ?? "").trim(),
    bucket: String(source.bucket ?? "").trim().toLowerCase(),
    accessKeyId: String(source.accessKeyId ?? "").trim(),
    // Trimmed as well: a copy-pasted secret very often carries a trailing
    // newline, and a key that differs by one character signs into a 403.
    secretAccessKey: String(source.secretAccessKey ?? "").trim(),
    prefix: normalizePrefix(source.prefix),
    pathStyle:
      source.pathStyle === true ||
      source.pathStyle === "true" ||
      source.pathStyle === 1 ||
      source.pathStyle === "1",
  };
}

async function readStored(directory) {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(directory), "utf8"));
    return {
      backend: BACKENDS.includes(parsed?.backend) ? parsed.backend : "file",
      s3: normalizeS3(parsed?.s3),
    };
  } catch (error) {
    // A missing file is the normal first run. An unreadable or malformed one is
    // worth saying out loud, because silently falling back to disk would look
    // like data loss to whoever wrote the settings.
    if (error.code !== "ENOENT") {
      console.warn(`Einstellungen nicht lesbar (${error.code}); es gilt der Standardspeicher.`);
    }
    return defaultSettings();
  }
}

function envOverrides(env) {
  const overrides = {};
  for (const [field, name] of Object.entries(S3_ENV_VARS)) {
    const value = env[name];
    if (value == null || value === "") continue;
    overrides[field] = value;
  }
  const backend = env.SCHULCLOUD_STORAGE;
  return { backend: BACKENDS.includes(backend) ? backend : null, s3: overrides };
}

function mergeSettings(stored, env) {
  const fromEnv = envOverrides(env);
  return {
    backend: fromEnv.backend ?? stored.backend,
    s3: normalizeS3({ ...stored.s3, ...fromEnv.s3 }),
  };
}

/**
 * The effective settings: the file, with the environment layered on top.
 *
 * Returns the settings only. `lockedFields` says which of them the environment
 * dictates, which is what the viewer needs in order to show a field as
 * read-only instead of accepting an edit that would then be ignored.
 */
export async function loadSettings(directory, env = process.env) {
  return mergeSettings(await readStored(directory), env);
}

export function lockedFields(env = process.env) {
  const { backend, s3 } = envOverrides(env);
  const locked = [];
  if (backend) locked.push("backend");
  for (const field of Object.keys(s3)) locked.push(`s3.${field}`);
  return locked;
}

/**
 * Validates what the server would actually run with.
 *
 * Drafts are validated after the environment has been merged in: the point is
 * not to police the form, it is to refuse a configuration that cannot store a
 * blob. Saving while an env var overrides the same field is allowed and simply
 * has no effect until that variable goes away.
 */
export function validateSettings(settings) {
  const errors = [];
  if (!BACKENDS.includes(settings?.backend)) {
    errors.push("Unbekannter Speicherort.");
    return errors;
  }
  if (settings.backend !== "s3") return errors;
  const s3 = normalizeS3(settings.s3);
  if (!BUCKET_PATTERN.test(s3.bucket)) {
    errors.push("Bucket-Name: 3–63 Zeichen, nur Kleinbuchstaben, Ziffern, Punkte und Bindestriche.");
  }
  if (!s3.accessKeyId) errors.push("Zugriffsschlüssel fehlt.");
  if (!s3.secretAccessKey) errors.push("Geheimer Schlüssel fehlt.");
  if (s3.endpoint) {
    let url;
    try {
      url = new URL(s3.endpoint);
    } catch {
      errors.push("Endpunkt ist keine gültige URL.");
    }
    if (url && url.protocol !== "https:" && !LOOPBACK.test(url.hostname)) {
      errors.push("Endpunkt muss https sein (localhost ausgenommen).");
    }
  }
  return errors;
}

/**
 * Writes settings.json with the submitted draft merged over what is stored.
 *
 * An empty `secretAccessKey` means "keep the one we have": the browser never
 * receives the secret, so it cannot echo it back, and re-typing a 40-character
 * key to change the bucket would be absurd.
 */
export async function saveSettings(directory, draft, env = process.env) {
  const stored = await readStored(directory);
  const next = {
    backend: BACKENDS.includes(draft?.backend) ? draft.backend : stored.backend,
    s3: normalizeS3({
      ...stored.s3,
      ...(draft?.s3 ?? {}),
      secretAccessKey: draft?.s3?.secretAccessKey || stored.s3.secretAccessKey,
    }),
  };
  const errors = validateSettings(mergeSettings(next, env));
  if (errors.length) {
    const error = new Error(errors.join(" "));
    error.status = 400;
    throw error;
  }
  await writeFile(settingsPath(directory), `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  return next;
}

/**
 * The viewer-safe view: everything except the secret, which is replaced by the
 * flag saying one exists. That flag is what lets the form show "hinterlegt"
 * instead of an empty field that looks like a missing key.
 */
export function describeSettings(settings, locked = []) {
  return {
    backend: settings.backend,
    s3: { ...emptyS3(), ...normalizeS3(settings.s3), secretAccessKey: "" },
    secretStored: Boolean(settings.s3.secretAccessKey),
    locked,
  };
}
