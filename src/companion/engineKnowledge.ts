/**
 * Source of truth for the opt-in local engine ("background engine").
 *
 * This file is the AUTHORED, accurate description of the engine and every
 * limitation it addresses. It exists because, asked to "explain the engine", the
 * model otherwise improvises from generic Chrome-extension knowledge and gets it
 * WRONG (e.g. blaming CSP for what is actually a Manifest-V3 webRequest API
 * limitation, or claiming the extension can't see request contents when it can).
 *
 * Each entry is a discrete, retrievable knowledge unit. The corpus
 * (engineKnowledgeCorpus.ts) is built from these and searched with the user's
 * ORIGINAL prompt, so an engine question is answered with the entries relevant to
 * what the user was actually doing — grounded and task-tailored.
 *
 * FRAMING RULE (do not drift from this): describe the engine as a way for the
 * user to see the FULL data their OWN logged-in session already has access to —
 * for understanding and debugging what they are looking at. NOT as a tool to
 * "extract credentials / secrets". Same capability, honest, oriented to the
 * user's own goals.
 *
 * KEEP ACCURATE. When the capture stack changes, update the relevant entries —
 * this file is what the assistant tells users is true.
 */

export type EngineKnowledgeEntry = {
  /** Stable id (for tests / dedup). */
  id: string;
  /** Short human title (shown to the model as the entry heading). */
  title: string;
  /** Extra retrieval keywords beyond the title/body words (task types, synonyms). */
  keywords: string[];
  /** The authoritative explanation. Plain prose; the model paraphrases naturally. */
  body: string;
};

export const ENGINE_KNOWLEDGE: EngineKnowledgeEntry[] = [
  {
    id: "what-is-the-engine",
    title: "What the background engine is",
    keywords: ["engine", "background engine", "companion", "install", "what is", "opt in", "full mode"],
    body:
      "The background engine is an optional local app the user installs once. It runs quietly on the user's own computer and gives the extension a browser it fully controls, so it can do things the in-page extension is not allowed to do. It is fully opt-in: without it the extension works exactly as it does now, just with the in-browser limits described elsewhere. It only acts when the user asks, and can be removed anytime."
  },
  {
    id: "how-inbrowser-capture-works",
    title: "How in-browser network capture actually works (and its real limit)",
    keywords: [
      "network", "capture", "requests", "api", "endpoints", "traffic",
      "webRequest", "response body", "response bodies", "manifest v3", "mv3", "limitation", "why limited"
    ],
    body:
      "In the browser, the extension captures network traffic two ways. (1) chrome.webRequest observes every request at the network layer — it reliably sees URLs, methods, status codes, request and response HEADERS, and request bodies, on every site regardless of the page's security policy. Its one hard limit: under Manifest V3, chrome.webRequest CANNOT read response BODIES — that capability was deliberately removed from the API. (2) A page-shim patched into the page can read response bodies and WebSocket payloads, BUT it runs inside the page, so a strict site Content-Security-Policy (CSP) can block it from running. So: it is NOT true that the extension 'only sees that a request happened' — it sees a lot (URLs, methods, statuses, headers, request bodies). What it specifically cannot always get in-browser is RESPONSE bodies: webRequest can't read them (MV3), and on strict-CSP sites the shim that could is blocked."
  },
  {
    id: "what-engine-adds-network",
    title: "What the engine adds for network/API analysis",
    keywords: [
      "engine", "network", "api", "backend", "endpoints", "response body", "response bodies",
      "json", "payload", "data structure", "reverse engineer", "graphql", "websocket", "deep dive"
    ],
    body:
      "Because the engine drives its own browser, it can attach the Chrome DevTools Protocol (CDP) to the pages it loads. CDP CAN read response bodies and WebSocket frame payloads — the exact thing in-browser capture can't reliably get. So for understanding a web app's backend, the engine can show the actual JSON the app's API calls return: real field names, data shapes, and which endpoints carry which data — rather than inferring the backend from the UI alone. It does this in the engine's browser, not the user's tab, so the user's own browsing is untouched."
  },
  {
    id: "logged-in-session",
    title: "How the engine stays on the user's own logged-in session",
    keywords: ["login", "logged in", "session", "cookies", "authenticated", "account", "auth", "private", "behind login"],
    body:
      "The engine's browser starts logged OUT, so to analyze a page the user is signed into, the extension copies the cookies for that one site from the user's own browser into the engine's browser for that capture. The engine then sees exactly what the user's session sees — nothing more. This is the user looking at their own data through a tool they installed; it is not accessing anyone else's account or bypassing any login. Only the target site's cookies are used, per capture."
  },
  {
    id: "why-the-restriction-exists",
    title: "Why the in-browser restriction exists",
    keywords: ["why", "security", "restriction", "sandbox", "manifest v3", "safe", "privacy", "permission"],
    body:
      "The Manifest-V3 limit on reading response bodies is a deliberate security feature: it stops a malicious extension from silently harvesting the contents of a user's web traffic. The engine does not defeat that protection for the browser at large — it is a separate app the user explicitly installs and runs locally, operating only on pages the user points it at, using the user's own session. The restriction protects users by default; the engine is an explicit, user-controlled exception for their own debugging and understanding."
  },
  {
    id: "engine-purpose-and-trust",
    title: "What the engine is for (and what it is not)",
    keywords: ["purpose", "trust", "safe", "data", "credentials", "what does it do", "privacy", "control"],
    body:
      "The engine is for seeing the full data the user's own session already has access to, so the assistant can fully understand or debug what the user is looking at — for example, reading the real API responses behind a dashboard the user is signed into. It is not a tool for taking data the user couldn't otherwise reach. It runs locally, only on what the user asks about, sends nothing on its own, and can be uninstalled at any time."
  },
  {
    id: "task-backend-mapping",
    title: "For mapping a web app's backend / APIs",
    keywords: ["backend", "api", "endpoints", "deep", "architecture", "data model", "schema", "reverse engineer", "how it works", "server"],
    body:
      "When the goal is to understand a web app's backend — its endpoints, data model, and how the frontend talks to the server — in-browser capture gives the endpoint inventory (URLs, methods, statuses, headers) but usually not the response bodies, so the data shapes have to be inferred from the UI. With the engine, the assistant can capture the actual responses those endpoints return, turning inference into the real data model: concrete field names, nested structures, and which endpoint serves which part of the app."
  }
];
