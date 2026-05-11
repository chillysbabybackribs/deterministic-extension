import type { ReactNode } from "react";

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code"; language?: string; code: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "quote"; text: string };

export type MarkdownMessageProps = {
  content: string;
};

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  return <div className="markdown-message">{parseBlocks(content).map(renderBlock)}</div>;
}

function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(```|~~~)\s*([a-z0-9_-]+)?\s*$/i);
    if (fence) {
      const marker = fence[1];
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && lines[index].trim() !== marker) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({
        type: "code",
        language: sanitizeLanguage(fence[2]),
        code: codeLines.join("\n")
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim()
      });
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s{0,3}[-*]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];

      while (index < lines.length) {
        const item = lines[index].match(/^\s{0,3}[-*]\s+(.+)$/);
        if (!item) {
          break;
        }
        items.push(item[1].trim());
        index += 1;
      }

      blocks.push({ type: "unordered-list", items });
      continue;
    }

    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];

      while (index < lines.length) {
        const item = lines[index].match(/^\s{0,3}\d+[.)]\s+(.+)$/);
        if (!item) {
          break;
        }
        items.push(item[1].trim());
        index += 1;
      }

      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.+)$/);
    if (quote) {
      const quoteLines: string[] = [];

      while (index < lines.length) {
        const quoteLine = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!quoteLine) {
          break;
        }
        quoteLines.push(quoteLine[1]);
        index += 1;
      }

      blocks.push({ type: "quote", text: quoteLines.join("\n").trim() });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() && !isCompleteBlockStart(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    if (!paragraphLines.length) {
      blocks.push({ type: "paragraph", text: trimmed });
      index += 1;
      continue;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function isCompleteBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(```|~~~)\s*([a-z0-9_-]+)?\s*$/i.test(trimmed) ||
    /^#{1,3}\s+\S/.test(trimmed) ||
    /^\s{0,3}[-*]\s+\S/.test(line) ||
    /^\s{0,3}\d+[.)]\s+\S/.test(line) ||
    /^\s{0,3}>\s?\S/.test(line)
  );
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "heading") {
    const Tag = `h${block.level}` as "h1" | "h2" | "h3";
    return (
      <Tag className="markdown-heading" key={index}>
        {renderInline(block.text)}
      </Tag>
    );
  }

  if (block.type === "code") {
    return (
      <pre className="markdown-code-block" key={index}>
        {block.language ? <span className="markdown-code-language">{block.language}</span> : null}
        <code>{block.code}</code>
      </pre>
    );
  }

  if (block.type === "unordered-list") {
    return (
      <ul className="markdown-list" key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={`${index}_${itemIndex}`}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }

  if (block.type === "ordered-list") {
    return (
      <ol className="markdown-list" key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={`${index}_${itemIndex}`}>{renderInline(item)}</li>
        ))}
      </ol>
    );
  }

  if (block.type === "quote") {
    return (
      <blockquote className="markdown-quote" key={index}>
        {renderInline(block.text)}
      </blockquote>
    );
  }

  return (
    <p className="markdown-paragraph" key={index}>
      {renderInline(block.text)}
    </p>
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\[[^\]\n]+\]\([^) \n]+\)|\*[^*\n]+?\*|_[^_\n]+?_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    nodes.push(renderInlineToken(match[0], nodes.length));
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function renderInlineToken(token: string, key: number): ReactNode {
  if (token.startsWith("`") && token.endsWith("`")) {
    return (
      <code className="markdown-inline-code" key={key}>
        {token.slice(1, -1)}
      </code>
    );
  }

  if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
    return <strong key={key}>{renderInline(token.slice(2, -2))}</strong>;
  }

  const link = token.match(/^\[([^\]\n]+)\]\(([^) \n]+)\)$/);
  if (link) {
    const href = sanitizeHref(link[2]);
    if (!href) {
      return <span key={key}>{link[1]}</span>;
    }

    return (
      <a href={href} key={key} rel="noreferrer" target="_blank">
        {renderInline(link[1])}
      </a>
    );
  }

  if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) {
    return <em key={key}>{renderInline(token.slice(1, -1))}</em>;
  }

  return token;
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

function sanitizeLanguage(language?: string): string | undefined {
  return language?.replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || undefined;
}
