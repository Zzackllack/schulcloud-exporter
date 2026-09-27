import { ExternalLink } from "lucide-react";
import type { LinkPreview } from "../types";

/**
 * A link the API unfurled: title, domain, and whatever description came with
 * it.
 *
 * The preview image is not shown on purpose -- every one of them points at a
 * third-party host, and the viewer's CSP only allows images from this origin.
 * Fetching them would turn reading a local archive into a network request to
 * whoever happened to be linked.
 */
export function LinkPreviewCard({ link }: { link: LinkPreview }) {
  return (
    <a
      className="link-preview"
      href={link.url}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
    >
      <span className="link-title">
        {link.title}
        <ExternalLink size={13} aria-hidden="true" />
      </span>
      <span className="link-domain">{domain(link.url)}</span>
      {link.description ? (
        <span className="link-description">{link.description}</span>
      ) : null}
    </a>
  );
}

function domain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
