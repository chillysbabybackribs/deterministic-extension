export function normalizeHttpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "https:" || isAllowedLocalhostHttpUrl(url)) {
    return url.href;
  }

  throw new Error("Only HTTPS URLs and localhost HTTP URLs are supported.");
}

export function isAllowedLocalhostHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

export function normalizeHttpsFetchUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are supported for background fetches.");
  }

  return url.href;
}

export function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

export function domainMatches(candidateDomain: string, targetDomain: string): boolean {
  const candidate = candidateDomain.toLowerCase().replace(/^www\./, "");
  const target = targetDomain.toLowerCase().replace(/^www\./, "");
  return candidate === target || candidate.endsWith(`.${target}`);
}

export function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function normalizeForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
