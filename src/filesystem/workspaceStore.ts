export type WorkspacePermissionMode = "read" | "readwrite";
export type WorkspacePermissionState = "granted" | "denied" | "prompt" | "unknown";

export type WorkspaceStatus = {
  connected: boolean;
  rootName?: string;
  connectedAt?: string;
  readPermission: WorkspacePermissionState;
  writePermission: WorkspacePermissionState;
  writeEnabled: boolean;
  supported: boolean;
};

export type WorkspaceEntry = {
  kind: "file" | "directory";
  name: string;
  path: string;
  size?: number;
  lastModified?: number;
};

export type WorkspaceReadResult = {
  path: string;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  text: string;
  lineStart?: number;
  lineEnd?: number;
  truncated: boolean;
  warnings: string[];
};

export type WorkspaceWriteResult = {
  path: string;
  bytes: number;
  createdOrOverwritten: true;
};

export type WorkspaceImageFileResult = {
  path: string;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  file: File;
};

export type WorkspaceSearchMatch = {
  path: string;
  name: string;
  kind: "file";
  matchType: "name" | "content";
  line?: number;
  preview?: string;
};

export type WorkspaceSearchResult = {
  query: string;
  rootPath: string;
  matches: WorkspaceSearchMatch[];
  scannedFiles: number;
  ignoredCount: number;
  truncated: boolean;
  warnings: string[];
};

type WorkspaceHandleKind = "file" | "directory";

type WorkspaceHandlePermissionDescriptor = {
  mode?: WorkspacePermissionMode;
};

type WorkspaceBaseHandle = {
  kind: WorkspaceHandleKind;
  name: string;
  queryPermission?: (descriptor?: WorkspaceHandlePermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (descriptor?: WorkspaceHandlePermissionDescriptor) => Promise<PermissionState>;
};

type WorkspaceFileHandle = WorkspaceBaseHandle & {
  kind: "file";
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: string | Blob | BufferSource) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type WorkspaceDirectoryHandle = WorkspaceBaseHandle & {
  kind: "directory";
  entries: () => AsyncIterableIterator<[string, WorkspaceFileSystemHandle]>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<WorkspaceDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WorkspaceFileHandle>;
};

type WorkspaceFileSystemHandle = WorkspaceFileHandle | WorkspaceDirectoryHandle;

type WorkspaceRecord = {
  key: typeof WORKSPACE_RECORD_KEY;
  handle: WorkspaceDirectoryHandle;
  rootName: string;
  connectedAt: string;
  schemaVersion?: number;
};

const DB_NAME = "ohmygod.workspace";
const DB_VERSION = 1;
const STORE_NAME = "workspace";
const WORKSPACE_RECORD_KEY = "active";
const WORKSPACE_RECORD_SCHEMA_VERSION = 2;
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = Number.MAX_SAFE_INTEGER;
const DEFAULT_READ_BYTES = 1_000_000;
const MAX_READ_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_LIST_ENTRIES = 160;
const MAX_LIST_ENTRIES = Number.MAX_SAFE_INTEGER;
const DEFAULT_SEARCH_RESULTS = 30;
const MAX_SEARCH_RESULTS = Number.MAX_SAFE_INTEGER;
const MAX_SEARCH_SCANNED_FILES = Number.MAX_SAFE_INTEGER;
const DEFAULT_SEARCH_FILE_BYTES = 1_500_000;
const MAX_SEARCH_FILE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_IMAGE_BYTES = Number.MAX_SAFE_INTEGER;
const BINARY_SAMPLE_BYTES = 4096;

export const DEFAULT_IGNORED_WORKSPACE_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  // The assistant's own runtime scratch output — large extraction dumps that
  // would otherwise be embedded and ranked as if they were source content.
  ".assistant"
] as const;

const DEFAULT_IGNORED_DIRECTORY_SET = new Set<string>(DEFAULT_IGNORED_WORKSPACE_DIRECTORIES);
const BINARY_FILE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|bz2|7z|rar|tar|mp[34]|mov|avi|webm|ogg|wav|flac|woff2?|ttf|otf|eot|exe|dll|dylib|so|wasm|class)$/i;
const IMAGE_FILE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i;
let cachedWorkspaceRecord: WorkspaceRecord | undefined;

export function workspaceNeedsWriteGrant(status: WorkspaceStatus | undefined): boolean {
  return Boolean(status?.connected && (status.writePermission === "prompt" || status.writePermission === "unknown"));
}

export function workspaceModeLabel(status: WorkspaceStatus | undefined): string {
  if (!status?.connected) {
    return status?.supported === false ? "Unavailable" : "Not connected";
  }

  if (status.writePermission === "granted") {
    return "Read/write";
  }

  if (status.writePermission === "denied") {
    return "Read only";
  }

  return "Write access needed";
}

export function clearWorkspaceHandleCache(): void {
  cachedWorkspaceRecord = undefined;
}

export async function selectWorkspaceFromPicker(): Promise<WorkspaceStatus> {
  const picker = (globalThis as typeof globalThis & {
    showDirectoryPicker?: (options?: { id?: string; mode?: WorkspacePermissionMode }) => Promise<WorkspaceDirectoryHandle>;
  }).showDirectoryPicker;

  if (!picker) {
    throw new Error("This Chrome context does not support folder access.");
  }

  const handle = await picker({
    id: "ohmygod-workspace",
    mode: "readwrite"
  });
  const permission = await requestWorkspacePermission(handle, "readwrite");
  if (permission !== "granted") {
    throw new Error("Chrome did not grant read/write access to the selected folder.");
  }

  await putWorkspaceRecord({
    key: WORKSPACE_RECORD_KEY,
    handle,
    rootName: handle.name,
    connectedAt: new Date().toISOString(),
    schemaVersion: WORKSPACE_RECORD_SCHEMA_VERSION
  });

  return getWorkspaceStatus();
}

export async function requestWorkspaceAccess(mode: WorkspacePermissionMode): Promise<WorkspaceStatus> {
  const record = await getWorkspaceRecord();
  if (!record) {
    throw new Error("No workspace folder is connected.");
  }

  const permission = await requestWorkspacePermission(record.handle, mode);
  if (permission !== "granted") {
    throw new Error(
      mode === "readwrite"
        ? "Chrome did not grant write access to the selected folder."
        : "Chrome did not grant read access to the selected folder."
    );
  }

  return getWorkspaceStatus();
}

export async function disconnectWorkspace(): Promise<void> {
  const db = await openWorkspaceDb();
  await idbRequest(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(WORKSPACE_RECORD_KEY));
  db.close();
  cachedWorkspaceRecord = undefined;
}

export async function getWorkspaceStatus(): Promise<WorkspaceStatus> {
  const supported = isWorkspaceSupported();
  const record = await getWorkspaceRecord().catch(() => undefined);
  if (!record) {
    return {
      connected: false,
      readPermission: "unknown",
      writePermission: "unknown",
      writeEnabled: false,
      supported
    };
  }

  const readPermission = await queryWorkspacePermission(record.handle, "read");
  const writePermission = await queryWorkspacePermission(record.handle, "readwrite");

  return {
    connected: true,
    rootName: record.rootName || record.handle.name,
    connectedAt: record.connectedAt,
    readPermission,
    writePermission,
    writeEnabled: writePermission !== "denied",
    supported
  };
}

export async function listWorkspaceDirectory(args: {
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
}): Promise<{ rootName: string; path: string; entries: WorkspaceEntry[]; ignoredCount: number; truncated: boolean; warnings: string[] }> {
  const record = await requireWorkspaceRecord("read");
  const parts = normalizeWorkspacePath(args.path ?? "");
  const directory = await getDirectoryAtPath(record.handle, parts, false);
  const maxEntries = clampInteger(args.maxEntries, DEFAULT_LIST_ENTRIES, 1, MAX_LIST_ENTRIES);
  const entries: WorkspaceEntry[] = [];
  const stats = { ignoredCount: 0 };
  const truncated = await collectDirectoryEntries(directory, parts, Boolean(args.recursive), maxEntries, entries, stats);
  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return left.path.localeCompare(right.path);
  });

  return {
    rootName: record.rootName || record.handle.name,
    path: formatWorkspacePath(parts),
    entries,
    ignoredCount: stats.ignoredCount,
    truncated,
    warnings: [
      ...(truncated ? [`Directory listing was capped at ${entries.length} entries.`] : []),
      ...(stats.ignoredCount ? [`Skipped ${stats.ignoredCount} ignored director${stats.ignoredCount === 1 ? "y" : "ies"} during recursive listing.`] : [])
    ]
  };
}

export async function readWorkspaceFile(args: {
  path: string;
  maxChars?: number;
  maxBytes?: number;
  lineRange?: {
    start?: number;
    end?: number;
  };
}): Promise<WorkspaceReadResult> {
  const record = await requireWorkspaceRecord("read");
  const parts = normalizeWorkspacePath(args.path);
  if (!parts.length) {
    throw new Error("A file path is required.");
  }

  const fileHandle = await getFileAtPath(record.handle, parts, false);
  const file = await fileHandle.getFile();
  const maxBytes = clampInteger(args.maxBytes, DEFAULT_READ_BYTES, 1, MAX_READ_BYTES);
  ensureFileIsReadableText(file, formatWorkspacePath(parts), maxBytes);
  await ensureFileSampleIsText(file, formatWorkspacePath(parts));
  const fullText = await file.text();
  const rangedText = applyLineRange(fullText, args.lineRange);
  const maxChars = clampInteger(args.maxChars, DEFAULT_READ_CHARS, 1, MAX_READ_CHARS);
  const text = rangedText.text.slice(0, maxChars);
  return {
    path: formatWorkspacePath(parts),
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
    text,
    lineStart: rangedText.lineStart,
    lineEnd: rangedText.lineEnd,
    truncated: rangedText.text.length > maxChars || rangedText.truncatedByRange,
    warnings: [
      ...(rangedText.truncatedByRange ? [`Returned lines ${rangedText.lineStart}-${rangedText.lineEnd} from ${file.name}.`] : []),
      ...(rangedText.text.length > maxChars ? [`${file.name} was truncated to ${text.length} characters.`] : [])
    ]
  };
}

export async function readWorkspaceImageFile(args: {
  path: string;
}): Promise<WorkspaceImageFileResult> {
  const record = await requireWorkspaceRecord("read");
  const parts = normalizeWorkspacePath(args.path);
  if (!parts.length) {
    throw new Error("An image file path is required.");
  }

  const path = formatWorkspacePath(parts);
  const fileHandle = await getFileAtPath(record.handle, parts, false);
  const file = await fileHandle.getFile();
  ensureFileIsSupportedImage(file, path);

  return {
    path,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type || mimeTypeForImagePath(path),
    file
  };
}

export async function writeWorkspaceFile(args: {
  path: string;
  content: string;
  createParents?: boolean;
}): Promise<WorkspaceWriteResult> {
  const record = await requireWorkspaceRecord("readwrite");
  const parts = normalizeWorkspacePath(args.path);
  if (!parts.length) {
    throw new Error("A file path is required.");
  }

  const fileHandle = await getFileAtPath(record.handle, parts, true, args.createParents ?? true);
  const writable = await fileHandle.createWritable();
  await writable.write(args.content);
  await writable.close();

  return {
    path: formatWorkspacePath(parts),
    bytes: new Blob([args.content]).size,
    createdOrOverwritten: true
  };
}

export async function searchWorkspace(args: {
  query: string;
  path?: string;
  includeContent?: boolean;
  maxResults?: number;
  maxBytes?: number;
}): Promise<WorkspaceSearchResult> {
  const query = args.query.trim();
  if (!query) {
    throw new Error("A search query is required.");
  }

  const record = await requireWorkspaceRecord("read");
  const parts = normalizeWorkspacePath(args.path ?? "");
  const root = await getDirectoryAtPath(record.handle, parts, false);
  const maxResults = clampInteger(args.maxResults, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const lowered = query.toLowerCase();
  const includeContent = args.includeContent ?? true;
  const maxBytes = clampInteger(args.maxBytes, DEFAULT_SEARCH_FILE_BYTES, 1, MAX_READ_BYTES);
  const matches: WorkspaceSearchMatch[] = [];
  const warnings: string[] = [];
  let scannedFiles = 0;
  let ignoredCount = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let truncated = false;

  await walkDirectory(root, parts, async (entryPath, handle) => {
    if (matches.length >= maxResults || scannedFiles >= MAX_SEARCH_SCANNED_FILES) {
      truncated = true;
      return false;
    }

    const path = formatWorkspacePath(entryPath);
    const name = handle.name;
    if (name.toLowerCase().includes(lowered) || path.toLowerCase().includes(lowered)) {
      matches.push({
        path,
        name,
        kind: "file",
        matchType: "name"
      });
      if (matches.length >= maxResults) {
        truncated = true;
        return false;
      }
    }

    if (!includeContent) {
      return true;
    }

    scannedFiles += 1;
    let file: File;
    try {
      file = await handle.getFile();
    } catch {
      warnings.push(`Could not read ${path}.`);
      return true;
    }

    if (file.size > MAX_SEARCH_FILE_BYTES) {
      skippedLargeFiles += 1;
      return true;
    }

    if (file.size > maxBytes) {
      skippedLargeFiles += 1;
      return true;
    }

    if (isProbablyBinaryByName(file.name) || !(await fileSampleLooksText(file))) {
      skippedBinaryFiles += 1;
      return true;
    }

    const text = await file.text().catch(() => "");
    if (!text) {
      return true;
    }

    const lineMatch = findLineMatch(text, lowered);
    if (lineMatch) {
      matches.push({
        path,
        name,
        kind: "file",
        matchType: "content",
        line: lineMatch.line,
        preview: lineMatch.preview
      });
    }

    if (matches.length >= maxResults) {
      truncated = true;
      return false;
    }

    return true;
  }, {
    onIgnoredDirectory: () => {
      ignoredCount += 1;
    }
  });

  if (scannedFiles >= MAX_SEARCH_SCANNED_FILES) {
    truncated = true;
    warnings.push(`Stopped after scanning ${MAX_SEARCH_SCANNED_FILES} files.`);
  }
  if (ignoredCount) {
    warnings.push(`Skipped ${ignoredCount} ignored director${ignoredCount === 1 ? "y" : "ies"}.`);
  }
  if (skippedLargeFiles) {
    warnings.push(`Skipped ${skippedLargeFiles} large file${skippedLargeFiles === 1 ? "" : "s"}.`);
  }
  if (skippedBinaryFiles) {
    warnings.push(`Skipped ${skippedBinaryFiles} binary or unsupported file${skippedBinaryFiles === 1 ? "" : "s"}.`);
  }

  return {
    query,
    rootPath: formatWorkspacePath(parts),
    matches,
    scannedFiles,
    ignoredCount,
    truncated,
    warnings
  };
}

export type WorkspaceTextFile = {
  /** Relative path from the workspace root, e.g. "src/auth/login.ts". */
  path: string;
  name: string;
  text: string;
};

export type WorkspaceTextFilesResult = {
  rootName: string;
  files: WorkspaceTextFile[];
  scanned: number;
  ignoredCount: number;
  skipped: number;
  truncated: boolean;
  warnings: string[];
};

/**
 * Walk the whole connected workspace and return every TEXT-READABLE file with
 * its content — the input for the folder→corpus ingest. Reuses the same
 * traversal + ignore-list + binary/text detection as searchWorkspace; binary
 * (by name or content sniff) and over-large files are skipped. Bounded by
 * maxFiles / maxBytesPerFile so a huge tree can't blow up memory.
 */
export async function collectWorkspaceTextFiles(options: {
  maxFiles?: number;
  maxBytesPerFile?: number;
} = {}): Promise<WorkspaceTextFilesResult> {
  const maxFiles = options.maxFiles ?? 2000;
  const maxBytesPerFile = options.maxBytesPerFile ?? MAX_SEARCH_FILE_BYTES;
  const record = await requireWorkspaceRecord("read");
  const files: WorkspaceTextFile[] = [];
  const warnings: string[] = [];
  let scanned = 0;
  let ignoredCount = 0;
  let skipped = 0;
  let truncated = false;

  await walkDirectory(record.handle, [], async (pathParts, handle) => {
    if (files.length >= maxFiles) {
      truncated = true;
      return false;
    }
    scanned += 1;
    if (isProbablyBinaryByName(handle.name)) {
      skipped += 1;
      return true;
    }
    try {
      const file = await handle.getFile();
      if (file.size > maxBytesPerFile || !(await fileSampleLooksText(file))) {
        skipped += 1;
        return true;
      }
      files.push({ path: formatWorkspacePath(pathParts), name: handle.name, text: await file.text() });
    } catch {
      skipped += 1;
    }
    return true;
  }, {
    onIgnoredDirectory: () => {
      ignoredCount += 1;
    }
  });

  if (truncated) {
    warnings.push(`Folder is large; indexed the first ${maxFiles} files. The rest were not ingested.`);
  }
  if (skipped) {
    warnings.push(`Skipped ${skipped} binary, oversized, or unreadable file${skipped === 1 ? "" : "s"}.`);
  }

  return { rootName: record.rootName, files, scanned, ignoredCount, skipped, truncated, warnings };
}

async function requireWorkspaceRecord(mode: WorkspacePermissionMode): Promise<WorkspaceRecord> {
  const record = await getWorkspaceRecord();
  if (!record) {
    throw new Error("No workspace folder is connected. Open Settings and connect a folder first.");
  }

  const permission = await queryWorkspacePermission(record.handle, mode);
  if (permission === "granted") {
    return record;
  }

  if (mode === "read" && permission !== "denied") {
    return record;
  }

  const requested = permission === "prompt" || permission === "unknown"
    ? await requestWorkspacePermission(record.handle, mode)
    : permission;
  if (requested !== "granted") {
    throw new Error(
      mode === "readwrite"
        ? "Chrome did not grant write access to the selected folder. Select the folder again if Chrome asks for it."
        : "Chrome did not grant read access to the selected folder. Select the folder again if Chrome asks for it."
    );
  }

  return record;
}

async function collectDirectoryEntries(
  directory: WorkspaceDirectoryHandle,
  baseParts: string[],
  recursive: boolean,
  maxEntries: number,
  entries: WorkspaceEntry[],
  stats: { ignoredCount: number }
): Promise<boolean> {
  const handles = await sortedDirectoryHandles(directory);
  for (const [name, handle] of handles) {
    if (entries.length >= maxEntries) {
      return true;
    }

    const pathParts = [...baseParts, name];
    const entry: WorkspaceEntry = {
      kind: handle.kind,
      name,
      path: formatWorkspacePath(pathParts)
    };

    if (handle.kind === "file") {
      const file = await handle.getFile().catch(() => undefined);
      entry.size = file?.size;
      entry.lastModified = file?.lastModified;
    }

    entries.push(entry);

    if (recursive && handle.kind === "directory") {
      if (shouldIgnoreWorkspaceDirectory(name)) {
        stats.ignoredCount += 1;
        continue;
      }

      const childTruncated = await collectDirectoryEntries(handle, pathParts, recursive, maxEntries, entries, stats);
      if (childTruncated) {
        return true;
      }
    }
  }

  return false;
}

async function walkDirectory(
  directory: WorkspaceDirectoryHandle,
  baseParts: string[],
  visitFile: (pathParts: string[], handle: WorkspaceFileHandle) => Promise<boolean>,
  options?: {
    onIgnoredDirectory?: (pathParts: string[]) => void;
  }
): Promise<boolean> {
  const handles = await sortedDirectoryHandles(directory);
  for (const [name, handle] of handles) {
    const pathParts = [...baseParts, name];
    if (handle.kind === "directory") {
      if (shouldIgnoreWorkspaceDirectory(name)) {
        options?.onIgnoredDirectory?.(pathParts);
        continue;
      }

      const shouldContinue = await walkDirectory(handle, pathParts, visitFile, options);
      if (!shouldContinue) {
        return false;
      }
      continue;
    }

    const shouldContinue = await visitFile(pathParts, handle);
    if (!shouldContinue) {
      return false;
    }
  }

  return true;
}

async function sortedDirectoryHandles(
  directory: WorkspaceDirectoryHandle
): Promise<Array<[string, WorkspaceFileSystemHandle]>> {
  const entries: Array<[string, WorkspaceFileSystemHandle]> = [];
  for await (const entry of directory.entries()) {
    entries.push(entry);
  }

  return entries.sort((left, right) => {
    if (left[1].kind !== right[1].kind) {
      return left[1].kind === "directory" ? -1 : 1;
    }

    return left[0].localeCompare(right[0]);
  });
}

async function getDirectoryAtPath(
  root: WorkspaceDirectoryHandle,
  parts: string[],
  create: boolean
): Promise<WorkspaceDirectoryHandle> {
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create });
  }

  return current;
}

async function getFileAtPath(
  root: WorkspaceDirectoryHandle,
  parts: string[],
  create: boolean,
  createParents = false
): Promise<WorkspaceFileHandle> {
  const parentParts = parts.slice(0, -1);
  const fileName = parts.at(-1);
  if (!fileName) {
    throw new Error("A file name is required.");
  }

  const parent = await getDirectoryAtPath(root, parentParts, createParents);
  return parent.getFileHandle(fileName, { create });
}

export function normalizeWorkspacePath(path: string): string[] {
  if (path.includes("\0")) {
    throw new Error("Workspace paths cannot contain null bytes.");
  }

  const normalized = decodePathForValidation(path).replace(/\\/g, "/").trim();
  if (!normalized || normalized === ".") {
    return [];
  }

  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error("Workspace paths must be relative to the connected folder.");
  }

  const parts = normalized.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === ".." || part.includes("\0")) {
      throw new Error("Workspace paths cannot contain dot segments or null bytes.");
    }
  }

  return parts;
}

function decodePathForValidation(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function formatWorkspacePath(parts: string[]): string {
  return parts.join("/");
}

function findLineMatch(text: string, loweredQuery: string): { line: number; preview: string } | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.toLowerCase().includes(loweredQuery)) {
      return {
        line: index + 1,
        preview: line.replace(/\s+/g, " ").trim().slice(0, 300)
      };
    }
  }

  return undefined;
}

function ensureFileIsReadableText(file: File, path: string, maxBytes: number): void {
  if (file.size > maxBytes) {
    throw new Error(`File is too large to read safely: ${path} is ${file.size} bytes (limit ${maxBytes}).`);
  }

  if (isProbablyBinaryByName(file.name)) {
    throw new Error(`Unsupported binary file type: ${path}.`);
  }
}

async function ensureFileSampleIsText(file: File, path: string): Promise<void> {
  if (!(await fileSampleLooksText(file))) {
    throw new Error(`Unsupported binary or non-text file: ${path}.`);
  }
}

async function fileSampleLooksText(file: File): Promise<boolean> {
  const sample = await file.slice(0, Math.min(file.size, BINARY_SAMPLE_BYTES)).text().catch(() => "");
  return !looksBinary(sample);
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 1200);
  return sample.includes("\0");
}

function isProbablyBinaryByName(name: string): boolean {
  return BINARY_FILE_EXTENSION_PATTERN.test(name);
}

function ensureFileIsSupportedImage(file: File, path: string): void {
  if (!IMAGE_FILE_EXTENSION_PATTERN.test(file.name) && !IMAGE_FILE_EXTENSION_PATTERN.test(path)) {
    throw new Error(`Unsupported image file type: ${path}.`);
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large to open safely: ${path} is ${file.size} bytes (limit ${MAX_IMAGE_BYTES}).`);
  }
}

function mimeTypeForImagePath(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    default:
      return "";
  }
}

function shouldIgnoreWorkspaceDirectory(name: string): boolean {
  return DEFAULT_IGNORED_DIRECTORY_SET.has(name);
}

function applyLineRange(
  text: string,
  lineRange?: {
    start?: number;
    end?: number;
  }
): {
  text: string;
  lineStart?: number;
  lineEnd?: number;
  truncatedByRange: boolean;
} {
  if (!lineRange || (lineRange.start === undefined && lineRange.end === undefined)) {
    return { text, truncatedByRange: false };
  }

  const lines = text.split(/\r?\n/);
  const start = clampInteger(lineRange.start, 1, 1, Math.max(lines.length, 1));
  const end = clampInteger(lineRange.end, Math.min(lines.length, start + 199), start, lines.length);
  return {
    text: lines.slice(start - 1, end).join("\n"),
    lineStart: start,
    lineEnd: end,
    truncatedByRange: start > 1 || end < lines.length
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function isWorkspaceSupported(): boolean {
  return "indexedDB" in globalThis;
}

async function queryWorkspacePermission(
  handle: WorkspaceDirectoryHandle,
  mode: WorkspacePermissionMode
): Promise<WorkspacePermissionState> {
  if (!handle.queryPermission) {
    return "unknown";
  }

  return handle.queryPermission({ mode }).catch(() => "unknown");
}

async function requestWorkspacePermission(
  handle: WorkspaceDirectoryHandle,
  mode: WorkspacePermissionMode
): Promise<WorkspacePermissionState> {
  if (!handle.requestPermission) {
    return "unknown";
  }

  return handle.requestPermission({ mode }).catch(() => "unknown");
}

async function getWorkspaceRecord(): Promise<WorkspaceRecord | undefined> {
  if (cachedWorkspaceRecord?.schemaVersion === WORKSPACE_RECORD_SCHEMA_VERSION) {
    return cachedWorkspaceRecord;
  }

  const db = await openWorkspaceDb();
  const record = await idbRequest<WorkspaceRecord | undefined>(
    db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(WORKSPACE_RECORD_KEY)
  );
  db.close();
  if (!record) {
    cachedWorkspaceRecord = undefined;
    return undefined;
  }

  if (record.schemaVersion === WORKSPACE_RECORD_SCHEMA_VERSION) {
    cachedWorkspaceRecord = record;
    return record;
  }

  const migratedRecord = {
    ...record,
    schemaVersion: WORKSPACE_RECORD_SCHEMA_VERSION
  };
  await putWorkspaceRecord(migratedRecord);
  cachedWorkspaceRecord = migratedRecord;
  return migratedRecord;
}

async function putWorkspaceRecord(record: WorkspaceRecord): Promise<void> {
  const db = await openWorkspaceDb();
  await idbRequest(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record));
  db.close();
  cachedWorkspaceRecord = record;
}

async function openWorkspaceDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: "key" });
    }
  };

  return idbRequest(request);
}

function idbRequest<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}
