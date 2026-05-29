/**
 * Engine knowledge corpus + retrieval.
 *
 * Mirrors the elementCorpus pattern: build a corpus of documents (here, the
 * authored engine knowledge entries), then GREP the user's original prompt over
 * it to retrieve the entries relevant to what they were doing. The retrieved
 * entries are injected as grounding so an engine/limitation question is answered
 * accurately and tailored to the task — instead of the model improvising (which
 * got the capture facts wrong).
 *
 * Deterministic retrieval, no LLM, no chunking: the file is authored as discrete
 * entries; this ranks them by token overlap. Ranking is a simple keyword/title/
 * body token score — enough to surface "backend" entries for a backend prompt,
 * "login" entries for an auth prompt, etc. Always returns the most relevant
 * entries (and a baseline core set), since the goal is grounding, not firing.
 */

import { ENGINE_KNOWLEDGE, type EngineKnowledgeEntry } from "./engineKnowledge";

export type EngineDoc = {
  entry: EngineKnowledgeEntry;
  /** All searchable tokens for this entry (title + keywords + body), normalized. */
  tokens: Set<string>;
  /** Keyword tokens only — weighted higher than body tokens in scoring. */
  keywordTokens: Set<string>;
};

export type EngineCorpus = {
  docs: EngineDoc[];
};

/** Entries always included as baseline grounding, even on a weak query match. */
const CORE_ENTRY_IDS = new Set(["what-is-the-engine", "how-inbrowser-capture-works"]);

/** Tokens too common to carry retrieval signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "it", "this", "that",
  "what", "why", "how", "does", "do", "would", "could", "can", "with", "from", "into", "about",
  "me", "you", "i", "your", "its", "be", "are", "was", "were", "here", "there", "go", "deep"
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function buildEngineCorpus(entries: EngineKnowledgeEntry[] = ENGINE_KNOWLEDGE): EngineCorpus {
  const docs: EngineDoc[] = entries.map((entry) => {
    const keywordTokens = new Set<string>();
    for (const kw of entry.keywords) {
      for (const t of tokenize(kw)) {
        keywordTokens.add(t);
      }
    }
    const tokens = new Set<string>(keywordTokens);
    for (const t of tokenize(`${entry.title} ${entry.body}`)) {
      tokens.add(t);
    }
    return { entry, tokens, keywordTokens };
  });
  return { docs };
}

export type EngineRetrieval = {
  entries: EngineKnowledgeEntry[];
};

/**
 * Retrieve the entries most relevant to the query (the user's original prompt),
 * always including the CORE entries so every answer is grounded on what the
 * engine is + how capture actually works. Returns up to `limit` entries, ranked.
 */
export function searchEngineCorpus(
  query: string,
  corpus: EngineCorpus = buildEngineCorpus(),
  limit = 5
): EngineRetrieval {
  const queryTokens = new Set(tokenize(query));

  const scored = corpus.docs.map((doc) => {
    let score = 0;
    for (const token of queryTokens) {
      if (doc.keywordTokens.has(token)) {
        score += 2; // keyword hit weighted higher
      } else if (doc.tokens.has(token)) {
        score += 1;
      }
    }
    // Core entries get a floor so they're never ranked out of a small result set.
    if (CORE_ENTRY_IDS.has(doc.entry.id)) {
      score += 1;
    }
    return { doc, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Always include the core entries; fill the rest by score (score > 0).
  const picked: EngineKnowledgeEntry[] = [];
  const seen = new Set<string>();
  const take = (entry: EngineKnowledgeEntry) => {
    if (!seen.has(entry.id) && picked.length < limit) {
      seen.add(entry.id);
      picked.push(entry);
    }
  };

  for (const { doc } of scored) {
    if (CORE_ENTRY_IDS.has(doc.entry.id)) {
      take(doc.entry);
    }
  }
  for (const { doc, score } of scored) {
    if (score > 0) {
      take(doc.entry);
    }
  }

  return { entries: picked };
}

/**
 * Detect whether a message is asking about the engine / why a task was limited,
 * so the pipeline grounds the answer in the authored knowledge instead of letting
 * the model improvise. Covers the pill's seeded question AND the user asking in
 * their own words ("why couldn't you get that?", "what's the background engine?").
 */
export function isEngineQuestion(message: string): boolean {
  const text = message.toLowerCase();
  const mentionsEngine = /\b(background engine|the engine|local engine|companion app|full capabilities|full mode)\b/.test(text);
  const mentionsLimitWhy =
    /\b(why|what)\b/.test(text) &&
    /\b(limited|limitation|blocked|couldn't|could not|can't|cannot|restricted|unable)\b/.test(text);
  return mentionsEngine || mentionsLimitWhy;
}

/** Render retrieved entries as grounding text for the pipeline. */
export function renderEngineGrounding(retrieval: EngineRetrieval): string {
  if (!retrieval.entries.length) {
    return "";
  }
  const lines = ["Authoritative facts about the optional background engine (use these; do not contradict them):"];
  for (const entry of retrieval.entries) {
    lines.push(`- ${entry.title}: ${entry.body}`);
  }
  return lines.join("\n");
}
