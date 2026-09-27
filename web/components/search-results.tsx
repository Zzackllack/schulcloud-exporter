import { useEffect, useState } from "react";
import { Link } from "react-router";
import { SearchX } from "lucide-react";
import { searchMessages } from "../api";
import { shortDate } from "../format";
import type { SearchHit } from "../types";

/** Sentinel pair the API wraps matches in. Never HTML -- see Highlight. */
const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

const DEBOUNCE_MS = 220;

export function SearchResults({ query }: { query: string }) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    // Debounced so a fast typist does not fire a query per keystroke. The
    // abort controller drops the response if a newer query has already gone.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchMessages(trimmed, controller.signal)
        .then((page) => {
          setHits(page.results);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setHits([]);
          setError(
            cause instanceof Error ? cause.message : "Suche fehlgeschlagen.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  if (query.trim().length < 2) {
    return (
      <div className="sidebar-message">
        Zwei Zeichen eingeben, um in allen Nachrichten zu suchen.
      </div>
    );
  }

  if (!hits.length && !searching && !error) {
    return (
      <div className="sidebar-message">
        Nichts gefunden für <strong>„{query.trim()}“</strong>.
      </div>
    );
  }

  if (error) {
    return <div className="sidebar-message error">Suche fehlgeschlagen: {error}</div>;
  }

  return (
    <div className="chat-list">
      <div className="search-summary" role="status">
        {searching && !hits.length
          ? "Suche läuft …"
          : `${hits.length} Treffer${hits.length === 50 ? "+" : ""} für „${query.trim()}“`}
      </div>
      {hits.map((hit) => (
        <Link
          key={`${hit.chat_type}/${hit.chat_id}/${hit.id}`}
          to={`/chats/${hit.chat_type}/${encodeURIComponent(hit.chat_id)}`}
          className="chat-row search-row"
        >
          <span className="search-copy">
            <span className="search-head">
              <span className="search-sender">{hit.sender_name}</span>
              <span className="search-chat">{hit.chat_title}</span>
              <span className="search-date">{shortDate(hit.created_at)}</span>
            </span>
            <span className="search-snippet">
              <Highlight snippet={hit.snippet} />
            </span>
          </span>
        </Link>
      ))}
      {!searching && hits.length ? (
        <div className="search-footer">
          <SearchX size={13} aria-hidden="true" />
          Nur die besten Treffer. Grenze die Suche mit weiteren Wörtern ein.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Drops the emphasis markers a snippet inherits from the stored Markdown.
 *
 * The body is stored with its `**` intact and only rendered as Markdown when a
 * full message is shown, so a two-line search result would otherwise read
 * "**Oktober**". Only the bold markers are stripped -- links and lists are
 * left alone rather than half-interpreted, and the text is never otherwise
 * altered.
 */
function tidy(text: string) {
  return text.replace(/\*\*|__/g, "");
}

/**
 * Renders a snippet with its matches highlighted.
 *
 * The API delimits matches with control characters instead of HTML tags, so the
 * body text -- which belongs to other people -- is never passed to
 * dangerouslySetInnerHTML. Splitting on the sentinels and building elements is
 * the whole point.
 */
function Highlight({ snippet }: { snippet: string }) {
  const parts: React.ReactNode[] = [];
  // Strip once, up front. A ** pair can straddle a highlight boundary, so
  // tidying each fragment separately would leave one behind.
  let rest = tidy(snippet);
  let key = 0;
  while (rest) {
    const open = rest.indexOf(MARK_OPEN);
    if (open === -1) {
      parts.push(rest);
      break;
    }
    if (open > 0) parts.push(rest.slice(0, open));
    const close = rest.indexOf(MARK_CLOSE, open + 1);
    if (close === -1) {
      parts.push(rest.slice(open + 1));
      break;
    }
    parts.push(
      <mark className="search-mark" key={`m${key++}`}>
        {rest.slice(open + 1, close)}
      </mark>,
    );
    rest = rest.slice(close + 1);
  }
  return parts.length ? parts : snippet;
}
