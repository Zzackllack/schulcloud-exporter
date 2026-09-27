import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, ArrowUp, CalendarDays } from "lucide-react";
import { loadMessages, loadMessagesAround, MESSAGE_PAGE_SIZE } from "../api";
import { fullDate } from "../format";
import type { Chat, Message as ArchiveMessage } from "../types";
import { Message } from "./message";

interface TimelineProps {
  chat: Chat;
  ownUserId: string | null;
}

// Within this many pixels of the bottom still counts as "following along".
const BOTTOM_SLACK = 8;

export function Timeline({ chat, ownUserId }: TimelineProps) {
  const [messages, setMessages] = useState<ArchiveMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpDate, setJumpDate] = useState("");
  const [jumping, setJumping] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  // Set when a jump replaced the window: the top of the timeline is the point
  // then, not the newest message.
  const jumped = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  // Whether the viewport should stay pinned to the newest message. Tracked from
  // scroll events so a reader working through history is never yanked back.
  const follow = useRef(true);
  const restoring = useRef(false);

  // Content keeps growing after the first paint as attachments decode, so a
  // one-shot scrollTo(bottom) lands short of the real end. Follow the growth
  // instead -- but only while the reader is already at the bottom.
  useEffect(() => {
    const element = viewport.current;
    const inner = content.current;
    if (!element || !inner) return;
    const observer = new ResizeObserver(() => {
      if (restoring.current || !follow.current || jumped.current) return;
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setMessages([]);
    setHasMore(false);
    setError(null);
    setLoading(true);
    follow.current = true;
    jumped.current = false;
    loadMessages(chat.type, chat.id, null, controller.signal)
      .then((page) => {
        setMessages(page.messages);
        setHasMore(page.messages.length === MESSAGE_PAGE_SIZE);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unbekannter Fehler");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [chat.type, chat.id]);

  function onScroll() {
    const element = viewport.current;
    // Our own scroll adjustments are not reader intent.
    if (!element || restoring.current) return;
    follow.current =
      element.scrollHeight - element.clientHeight - element.scrollTop < BOTTOM_SLACK;
  }

  async function loadOlder() {
    if (loading || !messages.length) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const element = viewport.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    // Only the newest request may release the flag: a superseded request that
    // clears it would let the observer fight the live request's own restore.
    const isCurrent = () => request.current === controller;
    setLoading(true);
    setError(null);
    // Prepending a page must not trigger the follow-to-bottom observer.
    follow.current = false;
    restoring.current = true;
    try {
      const page = await loadMessages(chat.type, chat.id, messages[0] ?? null, controller.signal);
      if (controller.signal.aborted) {
        if (isCurrent()) restoring.current = false;
        return;
      }
      setMessages((current) => [...page.messages, ...current]);
      setHasMore(page.messages.length === MESSAGE_PAGE_SIZE);
      requestAnimationFrame(() => {
        if (!element || controller.signal.aborted) return;
        // Keep the message the reader was looking at in place.
        element.scrollTop = previousTop + element.scrollHeight - previousHeight;
        if (isCurrent()) restoring.current = false;
      });
    } catch (cause) {
      if (isCurrent()) restoring.current = false;
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unbekannter Fehler");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function jumpToDate(event: FormEvent) {
    event.preventDefault();
    if (!jumpDate || jumping) return;
    setJumping(true);
    setError(null);
    try {
      const page = await loadMessagesAround(chat.type, chat.id, jumpDate, new AbortController().signal);
      jumped.current = true;
      follow.current = false;
      setMessages(page.messages);
      setHasMore(page.messages.length === MESSAGE_PAGE_SIZE);
      // Show where the window starts, not the newest message.
      requestAnimationFrame(() => {
        if (viewport.current) viewport.current.scrollTop = 0;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Datum konnte nicht geladen werden.");
    } finally {
      setJumping(false);
    }
  }

  let previousDay = "";
  return (
    <div className="timeline" ref={viewport} onScroll={onScroll} aria-live="polite">
      <div className="timeline-inner" ref={content}>
        <div className="timeline-tools">
          {hasMore ? <button className="older-button" type="button" onClick={loadOlder} disabled={loading}><ArrowUp size={16} />{loading ? "Lädt …" : "Ältere Nachrichten laden"}</button> : <span />}
          <form className="jump-form" onSubmit={jumpToDate}>
            <label className="jump-field" htmlFor="jump-date">
              <CalendarDays size={15} aria-hidden="true" />
              <span className="sr-only">Zu Datum springen</span>
              <input
                id="jump-date"
                type="date"
                value={jumpDate}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(event) => setJumpDate(event.target.value)}
              />
            </label>
            <button className="jump-button" type="submit" disabled={!jumpDate || jumping}>
              Springen
            </button>
          </form>
        </div>
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
