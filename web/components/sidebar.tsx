import { Archive, AlertCircle, CloudDownload, MessageCircle, Search, X } from "lucide-react";
import { NavLink } from "react-router";
import { useDeferredValue, useState } from "react";
import type { ReactNode } from "react";
import { Avatar } from "./avatar";
import { shortDate } from "../format";
import type { Chat, Summary } from "../types";

type Filter = "all" | "channel" | "conversation";

interface SidebarProps {
  chats: Chat[];
  summary: Summary | null;
  error: string | null;
  importing: boolean;
  onImport: () => void;
  /**
   * Replaces the chat list in the scrollable middle region. The search field
   * and filters stay put, so returning to the list keeps the current query.
   */
  panel: ReactNode | null;
}

export function Sidebar({ chats, summary, error, importing, onImport, panel }: SidebarProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const deferredSearch = useDeferredValue(search);
  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: "Alle" },
    { value: "channel", label: "Channels" },
    { value: "conversation", label: "Direkt" },
  ];

  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="sidebar-top">
        <div className="sidebar-heading">
          <div>
            <p className="sidebar-kicker">Dein lokales Archiv</p>
            <h1>Unterhaltungen</h1>
          </div>
          <span className="count-pill">{summary?.chats ?? 0}</span>
        </div>
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Chats suchen</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Chats suchen" type="search" autoComplete="off" />
          {search ? <button type="button" onClick={() => setSearch("")} aria-label="Suche löschen"><X size={16} /></button> : null}
        </label>
        <div className="filters" role="group" aria-label="Chatfilter">
          {filters.map((item) => (
            <button key={item.value} type="button" className={filter === item.value ? "filter active" : "filter"} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {panel ?? (
        <ChatList
          chats={chats}
          summary={summary}
          error={error}
          filter={filter}
          deferredSearch={deferredSearch}
        />
      )}
      <footer className="sidebar-footer">
        {/* Not disabled while an import runs: this is the control you want to
            press to watch it. Leaving the panel is fine too, the import keeps
            going and the footer keeps reporting it. */}
        <button
          className={`import-button ${importing ? "running" : ""}`}
          type="button"
          onClick={onImport}
        >
          <CloudDownload size={16} />
          {importing ? "Import läuft …" : "Archiv importieren"}
        </button>
        <div className="sidebar-stat"><MessageCircle size={15} /><span>{(summary?.messages ?? 0).toLocaleString("de-DE")} Nachrichten</span></div>
        <div className="sidebar-stat"><Archive size={15} /><span>{(summary?.files ?? 0).toLocaleString("de-DE")} Dateien</span></div>
        {summary?.failed ? <div className="sidebar-stat warning"><AlertCircle size={15} /><span>{summary.failed} Chats prüfen</span></div> : null}
      </footer>
    </aside>
  );
}

function ChatList({
  chats,
  summary,
  error,
  filter,
  deferredSearch,
}: {
  chats: Chat[];
  summary: Summary | null;
  error: string | null;
  filter: Filter;
  deferredSearch: string;
}) {
  const visible = chats.filter((chat) =>
    (filter === "all" || chat.type === filter) &&
    chat.title.toLocaleLowerCase("de").includes(deferredSearch.toLocaleLowerCase("de"))
  );

  return (
    <div className="chat-list">
      {error ? <div className="sidebar-message error"><AlertCircle size={18} />Archiv konnte nicht geladen werden. {error}</div> : null}
      {!error && !summary ? <div className="sidebar-message">Chats werden geladen …</div> : null}
      {!error && summary && visible.length === 0 ? (
        <div className="sidebar-message">{chats.length ? "Keine passenden Chats gefunden." : "Noch keine Chats importiert. Starte zuerst einen Import."}</div>
      ) : null}
      {visible.map((chat) => (
        <NavLink key={`${chat.type}/${chat.id}`} to={`/chats/${chat.type}/${encodeURIComponent(chat.id)}`} className={({ isActive }) => `chat-row ${isActive ? "selected" : ""}`}>
          <Avatar title={chat.title} hash={chat.avatar_hash} channel={chat.type === "channel"} />
          <span className="chat-copy">
            <span className="chat-title">{chat.title}</span>
            <span className="chat-detail">
              {chat.type === "channel" ? "Channel" : "Direktnachricht"}
              {chat.archived ? " · Archiviert" : ""}
              {chat.import_state === "failed" || chat.import_state === "needs-review" ? " · Prüfen" : ""}
            </span>
          </span>
          <span className="chat-side">
            <span>{shortDate(chat.latest_at)}</span>
            <span className="message-count">{chat.message_count}</span>
          </span>
        </NavLink>
      ))}
    </div>
  );
}
