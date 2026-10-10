import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Database,
  HardDrive,
  Loader,
  PlugZap,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";
import {
  loadStorageSettings,
  saveStorageSettings,
  startStorageMigration,
  streamStorage,
  testStorageSettings,
} from "../api";
import type { StorageDraft } from "../api";
import type { StorageBackend, StorageSettings } from "../types";
import { dataSize } from "../format";
import { Field } from "./field";

/**
 * Storage settings: where the blobs live and how to move them.
 *
 * The draft lives here rather than being written straight through to the
 * server, because a bucket address is worth checking before it is believed. A
 * save returns what the server now runs with -- the environment can override a
 * field, and a viewer that disagreed with that would be worse than no form.
 */
export function SettingsPanel() {
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [draft, setDraft] = useState<StorageDraft>(emptyDraft());
  const [busy, setBusy] = useState<"save" | "test" | "migrate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadStorageSettings(controller.signal)
      .then((loaded) => {
        setSettings(loaded);
        setDraft(draftOf(loaded));
        status.current = loaded.job.status;
      })
      .catch((cause: unknown) => {
        // An abort is the component going away, not a failure worth reporting.
        // StrictMode mounts twice in development, and without this the panel
        // would show an error on every single load.
        if (controller.signal.aborted) return;
        setError(
          cause instanceof Error
            ? `Einstellungen konnten nicht geladen werden: ${cause.message}`
            : "Einstellungen konnten nicht geladen werden.",
        );
      });
    return () => controller.abort();
  }, []);

  // A migration that started in another tab finishes here too, so the counts
  // and the switch have to be re-read once the job is no longer running.
  const reload = useCallback(() => {
    loadStorageSettings()
      .then((loaded) => {
        setSettings(loaded);
        setDraft(draftOf(loaded));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return streamStorage((job) => {
      setSettings((current) => (current ? { ...current, job } : current));
      if (job.status !== "running" && status.current === "running") reload();
      status.current = job.status;
    });
  }, [reload]);

  function update(field: keyof StorageDraft["s3"], value: string | boolean) {
    setDraft((current) => ({ ...current, s3: { ...current.s3, [field]: value } }));
    setNotice(null);
  }

  function choose(backend: StorageBackend) {
    setDraft((current) => ({ ...current, backend }));
    setNotice(null);
  }

  async function save() {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await saveStorageSettings(draft);
      setSettings(saved);
      setDraft(draftOf(saved));
      setNotice("Speicherort gespeichert.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Speichern fehlgeschlagen.");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setError(null);
    setNotice(null);
    try {
      const result = await testStorageSettings(draft);
      if (result.ok) setNotice("Verbindung steht; der Bucket antwortet.");
      else setError(result.error || "Verbindung fehlgeschlagen.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Verbindung fehlgeschlagen.");
    } finally {
      setBusy(null);
    }
  }

  async function migrate() {
    setBusy("migrate");
    setError(null);
    setNotice(null);
    try {
      await startStorageMigration(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Umzug fehlgeschlagen.");
    } finally {
      setBusy(null);
    }
  }

  if (!settings) {
    return (
      <section className="settings-panel" aria-label="Einstellungen">
        <header className="settings-head">
          <Link className="back-button" to="/" aria-label="Zurück zur Chatliste">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h2>Einstellungen</h2>
            <p>Speicherort für Anhänge und Profilbilder</p>
          </div>
        </header>
        <p className="timeline-state">Einstellungen werden geladen …</p>
      </section>
    );
  }

  const { backend, s3, secretStored, locked, counts, job, warning } = settings;
  const lockedField = (path: string) => locked.includes(path);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));
  const target: StorageBackend = backend === "s3" ? "file" : "s3";
  const targetLabel = target === "s3" ? "nach S3" : "auf die Festplatte";
  const running = job.status === "running";
  // A bucket can only be used once it is stored, so the button says so rather
  // than failing on the settings it would have used.
  const migrationBlocked = target === "s3" && dirty;
  const done = job.total - job.failures.length;

  return (
    <section className="settings-panel" aria-label="Einstellungen">
      <header className="settings-head">
        <Link className="back-button" to="/" aria-label="Zurück zur Chatliste">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h2>Einstellungen</h2>
          <p>Speicherort für Anhänge und Profilbilder</p>
        </div>
      </header>

      <div className="settings-body">
        {warning ? (
          <p className="panel-note">
            <AlertCircle size={16} />
            {warning}
          </p>
        ) : null}

        <section className="settings-section">
          <h3>Speicherort</h3>
          <p className="settings-note">
            Die Datenbank bleibt auf diesem Gerät. Hier stehen nur die Anhänge
            und Profilbilder — der Großteil des Speichers.
          </p>
          <div className="storage-choice">
            <StorageOption
              icon={HardDrive}
              title="Auf der Festplatte"
              detail={`${counts.file.count.toLocaleString("de-DE")} Objekte · ${dataSize(counts.file.bytes)}`}
              active={draft.backend === "file"}
              locked={lockedField("backend")}
              onSelect={() => choose("file")}
            />
            <StorageOption
              icon={Database}
              title="S3 / Objektspeicher"
              detail={`${counts.s3.count.toLocaleString("de-DE")} Objekte · ${dataSize(counts.s3.bytes)}`}
              active={draft.backend === "s3"}
              locked={lockedField("backend")}
              onSelect={() => choose("s3")}
            />
          </div>
        </section>

        {draft.backend === "s3" ? (
          <section className="settings-section">
            <h3>S3-Verbindung</h3>
            <p className="settings-note">
              Alles, was SigV4 spricht: AWS S3, MinIO, Wasabi, Backblaze B2,
              Cloudflare R2, Hetzner. Der geheimer Schlüssel wird nur lokal
              gespeichert und nie an den Browser geschickt.
            </p>
            <div className="settings-grid">
              <Field
                id="s3-endpoint"
                label="Endpunkt"
                placeholder="https://s3.eu-central-1.amazonaws.com"
                value={draft.s3.endpoint}
                locked={lockedField("s3.endpoint")}
                hint={lockedField("s3.endpoint") ? "Kommt aus der Umgebung" : "Leer lassen für AWS"}
                onChange={(endpoint) => update("endpoint", endpoint)}
              />
              <Field
                id="s3-region"
                label="Region"
                placeholder="us-east-1"
                value={draft.s3.region}
                locked={lockedField("s3.region")}
                onChange={(region) => update("region", region)}
              />
              <Field
                id="s3-bucket"
                label="Bucket"
                placeholder="schulcloud-archiv"
                value={draft.s3.bucket}
                locked={lockedField("s3.bucket")}
                onChange={(bucket) => update("bucket", bucket)}
              />
              <Field
                id="s3-prefix"
                label="Präfix"
                placeholder="leer = im Bucket-Wurzelverzeichnis"
                value={draft.s3.prefix}
                locked={lockedField("s3.prefix")}
                hint="Mehrere Archive können sich ein Bucket teilen."
                onChange={(prefix) => update("prefix", prefix)}
              />
              <Field
                id="s3-access-key"
                label="Zugriffsschlüssel"
                autoComplete="off"
                value={draft.s3.accessKeyId}
                locked={lockedField("s3.accessKeyId")}
                onChange={(accessKeyId) => update("accessKeyId", accessKeyId)}
              />
              <Field
                id="s3-secret-key"
                label="Geheimer Schlüssel"
                type="password"
                autoComplete="new-password"
                placeholder={secretStored ? "hinterlegt" : ""}
                value={draft.s3.secretAccessKey ?? ""}
                locked={lockedField("s3.secretAccessKey")}
                hint={
                  lockedField("s3.secretAccessKey")
                    ? "Kommt aus der Umgebung"
                    : secretStored
                      ? "Leer lassen, um den gespeicherten zu behalten"
                      : undefined
                }
                onChange={(secretAccessKey) => update("secretAccessKey", secretAccessKey)}
              />
              <label className="settings-toggle" htmlFor="s3-path-style">
                <input
                  id="s3-path-style"
                  type="checkbox"
                  checked={draft.s3.pathStyle}
                  disabled={lockedField("s3.pathStyle")}
                  onChange={(event) => update("pathStyle", event.target.checked)}
                />
                <span>
                  Pfad-Stil-Adressen
                  <small>Für MinIO und Anbieter ohne Bucket-Subdomain</small>
                </span>
              </label>
            </div>
            <div className="settings-actions">
              <button
                className="import-button"
                type="button"
                onClick={test}
                disabled={busy !== null || running}
              >
                {busy === "test" ? (
                  <>
                    <Loader size={16} className="spin" />Prüft …
                  </>
                ) : (
                  <>
                    <PlugZap size={16} />Verbindung testen
                  </>
                )}
              </button>
              <button
                className="import-start"
                type="button"
                onClick={save}
                disabled={busy !== null || running || !dirty}
              >
                {busy === "save" ? "Speichert …" : "Speichern"}
              </button>
            </div>
          </section>
        ) : null}

        <section className="settings-section">
          <h3>Bestand umziehen</h3>
          <p className="settings-note">
            Neue Dateien landen in <strong>{backend === "s3" ? s3.bucket || "S3" : "archive-data/blobs/"}</strong>.
            Der Umzug kopiert alles, was noch anderswo liegt; Nachrichten und
            Chats bleiben unterwegs lesbar.
          </p>
          {error ? (
            <p className="panel-error" role="alert">
              <AlertCircle size={16} />
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="panel-proof">
              <Check size={15} />
              {notice}
            </p>
          ) : null}
          {running ? (
            <div className="settings-progress">
              <div className="progress" role="progressbar" aria-label="Speicherwechsel läuft">
                <div className="progress-sweep" />
              </div>
              <p className="import-current">
                {job.copied + job.alreadyThere + job.failures.length} von {job.total}{" "}
                Objekten verarbeitet
                {job.current ? ` · ${job.current.slice(0, 8)}…` : ""}
              </p>
            </div>
          ) : job.status === "failed" ? (
            <p className="panel-error" role="alert">
              <AlertCircle size={16} />
              {job.error || "Der Umzug wurde abgebrochen."}
            </p>
          ) : job.status === "complete" ? (
            <p className="panel-proof">
              <Check size={15} />
              {job.copied.toLocaleString("de-DE")} Objekte kopiert,{" "}
              {job.alreadyThere.toLocaleString("de-DE")} bereits vorhanden.
            </p>
          ) : null}
          <div className="settings-actions">
            <button
              className="import-button"
              type="button"
              onClick={migrate}
              disabled={busy !== null || running || migrationBlocked}
              title={migrationBlocked ? "Erst die S3-Verbindung speichern" : undefined}
            >
              {busy === "migrate" ? (
                <>
                  <Loader size={16} className="spin" />Startet …
                </>
              ) : (
                <>
                  <RefreshCw size={16} />Alle Objekte {targetLabel} umziehen
                </>
              )}
            </button>
          </div>
          <p className="settings-fineprint">
            Gespeichert in <code>{settings.directory}/settings.json</code> neben
            dem Archiv, nur für diesen Benutzer lesbar. Der Schlüssel wird nicht
            in Exporte oder die Datenbank geschrieben.
          </p>
        </section>
      </div>
    </section>
  );
}

const settingsPath = "archive-data/settings.json";

function StorageOption({
  icon: Icon,
  title,
  detail,
  active,
  locked,
  onSelect,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  active: boolean;
  locked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`storage-option ${active ? "active" : ""}`}
      aria-pressed={active}
      disabled={locked}
      onClick={onSelect}
    >
      <span className="storage-option-icon">
        <Icon size={18} />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
        {locked ? <small>Kommt aus der Umgebung</small> : null}
      </span>
    </button>
  );
}

function emptyDraft(): StorageDraft {
  return {
    backend: "file",
    s3: {
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
      prefix: "",
      pathStyle: false,
    },
  };
}

function draftOf(settings: StorageSettings): StorageDraft {
  return { backend: settings.backend, s3: { ...settings.s3, secretAccessKey: "" } };
}
