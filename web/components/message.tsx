import { Download, FileText, ImageOff, KeyRound, LockKeyhole, LogIn, LogOut } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Avatar } from "./avatar";
import { time } from "../format";
import type { ArchiveFile, Message as ArchiveMessage } from "../types";

interface MessageProps {
  message: ArchiveMessage;
  own: boolean;
}

// Rows that carry no conversation text. Rendering them as chat bubbles produced
// either an empty bubble or, for `encrypted`, the invented name
// "Unbekannte Person" -- the API records `sender: "0"` for those, so there is
// nobody to name.
const systemEvents: Record<string, { label: string; icon: LucideIcon }> = {
  encrypted: { label: "Verschlüsselte Konversation erstellt", icon: LockKeyhole },
  joined: { label: "ist beigetreten", icon: LogIn },
  left: { label: "hat den Chat verlassen", icon: LogOut },
  key_resetted: { label: "hat den Schlüssel zurückgesetzt", icon: KeyRound },
};

export function Message({ message, own }: MessageProps) {
  // Only treat a row as a system event when it really has nothing to show, so
  // real content is never hidden behind a label.
  const event = message.text || message.files.length ? null : systemEvents[message.kind];
  if (event) {
    const Icon = event.icon;
    // sender_name is never empty (the API substitutes "Unbekannte Person"), so
    // sender_id is the honest test for whether anybody is actually known.
    const who = message.sender_id ? message.sender_name : "";
    return (
      <div className="system-message">
        <span>
          <Icon size={13} aria-hidden="true" />
          {who ? `${who} ${event.label}` : event.label}
        </span>
        <time className="system-time" dateTime={message.created_at ?? undefined}>{time(message.created_at)}</time>
      </div>
    );
  }

  const unverified = message.decryption_state === "unverified";
  return (
    <article className={`message ${own ? "own" : ""}`}>
      {!own ? <Avatar title={message.sender_name} hash={message.sender_avatar} small /> : null}
      <div className="message-bubble">
        {!own ? <div className="message-sender">{message.sender_name}</div> : null}
        {unverified ? (
          <p className="message-warning"><LockKeyhole size={15} />Verschlüsselter Inhalt konnte nicht verifiziert werden.</p>
        ) : message.text ? <p className="message-text">{message.text}</p> : null}
        {message.files.length ? <div className="attachments">{message.files.map((file) => <Attachment key={file.id} file={file} />)}</div> : null}
        {unverified ? <p className="raw-note">Der Originalwert bleibt im JSON-Export erhalten.</p> : null}
        <time className="message-time" dateTime={message.created_at ?? undefined}>{time(message.created_at)}</time>
      </div>
    </article>
  );
}

function Attachment({ file }: { file: ArchiveFile }) {
  if (!file.blob_hash) {
    return <span className="attachment unavailable"><ImageOff size={17} />{file.name} · nicht verfügbar</span>;
  }
  const href = `/media/${file.blob_hash}`;
  if (file.mime?.startsWith("image/")) {
    return <a className="image-attachment" href={href} download={file.name} aria-label={`${file.name} herunterladen`}><img src={href} alt={file.name} loading="lazy" /><span><Download size={14} />{file.name}</span></a>;
  }
  return <a className="attachment" href={href} download={file.name}><FileText size={17} /><span>{file.name}</span><Download size={15} /></a>;
}
