import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CloudDownload,
  HardDrive,
  Loader,
  MessageCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { startImport } from "../api";
import type { ImportCredentials } from "../api";
import type { ImportState } from "../types";

interface ImportPanelProps {
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

export function ImportPanel({ state, onClose, onFinished }: ImportPanelProps) {
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
  const focused = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // A finished run has to refresh the sidebar, once, keyed on the run's end
  // time so a re-render can never fire it twice.
  useEffect(() => {
    if (current.running || !current.finishedAt) return;
    if (announced.current === current.finishedAt) return;
    announced.current = current.finishedAt;
    onFinished();
  }, [current.running, current.finishedAt, onFinished]);

  // Land focus on the first field so keyboard users are not stranded at the
  // top -- but only for a genuinely fresh start. Focusing on every progress
  // frame would yank the view around mid-run, and focusing after a run would
  // scroll the result the reader came to see out of view.
  useEffect(() => {
    if (focused.current) return;
    if (current.hasEnvCredentials || current.finishedAt) return;
    focused.current = true;
    emailRef.current?.focus();
  }, [current.hasEnvCredentials, current.finishedAt]);

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

  const needsForm = !current.hasEnvCredentials;
  const done = !current.running && Boolean(current.finishedAt);
  const outcome =
    current.status === "failed"
      ? "Import fehlgeschlagen"
      : current.status === "partial"
        ? "Import mit Rückfragen"
        : "Import abgeschlossen";

  return (
    <section className="import-panel" aria-label="Archiv importieren">
      <header className="import-head">
        <button className="import-back" type="button" onClick={onClose} aria-label="Zurück zur Chatliste">
          <ArrowLeft size={18} />
        </button>
        <div>
          <h2>Archiv importieren</h2>
          <p>
            {current.running
              ? "Läuft im Hintergrund."
              : done
                ? outcome
                : "Liest Channels und Konversationen von schul.cloud."}
          </p>
        </div>
      </header>

      <div className="import-body">
        {current.running ? (
          <div className="progress" role="progressbar" aria-label="Import läuft">
            <div className="progress-sweep" />
          </div>
        ) : null}

        {current.running || done ? (
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

        {current.running ? (
          <p className="import-current">
            {current.current
              ? `Lade ${current.current.title || current.current.id} …`
              : "Verbinde mit schul.cloud …"}
          </p>
        ) : null}

        {current.status === "failed" ? (
          <p className="panel-error" role="alert">
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
          <p className="panel-note">
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
          <p className="panel-error" role="alert">
            <AlertCircle size={16} />{formError}
          </p>
        ) : null}

        {!current.running && needsForm ? (
          <div className="credentials">
            <p className="credentials-note">
              Die Zugangsdaten gelten nur für diesen Lauf und werden nirgends
              gespeichert.
            </p>
            <Field
              id="import-email"
              label="E-Mail"
              type="email"
              autoComplete="username"
              inputRef={emailRef}
              value={credentials.email}
              onChange={(email) => setCredentials((c) => ({ ...c, email }))}
            />
            <Field
              id="import-password"
              label="Kennwort"
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

        {done && !current.running ? (
          <p className="panel-proof">
            <Check size={15} />Archiv ist aktualisiert
          </p>
        ) : null}

        {!current.running ? (
          <div className="import-action">
            <button
              className="import-start"
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
                <>
                  <CloudDownload size={17} />Import starten
                </>
              )}
            </button>
          </div>
        ) : null}
      </div>
    </section>
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
      <Icon size={16} />
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
  inputRef,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className="import-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        ref={inputRef}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
