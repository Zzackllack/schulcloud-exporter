import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

// Messages are written by other people, so the renderer must never be able to
// execute or inject anything. react-markdown builds React elements directly --
// no dangerouslySetInnerHTML -- and leaves raw HTML in the source inert
// because rehype-raw is deliberately not installed. GFM adds the autolink
// literals that turn the bare URLs people actually paste into links.
const components: Components = {
  a({ node, href, children, ...props }) {
    void node;
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
        {children}
      </a>
    );
  },
  // Messages keep their own line breaks; collapsing them would reflow the
  // author's paragraphs into one block.
  p({ node, children, ...props }) {
    void node;
    return (
      <p {...props} className="markdown-paragraph">
        {children}
      </p>
    );
  },
};

export function MessageText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
