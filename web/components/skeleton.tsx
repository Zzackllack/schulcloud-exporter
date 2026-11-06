import type { HTMLAttributes } from 'react';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Predefined shapes: 'avatar', 'avatar-small', 'text', 'circle', 'rect', 'image' */
  variant?: 'avatar' | 'avatar-small' | 'text' | 'circle' | 'rect' | 'image';
  /** Width override */
  width?: string | number;
  /** Height override */
  height?: string | number;
  /** Border radius override */
  borderRadius?: string | number;
  /** Show animation */
  animated?: boolean;
}

/**
 * Skeleton loader component with shimmer animation.
 * Use for content that loads asynchronously (images, messages, avatars).
 */
export function Skeleton({
  variant = 'rect',
  width,
  height,
  borderRadius,
  animated = true,
  className = '',
  style,
  ...props
}: SkeletonProps) {
  const sizeClasses: Record<string, string> = {
    avatar: 'w-11 h-11 rounded-[15px]',
    'avatar-small': 'w-8 h-8 rounded-[11px]',
    circle: 'rounded-full',
    text: 'h-4 rounded',
    image: 'rounded-lg',
    rect: 'rounded-md',
  };

  const variantClass = sizeClasses[variant] || 'rounded-md';

  const widthStyle = width ? { width: typeof width === 'number' ? `${width}px` : width } : {};
  const heightStyle = height ? { height: typeof height === 'number' ? `${height}px` : height } : {};
  const radiusStyle = borderRadius ? { borderRadius: typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius } : {};

  return (
    <div
      className={`skeleton ${variantClass} ${animated ? 'skeleton-animated' : ''} ${className}`}
      style={{ ...widthStyle, ...heightStyle, ...radiusStyle, ...style }}
      aria-hidden="true"
      {...props}
    />
  );
}

/** Pre-configured skeleton for avatar loading */
export function AvatarSkeleton({ small = false, className = '', ...props }: { small?: boolean } & SkeletonProps) {
  return <Skeleton variant={small ? 'avatar-small' : 'avatar'} className={className} {...props} />;
}

/** Pre-configured skeleton for message text lines */
export function TextSkeleton({ lines = 3, className = '', ...props }: { lines?: number } & SkeletonProps) {
  return (
    <div className={`space-y-2 ${className}`} {...props}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} variant="text" width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

/** Pre-configured skeleton for image attachment */
export function ImageSkeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`skeleton-image-wrapper ${className}`}>
      <Skeleton variant="image" className="aspect-[4/3] w-full" />
      <Skeleton variant="text" width="40%" className="mt-2" />
    </div>
  );
}

/** Pre-configured skeleton for a message bubble */
export function MessageSkeleton({ own = false, className = '', ...props }: { own?: boolean } & SkeletonProps) {
  return (
    <article className={`message-skeleton ${own ? 'own' : ''} ${className}`} {...props}>
      {!own && <AvatarSkeleton small />}
      <div className="message-bubble-skeleton">
        {!own && <Skeleton variant="text" width="40%" />}
        <TextSkeleton lines={3} />
        <Skeleton variant="image" width="60%" height="120px" className="mt-3" />
      </div>
    </article>
  );
}

/** Pre-configured skeleton for chat list item */
export function ChatListItemSkeleton({ className = '', ...props }: SkeletonProps) {
  return (
    <div className={`chat-row-skeleton ${className}`} {...props}>
      <AvatarSkeleton />
      <div className="chat-copy-skeleton flex-1 min-w-0">
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="text" width="40%" />
      </div>
      <div className="chat-side-skeleton">
        <Skeleton variant="text" width="50px" />
        <Skeleton variant="text" width="30px" />
      </div>
    </div>
  );
}