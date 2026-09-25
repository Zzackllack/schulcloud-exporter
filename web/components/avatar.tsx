import { Hash } from "lucide-react";
import { initials } from "../format";

interface AvatarProps {
  title: string;
  hash?: string | null;
  channel?: boolean;
  small?: boolean;
}

export function Avatar({ title, hash, channel = false, small = false }: AvatarProps) {
  return (
    <span className={`avatar ${small ? "avatar-small" : ""} ${channel ? "avatar-channel" : ""}`} aria-hidden="true">
      {hash ? <img src={`/media/${hash}`} alt="" loading="lazy" /> : channel ? <Hash size={small ? 16 : 21} strokeWidth={2} /> : initials(title)}
    </span>
  );
}
