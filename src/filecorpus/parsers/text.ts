/**
 * Parse plain text / markdown into prose units.
 *
 * Structure is detected from three signals so both flowing prose AND
 * structured lists map well:
 *   - Headings: markdown `#`, or plain-text numbered/lettered section titles
 *     ("1. Reconnaissance", "A. Setup") — become `section` units and set the
 *     heading path carried by following units.
 *   - List items: a bullet ("- ", "* ", "• ") or a short "Name - description"
 *     entry on its own line becomes its OWN unit, so a dense list (no blank
 *     lines) does not collapse into one giant blob.
 *   - Prose: runs of longer non-list lines buffer into a paragraph, split on
 *     blank lines.
 *
 * Each unit carries the section heading stack above it.
 */

import type { ParseResult, ParsedUnit } from "./types";

const MIN_PARAGRAPH_CHARS = 24;
/** Lines at or under this length that aren't prose are treated as list items. */
const LIST_LINE_MAX_CHARS = 200;

type HeadingMatch = { level: number; text: string; number?: string };

function matchMarkdownHeading(line: string): HeadingMatch | undefined {
  const atx = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
  return atx ? { level: atx[1].length, text: atx[2].trim() } : undefined;
}

/**
 * Plain-text section heading: "1. Title", "2.3 Title", "A. Title", "Section 4 - Title".
 * Kept conservative (must look like a short title, not a sentence) so prose
 * lines that merely start with a number are not mistaken for headings. Captures
 * the section number so locators can read "§9 SQL Injection Testing".
 */
function matchPlainHeading(line: string): HeadingMatch | undefined {
  const numbered = /^(\d+(?:\.\d+)*)[.)]\s+(.{1,80})$/.exec(line);
  if (numbered && !/[.!?]$/.test(numbered[2].trim())) {
    const level = numbered[1].split(".").length;
    return { level, text: numbered[2].trim(), number: numbered[1] };
  }
  const lettered = /^([A-Z])[.)]\s+(.{1,80})$/.exec(line);
  if (lettered && !/[.!?]$/.test(lettered[2].trim())) {
    return { level: 1, text: lettered[2].trim(), number: lettered[1] };
  }
  return undefined;
}

function isListLine(line: string): boolean {
  if (/^[-*•·]\s+/.test(line)) {
    return true;
  }
  // "Name - description" / "Name — description" / "Name: value" entries on a
  // single shortish line, with no sentence punctuation ending it.
  if (line.length <= LIST_LINE_MAX_CHARS && /\S\s+[-–—:]\s+\S/.test(line) && !/[.!?]$/.test(line)) {
    return true;
  }
  return false;
}

function pushHeading(stack: HeadingMatch[], heading: HeadingMatch): void {
  while (stack.length && stack[stack.length - 1].level >= heading.level) {
    stack.pop();
  }
  stack.push(heading);
}

export function parseText(content: string, isMarkdown: boolean): ParseResult {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const units: ParsedUnit[] = [];
  const headingStack: HeadingMatch[] = [];
  let buffer: string[] = [];
  let bufferStartLine = 0;

  const headingPath = () => headingStack.map((heading) => heading.text);
  // The number of the nearest enclosing numbered/lettered section, if any.
  const currentSectionNumber = () => {
    for (let i = headingStack.length - 1; i >= 0; i -= 1) {
      if (headingStack[i].number) {
        return headingStack[i].number;
      }
    }
    return undefined;
  };

  const addressFor = (line: number) => ({
    headingPath: headingPath(),
    line,
    sectionNumber: currentSectionNumber()
  });

  const flushParagraph = () => {
    if (!buffer.length) {
      return;
    }
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    const startLine = bufferStartLine;
    buffer = [];
    if (text.length < MIN_PARAGRAPH_CHARS) {
      return;
    }
    units.push({ kind: "paragraph", text, address: addressFor(startLine), structure: {} });
  };

  const emitUnit = (kind: ParsedUnit["kind"], text: string, isHeading: boolean, line: number) => {
    units.push({
      kind,
      text,
      address: addressFor(line),
      structure: isHeading ? { isHeading: true } : {}
    });
  };

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();

    if (line === "") {
      flushParagraph();
      return;
    }

    const heading = (isMarkdown ? matchMarkdownHeading(line) : undefined) ?? matchPlainHeading(line);
    if (heading) {
      flushParagraph();
      pushHeading(headingStack, heading);
      emitUnit("section", heading.text, true, lineNumber);
      return;
    }

    if (isListLine(line)) {
      flushParagraph();
      const text = line.replace(/^[-*•·]\s+/, "").trim();
      if (text.length >= 3) {
        emitUnit("paragraph", text, false, lineNumber);
      }
      return;
    }

    if (!buffer.length) {
      bufferStartLine = lineNumber;
    }
    buffer.push(line);
  });
  flushParagraph();

  return { units, warnings: [] };
}
