import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowLeft, Cloud, Download, LockKeyhole, ShieldCheck } from "lucide-react";
import { Link, useMatch } from "react-router";
import { exportUrl, loadArchive, loadImportState, streamImport } from "./api";
import { Avatar } from "./components/avatar";
import { ImportPanel } from "./components/import-panel";
import { Sidebar } from "./components/sidebar";
import { Timeline } from "./components/timeline";
import type { Chat, ImportState, Summary } from "./types";

export function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const match = useMatch("/chats/:type/:id");
  const { type, id } = match?.params ?? {};
  const selected = chats.find((chat) => chat.type === type && chat.id === id);
  const showingChat = Boolean(type && id);

  // One stream for the app: the sidebar button has to know an import is
  // running even while the dialog is closed, and a second EventSource in the
  // panel would just duplicate every frame.
  useEffect(() => {
    const controller = new AbortController();
    loadImportState(controller.signal)
      .then(setImportState)
      .catch(() => {});
    const stop = streamImport(setImportState);
    return () => {
      controller.abort();
      stop();
    };
  }, []);

  const reload = useCallback(() => {
    const controller = new AbortController();
    loadArchive(controller.signal)
      .then((data) => {
        setChats(data.chats);
        setSummary(data.summary);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unbekannter Fehler");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => reload(), [reload]);

  return (
    <div className={`app-shell ${showingChat ? "chat-open" : ""}`}>
      <nav className="rail" aria-label="Archiv">
        <Link className="brand-mark" to="/" aria-label="Zur Chatübersicht"><Cloud size={28} strokeWidth={2.1} /></Link>
        <span className="rail-label">Schulcloud<br />Archiv</span>
        <div className="rail-bottom"><LockKeyhole size={18} /><span>Lokal & privat</span></div>
      </nav>
      <Sidebar
        chats={chats}
        summary={summary}
        error={error}
        importing={Boolean(importState?.running)}
        onImport={() => setImportOpen(true)}
        panel={
          importOpen ? (
            <ImportPanel
              state={importState}
              onClose={() => setImportOpen(false)}
              onFinished={reload}
            />
          ) : null
        }
      />
      <main className="conversation">
        {selected ? (
          <>
            <header className="conversation-header">
              <Link className="back-button" to="/" aria-label="Zurück zur Chatliste"><ArrowLeft size={20} /></Link>
              <Avatar title={selected.title} hash={selected.avatar_hash} channel={selected.type === "channel"} />
              <div className="conversation-title">
                <h2>{selected.title}</h2>
                <p>{selected.type === "channel" ? "Channel" : "Direktnachricht"} <span aria-hidden="true">·</span> {selected.message_count.toLocaleString("de-DE")} Nachrichten{selected.archived ? " · Archiviert" : ""}</p>
              </div>
              <div className="header-actions">
                <a
                  className="export-button"
                  href="/api/export"
                  download="schulcloud-archiv.ndjson"
                >
                  <Archive size={17} /><span>Gesamt</span>
                </a>
                <a className="export-button" href={exportUrl(selected)} download><Download size={17} /><span>JSON exportieren</span></a>
              </div>
            </header>
            {["failed", "needs-review"].includes(selected.import_state) ? <div className="import-notice" role="status"><ShieldCheck size={17} />{selected.import_error || "Dieser Chat muss nach dem Import geprüft werden."}</div> : null}
            <Timeline key={`${selected.type}/${selected.id}`} chat={selected} ownUserId={summary?.ownUserId ?? null} />
            <footer className="read-only"><LockKeyhole size={15} />Schreibgeschütztes Archiv. Es werden keine Nachrichten versendet.</footer>
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-symbol"><Cloud size={43} strokeWidth={1.6} /></div>
            <h2>{showingChat && summary ? "Chat nicht gefunden" : "Deine Gespräche bleiben bei dir."}</h2>
            <p>{showingChat && summary ? "Dieser Chat ist nicht im lokalen Archiv. Wähle einen anderen Chat aus." : "Wähle links einen Chat aus, um Nachrichten, Bilder und Dateien aus deinem lokalen Archiv anzusehen."}</p>
            <div className="welcome-proof"><ShieldCheck size={17} />Nur auf diesem Gerät gespeichert</div>
          </div>
        )}
      </main>
    </div>
  );
}
