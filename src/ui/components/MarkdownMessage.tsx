import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownMessageProps = {
  content: string;
};

const markdownComponents: Components = {
  a({ children, href }) {
    const safeHref = href ? sanitizeHref(href) : undefined;
    if (!safeHref) {
      return <span>{children}</span>;
    }

    // Keep links tasteful: when the visible text is just the raw URL (the model
    // often emits bare links), show a clean label — host + path, no scheme, no
    // "www.", no trailing slash — instead of the noisy https://…. Descriptive
    // link text the model wrote is left untouched.
    const display = childrenIsBareUrl(children, safeHref) ? prettyUrlLabel(safeHref) : children;

    return (
      <a href={safeHref} rel="noreferrer" target="_blank" title={safeHref}>
        {display}
      </a>
    );
  },
  blockquote({ children }) {
    return <blockquote className="markdown-quote">{children}</blockquote>;
  },
  code({ children, className }) {
    const language = languageFromClassName(className);
    return (
      <code className={language ? "markdown-code" : "markdown-inline-code"} data-language={language}>
        {children}
      </code>
    );
  },
  h1({ children }) {
    return <h1 className="markdown-heading">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="markdown-heading">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="markdown-heading">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="markdown-heading">{children}</h4>;
  },
  h5({ children }) {
    return <h5 className="markdown-heading">{children}</h5>;
  },
  h6({ children }) {
    return <h6 className="markdown-heading">{children}</h6>;
  },
  hr() {
    return <hr className="markdown-rule" />;
  },
  ol({ children }) {
    return <ol className="markdown-list">{children}</ol>;
  },
  p({ children }) {
    return <p className="markdown-paragraph">{children}</p>;
  },
  pre({ children }) {
    return <pre className="markdown-code-block">{children}</pre>;
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table className="markdown-table">{children}</table>
      </div>
    );
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  td({ children }) {
    return <td>{children}</td>;
  },
  th({ children }) {
    return <th>{children}</th>;
  },
  thead({ children }) {
    return <thead>{children}</thead>;
  },
  tr({ children }) {
    return <tr>{children}</tr>;
  },
  ul({ children }) {
    return <ul className="markdown-list">{children}</ul>;
  }
};

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="markdown-message">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** True when the link's visible text is just the URL itself (a bare/autolinked URL). */
export function childrenIsBareUrl(children: unknown, href: string): boolean {
  const text = childrenToText(children).trim();
  if (!text) {
    return false;
  }
  const stripScheme = (s: string) => s.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return text === href || stripScheme(text) === stripScheme(href);
}

/** Flatten React children to plain text (only the simple string/array cases markdown produces). */
function childrenToText(children: unknown): string {
  if (typeof children === "string") {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join("");
  }
  return "";
}

/**
 * Clean, human-readable label for a URL: drop the scheme and a leading "www.",
 * drop a bare trailing slash, and keep host (+ path) so it stays informative
 * without the https:// noise. mailto: shows just the address.
 */
export function prettyUrlLabel(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") {
      return url.pathname;
    }
    const host = url.hostname.replace(/^www\./i, "");
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${host}${path}${url.search}`;
  } catch {
    return href.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

function sanitizeHref(href: string): string | undefined {
  try {
    const parsed = new URL(href);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return href;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function languageFromClassName(className?: string): string | undefined {
  const match = className?.match(/\blanguage-([a-z0-9_-]+)\b/i);
  return match?.[1]?.slice(0, 24);
}
