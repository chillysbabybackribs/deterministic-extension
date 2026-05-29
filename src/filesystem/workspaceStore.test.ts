import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectWorkspace,
  getWorkspaceStatus,
  listWorkspaceDirectory,
  normalizeWorkspacePath,
  readWorkspaceImageFile,
  readWorkspaceFile,
  searchWorkspace,
  selectWorkspaceFromPicker,
  clearWorkspaceHandleCache,
  writeWorkspaceFile
} from "./workspaceStore";

type FakePermission = PermissionState;

class FakeFileHandle {
  readonly kind = "file" as const;

  constructor(
    public name: string,
    private file: File
  ) {}

  async getFile(): Promise<File> {
    return this.file;
  }

  async createWritable(): Promise<{ write: (data: string | Blob | BufferSource) => Promise<void>; close: () => Promise<void> }> {
    return {
      write: async (data) => {
        this.file = data instanceof Blob
          ? new File([data], this.name, { type: data.type, lastModified: Date.now() })
          : new File([String(data)], this.name, { type: "text/plain", lastModified: Date.now() });
      },
      close: async () => undefined
    };
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;
  private children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();

  constructor(
    public name: string,
    private readPermission: FakePermission = "granted",
    private writePermission: FakePermission = "granted",
    private grantWriteOnRequest = false
  ) {}

  addFile(path: string, content: string | File): void {
    const parts = path.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
      throw new Error("file name required");
    }

    const directory = this.ensureDirectory(parts);
    directory.children.set(fileName, new FakeFileHandle(
      fileName,
      typeof content === "string" ? new File([content], fileName, { type: "text/plain", lastModified: Date.now() }) : content
    ));
  }

  async queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<FakePermission> {
    return descriptor?.mode === "readwrite" ? this.writePermission : this.readPermission;
  }

  async requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<FakePermission> {
    if (descriptor?.mode === "readwrite" && this.writePermission === "prompt" && this.grantWriteOnRequest) {
      this.writePermission = "granted";
    }

    return descriptor?.mode === "readwrite" ? this.writePermission : this.readPermission;
  }

  setPermissions(readPermission: FakePermission, writePermission: FakePermission): void {
    this.readPermission = readPermission;
    this.writePermission = writePermission;
  }

  setGrantWriteOnRequest(value: boolean): void {
    this.grantWriteOnRequest = value;
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of this.children.entries()) {
      yield entry;
    }
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") {
      return existing;
    }
    if (existing) {
      throw new Error(`${name} is not a directory`);
    }
    if (!options?.create) {
      throw new Error(`Directory not found: ${name}`);
    }

    const directory = new FakeDirectoryHandle(name, this.readPermission, this.writePermission, this.grantWriteOnRequest);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.children.get(name);
    if (existing?.kind === "file") {
      return existing;
    }
    if (existing) {
      throw new Error(`${name} is not a file`);
    }
    if (!options?.create) {
      throw new Error(`File not found: ${name}`);
    }

    const file = new FakeFileHandle(name, new File([""], name, { type: "text/plain", lastModified: Date.now() }));
    this.children.set(name, file);
    return file;
  }

  private ensureDirectory(parts: string[]): FakeDirectoryHandle {
    let current: FakeDirectoryHandle = this;
    for (const part of parts) {
      const existing = current.children.get(part);
      if (existing?.kind === "directory") {
        current = existing;
        continue;
      }

      const directory = new FakeDirectoryHandle(part, this.readPermission, this.writePermission, this.grantWriteOnRequest);
      current.children.set(part, directory);
      current = directory;
    }

    return current;
  }
}

const idbState = new Map<string, unknown>();

type MutableRequest<T> = IDBRequest<T> & {
  result: T;
  error: DOMException | null;
  onsuccess: ((this: IDBRequest<T>, event: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, event: Event) => unknown) | null;
  onupgradeneeded?: ((event: IDBVersionChangeEvent) => unknown) | null;
};

beforeEach(() => {
  idbState.clear();
  clearWorkspaceHandleCache();
  vi.stubGlobal("indexedDB", makeIndexedDb());
  vi.stubGlobal("showDirectoryPicker", vi.fn());
});

describe("workspace store safety", () => {
  it("normalizes safe relative paths and rejects traversal or absolute paths", () => {
    expect(normalizeWorkspacePath("src/app.ts")).toEqual(["src", "app.ts"]);
    for (const value of [
      "../outside.txt",
      "..\\outside.txt",
      "/tmp/outside.txt",
      "C:\\outside.txt",
      "C:/outside.txt",
      "..",
      "safe/%2e%2e/outside.txt",
      "bad\0name.txt"
    ]) {
      expect(() => normalizeWorkspacePath(value)).toThrow();
    }
    expect(normalizeWorkspacePath(".")).toEqual([]);
  });

  it("enables writes by default for newly connected workspaces", async () => {
    const root = new FakeDirectoryHandle("repo");
    pickerMock().mockResolvedValue(root);
    await selectWorkspaceFromPicker();

    await expect(writeWorkspaceFile({ path: "notes.txt", content: "hello" })).resolves.toMatchObject({
      path: "notes.txt",
      bytes: 5
    });
    await expect(writeWorkspaceFile({ path: "../outside.txt", content: "nope" })).rejects.toThrow();
    await expect(disconnectWorkspace()).resolves.toBeUndefined();
  });

  it("keeps connected workspaces read/write ready when Chrome will prompt again", async () => {
    const root = new FakeDirectoryHandle("repo");
    pickerMock().mockResolvedValue(root);
    await selectWorkspaceFromPicker();

    root.setPermissions("granted", "prompt");

    await expect(getWorkspaceStatus()).resolves.toMatchObject({
      connected: true,
      writePermission: "prompt",
      writeEnabled: true
    });
  });

  it("requests write permission on write when Chrome is in prompt state", async () => {
    const root = new FakeDirectoryHandle("repo");
    pickerMock().mockResolvedValue(root);
    await selectWorkspaceFromPicker();

    root.setPermissions("granted", "prompt");
    root.setGrantWriteOnRequest(true);

    await expect(writeWorkspaceFile({ path: "notes.txt", content: "hello" })).resolves.toMatchObject({
      path: "notes.txt",
      bytes: 5
    });
    await expect(getWorkspaceStatus()).resolves.toMatchObject({
      writePermission: "granted",
      writeEnabled: true
    });
  });

  it("migrates legacy workspace records and derives write readiness from browser permission", async () => {
    const root = new FakeDirectoryHandle("repo");
    idbState.set("active", {
      key: "active",
      handle: root,
      rootName: "repo",
      connectedAt: "2026-05-11T12:00:00.000Z",
      writeEnabled: false
    });

    await expect(getWorkspaceStatus()).resolves.toMatchObject({
      connected: true,
      writePermission: "granted",
      writeEnabled: true
    });
    await expect(writeWorkspaceFile({ path: "notes.txt", content: "hello" })).resolves.toMatchObject({
      path: "notes.txt",
      bytes: 5
    });
  });

  it("rejects huge and binary files before reading full text", async () => {
    const root = new FakeDirectoryHandle("repo");
    const huge = makeGuardedFile("huge.txt", 3_000_000, "plain", true);
    const binary = makeGuardedFile("image.png", 20, "\0PNG", true);
    root.addFile("huge.txt", huge);
    root.addFile("image.png", binary);
    pickerMock().mockResolvedValue(root);
    await selectWorkspaceFromPicker();

    await expect(readWorkspaceFile({ path: "huge.txt", maxBytes: 1000 })).rejects.toThrow("too large");
    await expect(readWorkspaceFile({ path: "image.png" })).rejects.toThrow("Unsupported binary");
  });

  it("returns supported workspace image files for browser viewing", async () => {
    const root = new FakeDirectoryHandle("repo");
    const image = new File(["image-bytes"], "logo.png", { type: "image/png", lastModified: Date.now() });
    root.addFile("assets/logo.png", image);
    root.addFile("assets/notes.txt", "not an image");
    pickerMock().mockResolvedValue(root);
    await selectWorkspaceFromPicker();

    await expect(readWorkspaceImageFile({ path: "assets/logo.png" })).resolves.toMatchObject({
      path: "assets/logo.png",
      name: "logo.png",
      type: "image/png",
      file: image
    });
    await expect(readWorkspaceImageFile({ path: "assets/notes.txt" })).rejects.toThrow("Unsupported image");
  });

  it("returns bounded read excerpts with line metadata", async () => {
    const root = new FakeDirectoryHandle("repo");
    root.addFile("README.md", ["one", "two", "three", "four"].join("\n"));
    pickerMock().mockResolvedValue(root);
    await selectWorkspaceFromPicker();

    await expect(readWorkspaceFile({ path: "README.md", lineRange: { start: 2, end: 3 } })).resolves.toMatchObject({
      path: "README.md",
      text: "two\nthree",
      lineStart: 2,
      lineEnd: 3,
      truncated: true
    });
  });

  it("skips ignored directories during recursive list and search", async () => {
    const root = new FakeDirectoryHandle("repo");
    root.addFile("src/app.ts", "const token = 'visible';");
    root.addFile("node_modules/pkg/index.js", "const token = 'ignored';");
    pickerMock().mockResolvedValue(root);
    await selectWorkspaceFromPicker();

    const listing = await listWorkspaceDirectory({ path: "", recursive: true, maxEntries: 50 });
    expect(listing.entries.map((entry) => entry.path)).toContain("src/app.ts");
    expect(listing.entries.map((entry) => entry.path)).not.toContain("node_modules/pkg/index.js");
    expect(listing.ignoredCount).toBe(1);

    const search = await searchWorkspace({ query: "ignored", path: "", includeContent: true });
    expect(search.matches).toEqual([]);
    expect(search.ignoredCount).toBe(1);
    expect(search.warnings.join(" ")).toContain("Skipped 1 ignored directory");
  });
});

function makeGuardedFile(name: string, size: number, sample: string, failOnText: boolean): File {
  return {
    name,
    size,
    type: "",
    lastModified: Date.now(),
    slice: () => ({
      text: async () => sample
    }),
    text: async () => {
      if (failOnText) {
        throw new Error("full text should not be read");
      }
      return sample;
    }
  } as unknown as File;
}

function pickerMock(): ReturnType<typeof vi.fn> {
  return (globalThis as unknown as { showDirectoryPicker: ReturnType<typeof vi.fn> }).showDirectoryPicker;
}

function makeIndexedDb(): IDBFactory {
  return {
    open: () => {
      const request = makeRequest<IDBDatabase>();
      const db = makeDb();
      request.result = db;
      queueMicrotask(() => {
        request.onupgradeneeded?.({} as IDBVersionChangeEvent);
        request.onsuccess?.({} as Event);
      });
      return request;
    }
  } as unknown as IDBFactory;
}

function makeDb(): IDBDatabase {
  return {
    objectStoreNames: {
      contains: () => true
    },
    createObjectStore: () => ({}),
    transaction: () => ({
      objectStore: () => ({
        get: (key: string) => deferredRequest(idbState.get(key)),
        put: (value: { key: string }) => {
          idbState.set(value.key, value);
          return deferredRequest(undefined);
        },
        delete: (key: string) => {
          idbState.delete(key);
          return deferredRequest(undefined);
        }
      })
    }),
    close: () => undefined
  } as unknown as IDBDatabase;
}

function deferredRequest<T>(result: T): IDBRequest<T> {
  const request = makeRequest<T>();
  request.result = result;
  queueMicrotask(() => request.onsuccess?.({} as Event));
  return request;
}

function makeRequest<T>(): MutableRequest<T> {
  return {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null
  } as unknown as IDBRequest<T>;
}
