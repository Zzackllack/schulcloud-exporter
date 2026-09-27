import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CloudDownload,
  HardDrive,
  Loader,
  MessageCircle,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { startImport } from "../api";
import type { ImportCredentials } from "../api";
import type { ImportState } from "../types";

interface ImportPanelProps {
  open: boolean;
  /** Owned by App, which holds the single progress stream. */
  state: ImportState | null;
  onClose: () => void;
  /** Called once a run finishes so the viewer can reload its data. */
  onFinished: () => void;
}

const idleState: ImportState = {
  status: "idle",
  running: false,
  hasEnvCredentials: false,
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
};

export function ImportPanel({ open, state, onClose, onFinished }: ImportPanelProps) {
  const current = state ?? idleState;
  // Defensive: the panel renders server-pushed data, and one malformed frame
  // must not be able to blank the app. There is no error boundary above this.
  const feed = current.feed ?? [];
  const [credentials, setCredentials] = useState<ImportCredentials>({
    email: "",
    password: "",
    securityPassword: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const announced = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // A finished run has to refresh the sidebar, once, keyed on the run's end
  // time so a re-render can never fire it twice.
  useEffect(() => {
    if (!open || current.running || !current.finishedAt) return;
    if (announced.current === current.finishedAt) return;
    announced.current = current.finishedAt;
    onFinished();
  }, [open, current.running, current.finishedAt, onFinished]);

  // Escape closes, Tab stays inside -- a dialog you can walk out of with the
  // keyboard is not much of a dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !current.running) {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, current.running, onClose]);

  async function begin() {
    setStarting(true);
    setFormError(null);
    try {
      await startImport(current.hasEnvCredentials ? undefined : credentials);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Import konnte nicht starten.",
      );
    } finally {
      setStarting(false);
    }
  }

  if (!open) return null;

  const needsForm = !current.hasEnvCredentials;
  const busy = current.running || starting;
  const done = !current.running && Boolean(current.finishedAt);
  const outcome =
    current.status === "failed"
      ? "Import fehlgeschlagen"
      : current.status === "partial"
        ? "Import mit Rückfragen"
        : "Import abgeschlossen";

  return (
    <div className="overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !current.running) onClose();
    }}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        ref={dialogRef}
      >
        <header className="dialog-head">
          <div className="dialog-symbol">
            <CloudDownload size={30} strokeWidth={1.7} />
          </div>
          <div className="dialog-titles">
            <h2 id="import-title">Archiv importieren</h2>
            <p>
              {current.running
                ? "Läuft im Hintergrund. Du kannst weiter durch das Archiv stöbern."
                : done
                  ? outcome
                  : "Liest Channels und Konversationen von schul.cloud."}
            </p>
          </div>
          {!current.running ? (
            <button className="dialog-close" type="button" onClick={onClose} aria-label="Schließen">
              <X size={19} />
            </button>
          ) : null}
        </header>

        {current.running ? (
          <>
            <div className="progress" role="progressbar" aria-label="Import läuft">
              <div className="progress-sweep" />
            </div>
            <div className="stat-row">
              <Stat icon={MessageCircle} value={current.chats} label="Chats" />
              <Stat icon={Loader} value={current.messages} label="Nachrichten" />
              <Stat icon={HardDrive} value={current.files} label="Dateien" />
              <Stat
                icon={AlertCircle}
                value={current.errors}
                label="Probleme"
                warn={current.errors > 0}
              />
            </div>
            <p className="import-current">
              {current.current
                ? `Lade ${current.current.title || current.current.id} …`
                : "Verbinde mit schul.cloud …"}
            </p>
          </>
        ) : null}

        {done && !current.running ? (
          <div className="stat-row">
            <Stat icon={MessageCircle} value={current.chats} label="Chats" />
            <Stat icon={Loader} value={current.messages} label="Nachrichten" />
            <Stat icon={HardDrive} value={current.files} label="Dateien" />
            <Stat
              icon={AlertCircle}
              value={current.errors}
              label="Probleme"
              warn={current.errors > 0}
            />
          </div>
        ) : null}

        {current.status === "failed" ? (
          <p className="dialog-error" role="alert">
            <AlertCircle size={16} />
            {/* The importer normally supplies the reason; never leave a failed
                run as a dead end with no explanation. Do not claim the archive
                is untouched -- an interrupted import keeps what it already
                fetched and can be resumed. */}
            {current.error ||
              "Der Import wurde abgebrochen. Bereits geladene Nachrichten bleiben im Archiv und werden beim nächsten Lauf wiederverwendet."}
          </p>
        ) : null}

        {current.status === "partial" && !current.running ? (
          <p className="dialog-note">
            <AlertCircle size={16} />
            {plural(current.failedChats, "Chat", "Chats")} und{" "}
            {current.failedFiles} Dateien müssen geprüft werden. Sie sind in der
            Übersicht mit „Prüfen“ markiert.
          </p>
        ) : null}

        {feed.length ? (
          <ul className="feed" aria-label="Import-Verlauf">
            {feed
              .slice()
              .reverse()
              .slice(0, 6)
              .map((line) => (
                <li key={`${line.at}-${line.message}`} className={line.level}>
                  {line.message}
                </li>
              ))}
          </ul>
        ) : null}

        {formError ? (
          <p className="dialog-error" role="alert">
            <AlertCircle size={16} />{formError}
          </p>
        ) : null}

        {!current.running && needsForm ? (
          <div className="credentials">
            <p className="credentials-note">
              {current.hasEnvCredentials
                ? "Es werden die Zugangsdaten aus der Umgebung verwendet."
                : "Die Zugangsdaten gelten nur für diesen Lauf und werden nirgends gespeichert."}
            </p>
            <Field
              id="import-email"
              label="schul.cloud E-Mail"
              type="email"
              autoComplete="username"
              value={credentials.email}
              onChange={(email) => setCredentials((c) => ({ ...c, email }))}
            />
            <Field
              id="import-password"
              label="Account-Kennwort"
              type="password"
              autoComplete="current-password"
              value={credentials.password}
              onChange={(password) => setCredentials((c) => ({ ...c, password }))}
            />
            <Field
              id="import-security"
              label="Verschlüsselungskennwort"
              type="password"
              autoComplete="current-password"
              value={credentials.securityPassword}
              onChange={(securityPassword) =>
                setCredentials((c) => ({ ...c, securityPassword }))
              }
            />
          </div>
        ) : null}

        <footer className="dialog-foot">
          {done && !current.running ? (
            <p className="dialog-proof">
              <Check size={16} />Archiv ist aktualisiert
            </p>
          ) : null}
          {!current.running ? (
            <button
              className="primary-button"
              type="button"
              onClick={begin}
              disabled={starting || (needsForm && !credentials.email)}
            >
              {starting ? (
                <>
                  <Loader size={17} className="spin" />Startet …
                </>
              ) : done ? (
                "Erneut importieren"
              ) : (
                "Import starten"
              )}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

// German needs the singular for exactly one: "1 Chat", not "1 Chats".
function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function Stat({
  icon: Icon,
  value,
  label,
  warn,
}: {
  icon: LucideIcon;
  value: number;
  label: string;
  warn?: boolean;
}) {
  return (
    <div className={`stat ${warn ? "warn" : ""}`}>
      <Icon size={17} />
      <strong>{value.toLocaleString("de-DE")}</strong>
      <span>{label}</span>
    </div>
  );
}

function Field({
  id,
  label,
  type,
  autoComplete,
  value,
  onChange,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="import-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
