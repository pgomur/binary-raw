/**
 * @file Test suite for recents.ts - IndexedDB recent files management
 * Uses fake-indexeddb for realistic but synchronous testing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Setup fake-indexeddb before any imports
import "fake-indexeddb/auto";

// Mock dependencies
vi.mock("@utils/storage", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/storage")>("@utils/storage");
  return {
    ...actual,
    deleteFileBuffer: vi.fn(),
    getDB: vi.fn(),
  };
});

// Mock Bytes.create to return branded ByteCount
vi.mock("@app-types/index", () => ({
  Bytes: {
    create: vi.fn((size: number) => size as ByteCount),
  },
}));

import { loadRecents, saveRecent, removeRecent, updateRecent, togglePinRecent, touchRecent, clearRecents, findRecentById, findRecentByName, getPinnedRecents, type RemoveStrategy, type UpdatableFields } from "../../src/utils/recents";
import { getDB, deleteFileBuffer, StorageError, STORE_RECENTS } from "../../src/utils/storage";
import type { RecentFileEntry, ByteCount, FileFormat } from "../../src/types/index";

// Helper para crear ByteCount branded type
const createByteCount = (n: number): ByteCount => n as ByteCount;

// Test data factories - FileFormat es union type literal, no branded
const createMockRecent = (overrides: Partial<RecentFileEntry> = {}): RecentFileEntry => ({
  id: "test-id-1",
  name: "test-file.bin",
  size: createByteCount(1024),
  format: "BIN",
  lastOpened: new Date("2024-01-15T10:00:00Z").toISOString(),
  pinned: false,
  tags: [],
  ...overrides,
});

/**
 * Serialized format for RecentFileEntry in IndexedDB.
 * Copied from source for testing purposes (not exported).
 */
interface SerializedRecent {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly format: string;
  readonly lastOpened: string;
  readonly pinned?: boolean;
  readonly tags?: string[];
}

const createMockSerializedRecent = (overrides: Partial<Record<string, unknown>> = {}): SerializedRecent => ({
  id: "test-id-1",
  name: "test-file.bin",
  size: 1024,
  format: "BIN",
  lastOpened: "2024-01-15T10:00:00.000Z",
  pinned: false,
  tags: [],
  ...overrides,
});

/**
 * Type guard to validate serialized recent entry.
 * Copied from source for testing purposes (not exported).
 */
function isValidSerializedRecent(obj: unknown): obj is SerializedRecent {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;

  return typeof r["id"] === "string" && typeof r["name"] === "string" && typeof r["size"] === "number" && r["size"] >= 0 && Number.isInteger(r["size"]) && typeof r["format"] === "string" && typeof r["lastOpened"] === "string" && !isNaN(Date.parse(r["lastOpened"] as string));
}

/**
 * Converts serialized data to RecentFileEntry.
 * Copied from source for testing purposes (not exported).
 */
function deserializeRecent(serialized: SerializedRecent): RecentFileEntry {
  return {
    id: serialized.id,
    name: serialized.name,
    size: createByteCount(serialized.size),
    format: serialized.format as FileFormat,
    lastOpened: serialized.lastOpened,
    pinned: serialized.pinned ?? false,
    tags: Array.isArray(serialized.tags) ? serialized.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

/**
 * Converts RecentFileEntry to storable format.
 * Copied from source for testing purposes (not exported).
 */
function serializeRecent(entry: RecentFileEntry): SerializedRecent {
  return {
    id: entry.id,
    name: entry.name,
    size: entry.size as number,
    format: entry.format,
    lastOpened: entry.lastOpened,
    pinned: entry.pinned,
    tags: [...entry.tags],
  };
}

// Helper to create a real fake IndexedDB instance
async function createFakeDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("test-db", 1);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_RECENTS)) {
        db.createObjectStore(STORE_RECENTS, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("recents.ts", () => {
  let fakeDB: IDBDatabase;

  beforeEach(async () => {
    vi.clearAllMocks();
    fakeDB = await createFakeDB();
    vi.mocked(getDB).mockResolvedValue(fakeDB);
  });

  afterEach(async () => {
    fakeDB.close();
    const deleteReq = indexedDB.deleteDatabase("test-db");
    await new Promise((resolve) => {
      deleteReq.onsuccess = resolve;
      deleteReq.onerror = resolve;
    });
    vi.restoreAllMocks();
  });

  describe("Internal Helpers (copied for testing)", () => {
    describe("isValidSerializedRecent", () => {
      it("should return true for valid serialized recent", () => {
        const valid = createMockSerializedRecent();
        expect(isValidSerializedRecent(valid)).toBe(true);
      });

      it("should return false for null", () => {
        expect(isValidSerializedRecent(null)).toBe(false);
      });

      it("should return false for non-object", () => {
        expect(isValidSerializedRecent("string")).toBe(false);
        expect(isValidSerializedRecent(123)).toBe(false);
      });

      it("should return false when id is not string", () => {
        const invalid = createMockSerializedRecent({ id: 123 });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return false when name is not string", () => {
        const invalid = createMockSerializedRecent({ name: 123 });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return false when size is not number", () => {
        const invalid = createMockSerializedRecent({ size: "1024" });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return false when size is negative", () => {
        const invalid = createMockSerializedRecent({ size: -1 });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return false when size is not integer", () => {
        const invalid = createMockSerializedRecent({ size: 1024.5 });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return false when format is not string", () => {
        const invalid = createMockSerializedRecent({ format: 123 });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return false when lastOpened is not string", () => {
        const invalid = createMockSerializedRecent({ lastOpened: 123 });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return false when lastOpened is invalid date string", () => {
        const invalid = createMockSerializedRecent({ lastOpened: "invalid-date" });
        expect(isValidSerializedRecent(invalid)).toBe(false);
      });

      it("should return true when optional fields are missing", () => {
        const minimal = {
          id: "test",
          name: "test",
          size: 100,
          format: "BIN",
          lastOpened: "2024-01-15T10:00:00.000Z",
        };
        expect(isValidSerializedRecent(minimal)).toBe(true);
      });
    });

    describe("serializeRecent", () => {
      it("should convert RecentFileEntry to SerializedRecent", () => {
        const entry = createMockRecent();
        const serialized = serializeRecent(entry);

        expect(serialized).toEqual({
          id: entry.id,
          name: entry.name,
          size: 1024,
          format: "BIN",
          lastOpened: entry.lastOpened,
          pinned: entry.pinned,
          tags: entry.tags,
        });
      });

      it("should create copy of tags array", () => {
        const entry = createMockRecent({ tags: ["tag1", "tag2"] });
        const serialized = serializeRecent(entry);

        expect(serialized.tags).toEqual(["tag1", "tag2"]);
        expect(serialized.tags).not.toBe(entry.tags);
      });
    });

    describe("deserializeRecent", () => {
      it("should convert SerializedRecent to RecentFileEntry", () => {
        const serialized = createMockSerializedRecent();
        const entry = deserializeRecent(serialized);

        expect(entry.id).toBe(serialized.id);
        expect(entry.name).toBe(serialized.name);
        expect(entry.size).toBe(createByteCount(1024));
        expect(entry.format).toBe("BIN");
        expect(entry.lastOpened).toBe(serialized.lastOpened);
        expect(entry.pinned).toBe(serialized.pinned);
        expect(entry.tags).toEqual(serialized.tags);
      });

      it("should default pinned to false when undefined", () => {
        const serialized = createMockSerializedRecent({ pinned: undefined });
        const entry = deserializeRecent(serialized);
        expect(entry.pinned).toBe(false);
      });

      it("should filter non-string tags", () => {
        const serialized = createMockSerializedRecent({
          tags: ["valid", 123, "another", null, undefined, {}],
        });
        const entry = deserializeRecent(serialized);
        expect(entry.tags).toEqual(["valid", "another"]);
      });

      it("should default to empty array when tags is not array", () => {
        const serialized = createMockSerializedRecent({ tags: "not-array" });
        const entry = deserializeRecent(serialized);
        expect(entry.tags).toEqual([]);
      });
    });
  });

  describe("loadRecents", () => {
    it("should return empty array when no recents exist", async () => {
      const result = await loadRecents();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("should load and deserialize valid recents", async () => {
      const tx = fakeDB.transaction(STORE_RECENTS, "readwrite");
      const store = tx.objectStore(STORE_RECENTS);
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          const req1 = store.put(createMockSerializedRecent({ id: "1", lastOpened: "2024-01-15T10:00:00Z" }));
          req1.onsuccess = () => resolve();
          req1.onerror = () => reject(req1.error);
        }),
        new Promise<void>((resolve, reject) => {
          const req2 = store.put(createMockSerializedRecent({ id: "2", lastOpened: "2024-01-14T10:00:00Z" }));
          req2.onsuccess = () => resolve();
          req2.onerror = () => reject(req2.error);
        }),
      ]);

      const result = await loadRecents();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].id).toBe("1");
        expect(result.value[1].id).toBe("2");
      }
    });

    it("should sort by lastOpened descending", async () => {
      const tx = fakeDB.transaction(STORE_RECENTS, "readwrite");
      const store = tx.objectStore(STORE_RECENTS);
      await Promise.all([
        new Promise<void>((resolve) => {
          const req = store.put(createMockSerializedRecent({ id: "old", lastOpened: "2024-01-10T10:00:00Z" }));
          req.onsuccess = () => resolve();
        }),
        new Promise<void>((resolve) => {
          const req = store.put(createMockSerializedRecent({ id: "new", lastOpened: "2024-01-15T10:00:00Z" }));
          req.onsuccess = () => resolve();
        }),
        new Promise<void>((resolve) => {
          const req = store.put(createMockSerializedRecent({ id: "mid", lastOpened: "2024-01-12T10:00:00Z" }));
          req.onsuccess = () => resolve();
        }),
      ]);

      const result = await loadRecents();

      if (result.ok) {
        expect(result.value[0].id).toBe("new");
        expect(result.value[1].id).toBe("mid");
        expect(result.value[2].id).toBe("old");
      }
    });

    it("should filter out invalid entries and warn", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const tx = fakeDB.transaction(STORE_RECENTS, "readwrite");
      const store = tx.objectStore(STORE_RECENTS);

      // Insert valid entries
      await new Promise<void>((resolve) => {
        store.put(createMockSerializedRecent({ id: "valid" })).onsuccess = () => resolve();
      });
      await new Promise<void>((resolve) => {
        store.put(createMockSerializedRecent({ id: "valid2" })).onsuccess = () => resolve();
      });

      // Insert invalid entry with valid key but invalid data structure
      await new Promise<void>((resolve, reject) => {
        const req = store.put({
          id: "invalid",
          name: 123, // Invalid: should be string
          size: -1, // Invalid: negative
          format: "BIN",
          lastOpened: "2024-01-15T10:00:00Z",
        } as any);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      const result = await loadRecents();

      if (result.ok) {
        // Should filter out the invalid entry (name is number, size is negative)
        expect(result.value.length).toBeLessThan(3);
        expect(result.value.every((r) => typeof r.name === "string")).toBe(true);
        expect(result.value.every((r) => r.size >= 0)).toBe(true);
        expect(consoleSpy).toHaveBeenCalled();
      }

      consoleSpy.mockRestore();
    });

    it("should return error when getDB throws", async () => {
      vi.mocked(getDB).mockRejectedValue(new Error("DB connection failed"));

      const result = await loadRecents();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_AVAILABLE");
        expect(result.error.cause).toBeInstanceOf(Error);
      }
    });
  });

  describe("saveRecent", () => {
    const createFile = (overrides: Partial<RecentFileEntry> = {}): RecentFileEntry => createMockRecent({ id: "new-file", name: "new-file.bin", ...overrides });

    it("should save new recent to empty list", async () => {
      const file = createFile();

      const result = await saveRecent(file);

      expect(result.ok).toBe(true);

      const loaded = await loadRecents();
      if (loaded.ok) {
        expect(loaded.value).toHaveLength(1);
        expect(loaded.value[0].id).toBe("new-file");
      }
    });

    it("should add new recent to front of list", async () => {
      // First save existing with older timestamp
      const existing = createMockRecent({
        id: "existing",
        name: "existing.bin",
        lastOpened: "2024-01-01T10:00:00Z",
      });
      await saveRecent(existing);

      // Then save new with newer timestamp
      const newFile = createFile({
        id: "new",
        name: "new.bin",
        lastOpened: new Date().toISOString(),
      });
      await saveRecent(newFile);

      const result = await loadRecents();
      if (result.ok) {
        // New file should be first (most recent lastOpened)
        expect(result.value[0].id).toBe("new");
        expect(result.value[1].id).toBe("existing");
      }
    });

    it("should remove duplicate by id when saving", async () => {
      const existing = createMockRecent({ id: "same-id", name: "old-name.bin" });
      await saveRecent(existing);

      const updatedFile = createMockRecent({
        id: "same-id",
        name: "new-name.bin",
        lastOpened: new Date().toISOString(),
      });

      await saveRecent(updatedFile);

      const result = await loadRecents();
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].name).toBe("new-name.bin");
      }
    });

    it("should remove duplicate by name when allowDuplicateNames is false", async () => {
      const existing = createMockRecent({ id: "id-1", name: "same-name.bin" });
      await saveRecent(existing);

      const newFile = createMockRecent({ id: "id-2", name: "same-name.bin" });

      await saveRecent(newFile, { allowDuplicateNames: false });

      const result = await loadRecents();
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].id).toBe("id-2");
      }
    });

    it("should allow duplicate names when allowDuplicateNames is true", async () => {
      const existing = createMockRecent({ id: "id-1", name: "same-name.bin" });
      await saveRecent(existing);

      const newFile = createMockRecent({ id: "id-2", name: "same-name.bin" });

      await saveRecent(newFile, { allowDuplicateNames: true });

      const result = await loadRecents();
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });

    it("should respect maxRecents limit", async () => {
      // Save 25 files with sequential timestamps
      for (let i = 0; i < 25; i++) {
        await saveRecent(
          createMockRecent({
            id: `id-${i}`,
            name: `file-${i}.bin`,
            lastOpened: new Date(2024, 0, i + 1).toISOString(),
          }),
        );
      }

      // Save one more with limit 5
      await saveRecent(
        createMockRecent({
          id: "new",
          name: "new.bin",
          lastOpened: new Date(2024, 1, 1).toISOString(),
        }),
        { maxRecents: 5 },
      );

      const result = await loadRecents();
      if (result.ok) {
        expect(result.value).toHaveLength(5);
        // The new file should be first (most recent)
        expect(result.value[0].id).toBe("new");
      }
    });

    it("should default maxRecents to 20", async () => {
      // Save 25 files with DIFFERENT IDs (no duplicates)
      for (let i = 0; i < 25; i++) {
        await saveRecent(
          createMockRecent({
            id: `id-${i}`,
            name: `file-${i}.bin`,
            lastOpened: new Date(2024, 0, i + 1).toISOString(),
          }),
        );
      }

      const result = await loadRecents();
      if (result.ok) {
        expect(result.value).toHaveLength(20);
      }
    });

    it("should warn but continue if loadRecents fails", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      let callCount = 0;
      vi.mocked(getDB).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Load failed"));
        }
        return Promise.resolve(fakeDB);
      });

      const file = createFile();
      const result = await saveRecent(file);

      expect(result.ok).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith("Could not load existing recents, overwriting");

      consoleSpy.mockRestore();
    });

    it("should return error when getDB throws during save", async () => {
      let callCount = 0;
      vi.mocked(getDB).mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return Promise.resolve(fakeDB);
        }
        return Promise.reject(new Error("DB failed"));
      });

      const result = await saveRecent(createFile());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SERIALIZATION_ERROR");
      }
    });
  });

  describe("removeRecent", () => {
    it("should return false when file not found", async () => {
      const result = await removeRecent("non-existent");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it("should remove by name with by-name strategy (default)", async () => {
      await saveRecent(createMockRecent({ id: "1", name: "keep.bin" }));
      await saveRecent(createMockRecent({ id: "2", name: "remove.bin" }));

      const result = await removeRecent("remove.bin");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }

      const loaded = await loadRecents();
      if (loaded.ok) {
        expect(loaded.value).toHaveLength(1);
        expect(loaded.value[0].id).toBe("1");
      }
    });

    it("should remove by id with by-id strategy", async () => {
      // Save with DIFFERENT names to avoid duplicate name removal
      await saveRecent(createMockRecent({ id: "keep-id", name: "keep.bin" }));
      await saveRecent(createMockRecent({ id: "remove-id", name: "remove.bin" }));

      await removeRecent("remove-id", "by-id");

      const result = await loadRecents();
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].id).toBe("keep-id");
      }
    });

    it("should remove by name only with by-name-strict strategy", async () => {
      await saveRecent(createMockRecent({ id: "id-1", name: "target.bin" }));
      await saveRecent(createMockRecent({ id: "target-id", name: "other.bin" }));

      await removeRecent("target.bin", "by-name-strict");

      const result = await loadRecents();
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].id).toBe("target-id");
      }
    });

    it("should match by id or name with by-name strategy", async () => {
      await saveRecent(createMockRecent({ id: "match-id", name: "other.bin" }));
      await saveRecent(createMockRecent({ id: "other-id", name: "match-name.bin" }));

      let result = await removeRecent("match-id", "by-name");
      expect(result.ok && result.value).toBe(true);

      await saveRecent(createMockRecent({ id: "match-id", name: "other.bin" }));

      result = await removeRecent("match-name.bin", "by-name");
      expect(result.ok && result.value).toBe(true);
    });

    it("should call deleteFileBuffer for removed files", async () => {
      await saveRecent(createMockRecent({ id: "1", name: "delete-me.bin" }));

      await removeRecent("delete-me.bin");

      // deleteFileBuffer is called with the filename as first argument
      expect(deleteFileBuffer).toHaveBeenCalled();
      expect(vi.mocked(deleteFileBuffer).mock.calls[0][0]).toBe("delete-me.bin");
    });

    it("should return error if loadRecents fails", async () => {
      vi.mocked(getDB).mockRejectedValue(new Error("DB failed"));

      const result = await removeRecent("any-id");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_AVAILABLE");
      }
    });
  });

  describe("togglePinRecent", () => {
    it("should toggle pinned from false to true", async () => {
      await saveRecent(createMockRecent({ id: "test", pinned: false }));

      const result = await togglePinRecent("test");

      expect(result.ok && result.value).toBe(true);

      const loaded = await loadRecents();
      if (loaded.ok) {
        expect(loaded.value[0].pinned).toBe(true);
      }
    });

    it("should toggle pinned from true to false", async () => {
      await saveRecent(createMockRecent({ id: "test", pinned: true }));

      await togglePinRecent("test");

      const loaded = await loadRecents();
      if (loaded.ok) {
        expect(loaded.value[0].pinned).toBe(false);
      }
    });

    it("should return false when id not found", async () => {
      const result = await togglePinRecent("non-existent");

      expect(result.ok && result.value).toBe(false);
    });
  });

  describe("touchRecent", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return false when id not found", async () => {
      const result = await touchRecent("non-existent");

      expect(result.ok && result.value).toBe(false);
    });
  });

  describe("clearRecents", () => {
    it("should clear all recents and delete buffers by default", async () => {
      await saveRecent(createMockRecent({ id: "1", name: "file1.bin" }));
      await saveRecent(createMockRecent({ id: "2", name: "file2.bin" }));

      const result = await clearRecents();

      expect(result.ok).toBe(true);

      const loaded = await loadRecents();
      if (loaded.ok) {
        expect(loaded.value).toHaveLength(0);
      }

      expect(deleteFileBuffer).toHaveBeenCalledWith("file1.bin");
      expect(deleteFileBuffer).toHaveBeenCalledWith("file2.bin");
    });

    it("should clear without deleting buffers when clearBuffers is false", async () => {
      await saveRecent(createMockRecent({ id: "1", name: "file1.bin" }));

      await clearRecents({ clearBuffers: false });

      expect(deleteFileBuffer).not.toHaveBeenCalled();
    });

    it("should succeed even if loadRecents failed", async () => {
      let callCount = 0;
      vi.mocked(getDB).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Load failed"));
        }
        return Promise.resolve(fakeDB);
      });

      const result = await clearRecents();

      expect(result.ok).toBe(true);
    });

    it("should handle getDB error", async () => {
      vi.mocked(getDB).mockRejectedValue(new Error("DB failed"));

      const result = await clearRecents();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_AVAILABLE");
      }
    });
  });

  describe("Query Functions", () => {
    describe("findRecentById", () => {
      it("should return entry when found", async () => {
        await saveRecent(createMockRecent({ id: "target", name: "found.bin" }));
        await saveRecent(createMockRecent({ id: "other" }));

        const result = await findRecentById("target");

        expect(result).not.toBeNull();
        expect(result?.id).toBe("target");
        expect(result?.name).toBe("found.bin");
      });

      it("should return null when not found", async () => {
        await saveRecent(createMockRecent({ id: "other" }));

        const result = await findRecentById("target");

        expect(result).toBeNull();
      });

      it("should return null when load fails", async () => {
        vi.mocked(getDB).mockRejectedValue(new Error("DB failed"));

        const result = await findRecentById("target");

        expect(result).toBeNull();
      });
    });

    describe("findRecentByName", () => {
      it("should return entry when found", async () => {
        await saveRecent(createMockRecent({ id: "1", name: "target.bin" }));
        await saveRecent(createMockRecent({ id: "2", name: "other.bin" }));

        const result = await findRecentByName("target.bin");

        expect(result).not.toBeNull();
        expect(result?.name).toBe("target.bin");
      });

      it("should return null when not found", async () => {
        await saveRecent(createMockRecent({ name: "other.bin" }));

        const result = await findRecentByName("target.bin");

        expect(result).toBeNull();
      });

      it("should return null when load fails", async () => {
        vi.mocked(getDB).mockRejectedValue(new Error("DB failed"));

        const result = await findRecentByName("target.bin");

        expect(result).toBeNull();
      });
    });

    describe("getPinnedRecents", () => {
      it("should return only pinned entries", async () => {
        // Usar diferentes nombres para evitar duplicados
        await saveRecent(createMockRecent({ id: "1", name: "pinned1.bin", pinned: true }));
        await saveRecent(createMockRecent({ id: "2", name: "unpinned.bin", pinned: false }));
        await saveRecent(createMockRecent({ id: "3", name: "pinned2.bin", pinned: true }));

        const result = await getPinnedRecents();

        expect(result).toHaveLength(2);
        expect(result.every((r) => r.pinned)).toBe(true);
      });

      it("should return empty array when none pinned", async () => {
        await saveRecent(createMockRecent({ pinned: false }));
        await saveRecent(createMockRecent({ pinned: false }));

        const result = await getPinnedRecents();

        expect(result).toEqual([]);
      });

      it("should return empty array when load fails", async () => {
        vi.mocked(getDB).mockRejectedValue(new Error("DB failed"));

        const result = await getPinnedRecents();

        expect(result).toEqual([]);
      });
    });
  });

  describe("Edge Cases & Integration", () => {
    it("should handle special characters in filenames", async () => {
      const specialNames = ["file with spaces.bin", "file-with-dashes.bin", "file_with_underscores.bin", "file.multiple.dots.bin", "unicode-文件.bin"];

      for (const name of specialNames) {
        await saveRecent(createMockRecent({ id: name, name }));
        const result = await findRecentByName(name);
        expect(result?.name).toBe(name);
        await clearRecents({ clearBuffers: false });
      }
    });

    it("should handle maximum safe integer size", async () => {
      const entry = createMockSerializedRecent({ size: Number.MAX_SAFE_INTEGER });
      expect(isValidSerializedRecent(entry)).toBe(true);
    });

    it("should reject negative size", async () => {
      const entry = createMockSerializedRecent({ size: -1 });
      expect(isValidSerializedRecent(entry)).toBe(false);
    });

    it("should handle future dates", async () => {
      const futureDate = new Date("2099-12-31T23:59:59Z").toISOString();
      const entry = createMockSerializedRecent({ lastOpened: futureDate });
      expect(isValidSerializedRecent(entry)).toBe(true);
    });

    it("should handle epoch date", async () => {
      const epoch = new Date(0).toISOString();
      const entry = createMockSerializedRecent({ lastOpened: epoch });
      expect(isValidSerializedRecent(entry)).toBe(true);
    });
  });
});
