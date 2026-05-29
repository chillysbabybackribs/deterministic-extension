export function hasLikelyWorkspaceWriteIntent(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (!text || !hasLocalMutationAction(text)) {
    return false;
  }

  if (hasExplicitWorkspaceTarget(value, text)) {
    return true;
  }

  return hasStructuralWorkspaceMutationAction(text) && (
    /\b(this|it|here)\b/.test(text) ||
    /\b(this|current)\s+(app|application|project|site|website|page|ui|component)\b/.test(text)
  );
}

function hasExplicitWorkspaceTarget(original: string, text: string): boolean {
  return /\b(folder|workspace|repo|repository|project|codebase|source code|application|app|website|site|component|feature|ui|files?|local|connected folder|root directory)\b/.test(text) ||
    /\bsave\b[\s\S]{0,80}\b(summary|answer|result|notes?)\b/.test(text) ||
    Boolean(extractLikelyWorkspaceFilePath(original));
}

function hasLocalMutationAction(text: string): boolean {
  return /\b(?:add|build|change|code|convert|create|develop|edit|fix|generate|implement|make|migrate|modify|overwrite|port|rebuild|recreate|redesign|refactor|repair|revamp|rewrite|save|scaffold|update|write)\b/.test(text);
}

function hasStructuralWorkspaceMutationAction(text: string): boolean {
  return /\b(?:add|build|change|code|convert|develop|edit|fix|implement|migrate|modify|port|rebuild|recreate|redesign|refactor|repair|revamp|rewrite|scaffold|update)\b/.test(text);
}

function extractLikelyWorkspaceFilePath(value: string): string | undefined {
  const quoted = Array.from(value.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g))
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .find(looksLikeWorkspaceFilePath);
  if (quoted) {
    return quoted;
  }

  const explicit = value.match(/\b(?:file|path|as|to|at|into)\s+(?:called|named)?\s*([a-z0-9_@./-]+\.[a-z0-9]{1,12})\b/i);
  if (explicit?.[1]) {
    return explicit[1];
  }

  const nested = value.match(/\b((?:[a-z0-9_@.-]+\/)+[a-z0-9_@.-]+\.[a-z0-9]{1,12})\b/i);
  if (nested?.[1]) {
    return nested[1];
  }

  const bare = value.match(/\b([a-z0-9_@-]+\.(?:md|txt|json|ts|tsx|js|jsx|css|html|yml|yaml|toml|lock|env|py|rs|go|java|swift|kt|sql))\b/i);
  return bare?.[1];
}

function looksLikeWorkspaceFilePath(value: string): boolean {
  return /(^|\/)[a-z0-9_@.-]+\.[a-z0-9]{1,12}$/i.test(value.trim().replace(/^\.\/+/, "").replace(/[),.;:!?]+$/, ""));
}
