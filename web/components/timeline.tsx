import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUp } from "lucide-react";
import { loadMessages, MESSAGE_PAGE_SIZE } from "../api";
import { fullDate } from "../format";
import type { Chat, Message as ArchiveMessage } from "../types";
import { Message } from "./message";

interface TimelineProps {
  chat: Chat;
  ownUserId: string | null;
}

export function Timeline({ chat, ownUserId }: TimelineProps) {
  const [messages, setMessages] = useState<ArchiveMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setMessages([]);
    setHasMore(false);
    setError(null);
    setLoading(true);
    loadMessages(chat.type, chat.id, null, controller.signal)
      .then((page) => {
        setMessages(page.messages);
        setHasMore(page.messages.length === MESSAGE_PAGE_SIZE);
        requestAnimationFrame(() => {
          if (!controller.signal.aborted && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
        });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unbekannter Fehler");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [chat.type, chat.id]);

  async function loadOlder() {
    if (loading || !messages.length) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const element = viewport.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    setLoading(true);
    setError(null);
    try {
      const page = await loadMessages(chat.type, chat.id, messages[0] ?? null, controller.signal);
      if (controller.signal.aborted) return;
      setMessages((current) => [...page.messages, ...current]);
      setHasMore(page.messages.length === MESSAGE_PAGE_SIZE);
      requestAnimationFrame(() => {
        if (element && !controller.signal.aborted) element.scrollTop = previousTop + element.scrollHeight - previousHeight;
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unbekannter Fehler");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  let previousDay = "";
  return (
    <div className="timeline" ref={viewport} aria-live="polite">
      <div className="timeline-inner">
        {hasMore ? <button className="older-button" type="button" onClick={loadOlder} disabled={loading}><ArrowUp size={16} />{loading ? "Lädt …" : "Ältere Nachrichten laden"}</button> : null}
        {error ? <div className="timeline-error" role="alert"><AlertCircle size={18} />Nachrichten konnten nicht geladen werden ({error}). <button type="button" onClick={messages.length ? loadOlder : () => window.location.reload()}>Erneut versuchen</button></div> : null}
        {loading && !messages.length ? <div className="timeline-state">Nachrichten werden geladen …</div> : null}
        {!loading && !error && !messages.length ? <div className="timeline-state">In diesem Chat sind keine Nachrichten gespeichert.</div> : null}
        {messages.map((message) => {
          const day = message.created_at?.slice(0, 10) ?? "";
          const divider = day && day !== previousDay ? <div className="date-divider" key={`day-${day}-${message.id}`}><span>{fullDate(message.created_at!)}</span></div> : null;
          previousDay = day;
          return <div key={message.id}>{divider}<Message message={message} own={message.sender_id !== null && message.sender_id === ownUserId} /></div>;
        })}
      </div>
    </div>
  );
}
