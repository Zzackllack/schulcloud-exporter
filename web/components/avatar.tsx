import { Hash } from 'lucide-react';
import { initials } from '../format';
import { useState } from 'react';

interface AvatarProps {
  title: string;
  hash?: string | null;
  channel?: boolean;
  small?: boolean;
}

export function Avatar({ title, hash, channel = false, small = false }: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  // If no hash, we don't need to load anything
  if (!hash) {
    return (
      <span
        className={`avatar ${small ? 'avatar-small' : ''} ${channel ? 'avatar-channel' : ''}`}
        aria-hidden="true"
      >
        {channel ? <Hash size={small ? 16 : 21} strokeWidth={2} /> : initials(title)}
      </span>
    );
  }

  return (
    <span
      className={`avatar ${small ? 'avatar-small' : ''} ${channel ? 'avatar-channel' : ''} ${!loaded ? 'loading' : ''}`}
      aria-hidden="true"
    >
      <img
        src={`/media/${hash}`}
        alt=""
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => {
          setError(true);
          setLoaded(true);
        }}
        className={loaded ? 'loaded' : ''}
      />
      {error && channel && <Hash size={small ? 16 : 21} strokeWidth={2} />}
      {error && !channel && initials(title)}
    </span>
  );
}
