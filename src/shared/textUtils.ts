const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\""
};

export function clipWithTruncation(value: string, maxChars: number, reserveChars = 28): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - reserveChars))}\n[truncated ${value.length - maxChars + reserveChars} chars]`;
}

export function clipMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const marker = `\n[... truncated ${value.length - maxChars} chars ...]\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available * 0.45);
  const tailChars = Math.max(0, available - headChars);

  return `${value.slice(0, headChars).trimEnd()}${marker}${value.slice(value.length - tailChars).trimStart()}`;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function matchFirst(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}

export function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

export function cleanText(value: string): string {
  return decodeHtml(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, entity: string) => HTML_ENTITIES[entity.toLowerCase()] ?? match);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Single-word terms match on word boundaries (so "cat" does not hit "category");
 * multi-word phrases fall back to substring containment. Lifted from the page
 * snapshot's targeted-section matcher so file-corpus ranking shares one matcher.
 * `text` is expected to already be lowercased by the caller.
 */
export function termMatch(text: string, term: string): boolean {
  if (/\s/.test(term)) {
    return text.includes(term);
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * A small, explicit English stopword set. It is part of the deterministic
 * retrieval contract (it changes which tokens count), so keep it tiny and
 * unit-tested rather than pulling a large external list.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do",
  "does", "for", "from", "had", "has", "have", "he", "her", "him", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "me", "my", "no", "nor", "not",
  "of", "on", "or", "our", "out", "she", "so", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "too", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "would", "you", "your"
]);

/**
 * Tokenize text into lowercase search terms: split on non-alphanumeric, drop
 * tokens shorter than two characters, and drop stopwords. Deterministic — the
 * basis for both index building and query parsing.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}
