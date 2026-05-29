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

    return (
      <a href={safeHref} rel="noreferrer" target="_blank" title={safeHref}>
        {children}
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
