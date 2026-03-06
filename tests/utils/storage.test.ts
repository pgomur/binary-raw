/**
 * @file Comprehensive Vitest tests for the IndexedDB file persistence module.
 *
 * Dependencies (dev):
 *   npm i -D fake-indexeddb happy-dom
 *
 * @vitest-environment happy-dom
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { STORE_RECENTS, StorageError, getDB, saveFileBuffer, loadFileBuffer, deleteFileBuffer, listFileBuffers, clearAllBuffers, closeConnection, type FileMetadata } from "../../src/utils/storage";

// Helpers

/** ArrayBuffer filled with a single repeated byte. */
const makeBuf = (size: number, fill = 0xab): ArrayBuffer => {
  const b = new ArrayBuffer(size);
  new Uint8Array(b).fill(fill);
  return b;
};

/** Read every record from an object store. */
const dumpStore = (db: IDBDatabase, store: string): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error);
  });

/** Get a single record by key from an object store. */
const getFromStore = (db: IDBDatabase, store: string, key: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * Replace a buffer in "file-buffers" with different bytes to simulate corruption.
 * Resolves on tx.oncomplete (not req.onsuccess) to guarantee the write is durable.
 */
const corruptBuffer = (db: IDBDatabase, key: string, replacement: ArrayBuffer): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction("file-buffers", "readwrite");
    tx.objectStore("file-buffers").put(replacement, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

/**
 * Insert records directly into both stores with explicit timestamps,
 * bypassing saveFileBuffer to avoid any dependency on system time.
 */
const insertWithTimestamps = (db: IDBDatabase, entries: ReadonlyArray<{ name: string; size: number; savedAt: number }>): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(["file-buffers", "file-metadata"], "readwrite");
    for (const e of entries) {
      tx.objectStore("file-buffers").put(new ArrayBuffer(e.size), e.name);
      tx.objectStore("file-metadata").put(e);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

// Lifecycle

/**
 * Delete the physical database and reset the module-level singleton before
 * each test. Using deleteDatabase ensures object stores and indices are
 * recreated fresh, preventing any cross-test contamination.
 */
const resetDB = (): Promise<void> =>
  new Promise((resolve) => {
    closeConnection();
    const req = indexedDB.deleteDatabase("binary-raw-db");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve(); // best-effort
    req.onblocked = () => resolve();
  });

beforeEach(async () => {
  await resetDB();
});
afterEach(() => {
  closeConnection();
  vi.restoreAllMocks();
});

// STORE_RECENTS

describe("STORE_RECENTS", () => {
  it("is a string", () => expect(typeof STORE_RECENTS).toBe("string"));
  it("is non-empty", () => expect(STORE_RECENTS.length).toBeGreaterThan(0));
  it("equals 'file-recents'", () => expect(STORE_RECENTS).toBe("file-recents"));
});

// StorageError

describe("StorageError", () => {
  it("extends Error", () => {
    expect(new StorageError("m", "UNKNOWN")).toBeInstanceOf(Error);
  });

  it("is instanceof StorageError", () => {
    expect(new StorageError("m", "UNKNOWN")).toBeInstanceOf(StorageError);
  });

  it("name is 'StorageError'", () => {
    expect(new StorageError("m", "UNKNOWN").name).toBe("StorageError");
  });

  it("message is preserved", () => {
    expect(new StorageError("hello", "UNKNOWN").message).toBe("hello");
  });

  it.each(["QUOTA_EXCEEDED", "VERSION_ERROR", "BLOCKED", "NOT_AVAILABLE", "SERIALIZATION_ERROR", "UNKNOWN"] as const)("code '%s' is preserved", (code) => {
    expect(new StorageError("m", code).code).toBe(code);
  });

  it("cause is undefined when omitted", () => {
    expect(new StorageError("m", "UNKNOWN").cause).toBeUndefined();
  });

  it("cause is preserved when provided as an Error", () => {
    const inner = new Error("inner");
    expect(new StorageError("m", "UNKNOWN", inner).cause).toBe(inner);
  });

  it("cause accepts any value (not just Error)", () => {
    const obj = { x: 1 };
    expect(new StorageError("m", "UNKNOWN", obj).cause).toBe(obj);
  });

  it("code is usable in a switch/case", () => {
    const err = new StorageError("q", "QUOTA_EXCEEDED");
    let handled = "";
    switch (err.code) {
      case "QUOTA_EXCEEDED":
        handled = "quota";
        break;
      default:
        handled = "other";
    }
    expect(handled).toBe("quota");
  });
});

// closeConnection

describe("closeConnection", () => {
  it("does not throw before any connection is opened", () => {
    expect(() => closeConnection()).not.toThrow();
  });

  it("does not throw when called twice in a row", () => {
    expect(() => {
      closeConnection();
      closeConnection();
    }).not.toThrow();
  });

  it("does not throw when called after getDB()", async () => {
    await getDB();
    expect(() => closeConnection()).not.toThrow();
  });

  it("after close, next getDB() returns a new IDBDatabase (different reference)", async () => {
    const db1 = await getDB();
    closeConnection();
    const db2 = await getDB();
    expect(db2).not.toBe(db1);
  });

  it("after close, getDB() still returns a working database with all stores", async () => {
    await getDB();
    closeConnection();
    const db = await getDB();
    expect(db.objectStoreNames.contains("file-buffers")).toBe(true);
  });
});

// getDB

describe("getDB", () => {
  it("resolves to an IDBDatabase with expected methods", async () => {
    const db = await getDB();
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.close).toBe("function");
  });

  it("singleton: two sequential calls return the same reference", async () => {
    expect(await getDB()).toBe(await getDB());
  });

  it("singleton: three concurrent calls return the same reference", async () => {
    const [a, b, c] = await Promise.all([getDB(), getDB(), getDB()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("contains 'file-buffers' object store", async () => {
    expect((await getDB()).objectStoreNames.contains("file-buffers")).toBe(true);
  });

  it("contains 'file-metadata' object store", async () => {
    expect((await getDB()).objectStoreNames.contains("file-metadata")).toBe(true);
  });

  it("contains 'file-recents' object store", async () => {
    expect((await getDB()).objectStoreNames.contains("file-recents")).toBe(true);
  });

  it("'file-metadata' has a 'savedAt' index", async () => {
    const db = await getDB();
    const tx = db.transaction("file-metadata", "readonly");
    const store = tx.objectStore("file-metadata");
    expect(store.indexNames.contains("savedAt")).toBe(true);
  });

  it("'file-metadata' has a 'size' index", async () => {
    const db = await getDB();
    const tx = db.transaction("file-metadata", "readonly");
    const store = tx.objectStore("file-metadata");
    expect(store.indexNames.contains("size")).toBe(true);
  });
});

// saveFileBuffer

describe("saveFileBuffer", () => {
  // Validation

  it("rejects with StorageError for empty-string key", async () => {
    await expect(saveFileBuffer("", makeBuf(4))).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects with StorageError for key of 501 characters", async () => {
    await expect(saveFileBuffer("a".repeat(501), makeBuf(4))).rejects.toBeInstanceOf(StorageError);
  });

  it("accepts a key of exactly 500 characters", async () => {
    await expect(saveFileBuffer("a".repeat(500), makeBuf(4))).resolves.toBeUndefined();
  });

  // Return value

  it("resolves to undefined on success", async () => {
    await expect(saveFileBuffer("f.bin", makeBuf(8))).resolves.toBeUndefined();
  });

  // Persistence

  it("saved buffer can be loaded back byte-for-byte", async () => {
    const src = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    await saveFileBuffer("cafe.bin", src.buffer);
    const r = await loadFileBuffer("cafe.bin");
    expect(new Uint8Array(r!.buffer)).toEqual(src);
  });

  it("metadata.name matches the key", async () => {
    await saveFileBuffer("name-check.bin", makeBuf(4));
    expect((await loadFileBuffer("name-check.bin"))!.metadata.name).toBe("name-check.bin");
  });

  it("metadata.size matches buffer.byteLength", async () => {
    await saveFileBuffer("sz.bin", makeBuf(64));
    expect((await loadFileBuffer("sz.bin"))!.metadata.size).toBe(64);
  });

  it("metadata.hash is an 8-character lowercase hex string", async () => {
    await saveFileBuffer("hash.bin", makeBuf(16));
    expect((await loadFileBuffer("hash.bin"))!.metadata.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("metadata.savedAt falls within the test execution window", async () => {
    const before = Date.now();
    await saveFileBuffer("ts.bin", makeBuf(4));
    const after = Date.now();
    const { savedAt } = (await loadFileBuffer("ts.bin"))!.metadata;
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(after);
  });

  // Overwrite

  it("overwriting an existing key replaces buffer content and size", async () => {
    await saveFileBuffer("over.bin", makeBuf(4, 0x01));
    await saveFileBuffer("over.bin", makeBuf(8, 0x02));
    const r = await loadFileBuffer("over.bin");
    expect(r!.metadata.size).toBe(8);
    expect(new Uint8Array(r!.buffer)[0]).toBe(0x02);
  });

  // Edge cases

  it("saves an empty ArrayBuffer (0 bytes) without throwing", async () => {
    await expect(saveFileBuffer("empty.bin", new ArrayBuffer(0))).resolves.toBeUndefined();
  });

  it("multiple distinct files are stored independently", async () => {
    await saveFileBuffer("a.bin", makeBuf(4, 0xaa));
    await saveFileBuffer("b.bin", makeBuf(4, 0xbb));
    expect(new Uint8Array((await loadFileBuffer("a.bin"))!.buffer)[0]).toBe(0xaa);
    expect(new Uint8Array((await loadFileBuffer("b.bin"))!.buffer)[0]).toBe(0xbb);
  });

  // AbortSignal

  it("throws DOMException 'AbortError' when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await saveFileBuffer("ab.bin", makeBuf(4), { signal: ctrl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("resolves normally when signal exists but is not aborted", async () => {
    const ctrl = new AbortController();
    await expect(saveFileBuffer("ok.bin", makeBuf(4), { signal: ctrl.signal })).resolves.toBeUndefined();
  });
});

// loadFileBuffer

describe("loadFileBuffer", () => {
  // Validation

  it("rejects with StorageError for empty-string key", async () => {
    await expect(loadFileBuffer("")).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects with StorageError for key of 501 characters", async () => {
    await expect(loadFileBuffer("z".repeat(501))).rejects.toBeInstanceOf(StorageError);
  });

  // Not found

  it("returns null for a key that was never saved", async () => {
    await expect(loadFileBuffer("ghost.bin")).resolves.toBeNull();
  });

  it("returns null after the file has been deleted", async () => {
    await saveFileBuffer("del.bin", makeBuf(4));
    await deleteFileBuffer("del.bin");
    await expect(loadFileBuffer("del.bin")).resolves.toBeNull();
  });

  // Result shape

  it("result.buffer is an ArrayBuffer", async () => {
    await saveFileBuffer("shape.bin", makeBuf(8));
    expect((await loadFileBuffer("shape.bin"))!.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("result.metadata has name, size, and savedAt fields of correct types", async () => {
    await saveFileBuffer("meta.bin", makeBuf(8));
    const { metadata } = (await loadFileBuffer("meta.bin"))!;
    expect(typeof metadata.name).toBe("string");
    expect(typeof metadata.size).toBe("number");
    expect(typeof metadata.savedAt).toBe("number");
  });

  it("result.buffer.byteLength matches the saved size", async () => {
    await saveFileBuffer("len.bin", makeBuf(64));
    expect((await loadFileBuffer("len.bin"))!.buffer.byteLength).toBe(64);
  });

  it("loaded bytes match saved bytes exactly", async () => {
    const src = new Uint8Array([0x01, 0x02, 0xfe, 0xff]);
    await saveFileBuffer("exact.bin", src.buffer);
    expect(new Uint8Array((await loadFileBuffer("exact.bin"))!.buffer)).toEqual(src);
  });

  // verifyHash

  it("verifyHash: true resolves for a freshly saved, uncorrupted file", async () => {
    await saveFileBuffer("ok-hash.bin", makeBuf(32));
    await expect(loadFileBuffer("ok-hash.bin", { verifyHash: true })).resolves.not.toBeNull();
  });

  it("verifyHash: false does not check hash even when buffer is corrupted", async () => {
    await saveFileBuffer("skip-hash.bin", makeBuf(16, 0xff));
    await corruptBuffer(await getDB(), "skip-hash.bin", makeBuf(16, 0x00));
    await expect(loadFileBuffer("skip-hash.bin", { verifyHash: false })).resolves.not.toBeNull();
  });

  it("verifyHash: true rejects with StorageError (message includes 'integrity') when corrupted", async () => {
    await saveFileBuffer("bad-hash.bin", makeBuf(16, 0xff));
    await corruptBuffer(await getDB(), "bad-hash.bin", makeBuf(16, 0x00));
    const err = await loadFileBuffer("bad-hash.bin", { verifyHash: true }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).message).toMatch(/integrity/i);
  });

  it("verifyHash: true with no hash field in metadata silently skips the check", async () => {
    await saveFileBuffer("no-hash.bin", makeBuf(8));
    const db = await getDB();
    // Overwrite metadata record without a hash field
    await new Promise<void>((resolve, reject) => {
      const meta: FileMetadata = { name: "no-hash.bin", size: 8, savedAt: Date.now() };
      const tx = db.transaction("file-metadata", "readwrite");
      tx.objectStore("file-metadata").put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await expect(loadFileBuffer("no-hash.bin", { verifyHash: true })).resolves.not.toBeNull();
  });

  // AbortSignal

  it("throws DOMException 'AbortError' when signal is already aborted", async () => {
    await saveFileBuffer("ab.bin", makeBuf(4));
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await loadFileBuffer("ab.bin", { signal: ctrl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("resolves normally when signal exists but is not aborted", async () => {
    await saveFileBuffer("sig.bin", makeBuf(4));
    const ctrl = new AbortController();
    await expect(loadFileBuffer("sig.bin", { signal: ctrl.signal })).resolves.not.toBeNull();
  });
});

// deleteFileBuffer

describe("deleteFileBuffer", () => {
  // Validation

  it("rejects with StorageError for empty-string key", async () => {
    await expect(deleteFileBuffer("")).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects with StorageError for key of 501 characters", async () => {
    await expect(deleteFileBuffer("x".repeat(501))).rejects.toBeInstanceOf(StorageError);
  });

  // Not found

  it("returns false for a key never saved", async () => {
    await expect(deleteFileBuffer("ghost.bin")).resolves.toBe(false);
  });

  it("returns false when called a second time on an already-deleted key", async () => {
    await saveFileBuffer("twice.bin", makeBuf(4));
    await deleteFileBuffer("twice.bin");
    await expect(deleteFileBuffer("twice.bin")).resolves.toBe(false);
  });

  // Successful deletion

  it("returns true when the file existed", async () => {
    await saveFileBuffer("exists.bin", makeBuf(8));
    await expect(deleteFileBuffer("exists.bin")).resolves.toBe(true);
  });

  it("loadFileBuffer returns null after deletion", async () => {
    await saveFileBuffer("gone.bin", makeBuf(4));
    await deleteFileBuffer("gone.bin");
    await expect(loadFileBuffer("gone.bin")).resolves.toBeNull();
  });

  it("file-buffers store no longer contains the entry", async () => {
    await saveFileBuffer("buf-del.bin", makeBuf(4));
    await deleteFileBuffer("buf-del.bin");
    expect(await getFromStore(await getDB(), "file-buffers", "buf-del.bin")).toBeUndefined();
  });

  it("file-metadata store no longer contains the entry", async () => {
    await saveFileBuffer("meta-del.bin", makeBuf(4));
    await deleteFileBuffer("meta-del.bin");
    expect(await getFromStore(await getDB(), "file-metadata", "meta-del.bin")).toBeUndefined();
  });

  it("deleting one file does not affect another", async () => {
    await saveFileBuffer("keep.bin", makeBuf(4, 0x01));
    await saveFileBuffer("delete.bin", makeBuf(4, 0x02));
    await deleteFileBuffer("delete.bin");
    const r = await loadFileBuffer("keep.bin");
    expect(r).not.toBeNull();
    expect(new Uint8Array(r!.buffer)[0]).toBe(0x01);
  });
});

// listFileBuffers

describe("listFileBuffers", () => {
  it("returns an empty array when no files are stored", async () => {
    await expect(listFileBuffers()).resolves.toEqual([]);
  });

  it("returns one entry per saved file", async () => {
    await saveFileBuffer("a.bin", makeBuf(4));
    await saveFileBuffer("b.bin", makeBuf(8));
    expect(await listFileBuffers()).toHaveLength(2);
  });

  it("each entry has name, size, and savedAt of the correct types", async () => {
    await saveFileBuffer("info.bin", makeBuf(16));
    const [entry] = await listFileBuffers();
    expect(typeof entry!.name).toBe("string");
    expect(typeof entry!.size).toBe("number");
    expect(typeof entry!.savedAt).toBe("number");
  });

  it("entries do NOT include a hash field", async () => {
    await saveFileBuffer("no-hash.bin", makeBuf(8));
    const [entry] = await listFileBuffers();
    expect(entry).not.toHaveProperty("hash");
  });

  it("size in listing matches the buffer byteLength", async () => {
    await saveFileBuffer("sized.bin", makeBuf(128));
    const list = await listFileBuffers();
    expect(list.find((f) => f.name === "sized.bin")!.size).toBe(128);
  });

  it("files are sorted from most-recent to oldest by savedAt", async () => {
    const db = await getDB();
    await insertWithTimestamps(db, [
      { name: "old.bin", size: 4, savedAt: 1_000 },
      { name: "middle.bin", size: 4, savedAt: 2_000 },
      { name: "new.bin", size: 4, savedAt: 3_000 },
    ]);
    const list = await listFileBuffers();
    expect(list[0]!.name).toBe("new.bin");
    expect(list[1]!.name).toBe("middle.bin");
    expect(list[2]!.name).toBe("old.bin");
  });

  it("savedAt values in the result are strictly decreasing", async () => {
    const db = await getDB();
    await insertWithTimestamps(db, [
      { name: "t1.bin", size: 4, savedAt: 100 },
      { name: "t2.bin", size: 4, savedAt: 200 },
      { name: "t3.bin", size: 4, savedAt: 300 },
    ]);
    const list = await listFileBuffers();
    for (let i = 0; i < list.length - 1; i++) {
      expect(list[i]!.savedAt).toBeGreaterThan(list[i + 1]!.savedAt);
    }
  });

  it("deleted files do not appear in the listing", async () => {
    await saveFileBuffer("stay.bin", makeBuf(4));
    await saveFileBuffer("remove.bin", makeBuf(4));
    await deleteFileBuffer("remove.bin");
    const list = await listFileBuffers();
    expect(list.some((f) => f.name === "remove.bin")).toBe(false);
    expect(list.some((f) => f.name === "stay.bin")).toBe(true);
  });

  it("returns empty array after clearAllBuffers", async () => {
    await saveFileBuffer("x.bin", makeBuf(4));
    await clearAllBuffers();
    await expect(listFileBuffers()).resolves.toEqual([]);
  });
});

// clearAllBuffers

describe("clearAllBuffers", () => {
  it("resolves to undefined", async () => {
    await expect(clearAllBuffers()).resolves.toBeUndefined();
  });

  it("does not throw when stores are already empty", async () => {
    await expect(clearAllBuffers()).resolves.toBeUndefined();
  });

  it("empties the file-buffers store", async () => {
    await saveFileBuffer("a.bin", makeBuf(4));
    await saveFileBuffer("b.bin", makeBuf(4));
    await clearAllBuffers();
    expect(await dumpStore(await getDB(), "file-buffers")).toHaveLength(0);
  });

  it("empties the file-metadata store", async () => {
    await saveFileBuffer("c.bin", makeBuf(4));
    await saveFileBuffer("d.bin", makeBuf(4));
    await clearAllBuffers();
    expect(await dumpStore(await getDB(), "file-metadata")).toHaveLength(0);
  });

  it("loadFileBuffer returns null for every previously saved file", async () => {
    await saveFileBuffer("p.bin", makeBuf(4));
    await saveFileBuffer("q.bin", makeBuf(4));
    await clearAllBuffers();
    await expect(loadFileBuffer("p.bin")).resolves.toBeNull();
    await expect(loadFileBuffer("q.bin")).resolves.toBeNull();
  });

  it("listFileBuffers returns empty array after clear", async () => {
    await saveFileBuffer("lst.bin", makeBuf(4));
    await clearAllBuffers();
    await expect(listFileBuffers()).resolves.toEqual([]);
  });

  it("new files can be saved and loaded correctly after a clear", async () => {
    await saveFileBuffer("before.bin", makeBuf(4, 0x11));
    await clearAllBuffers();
    await saveFileBuffer("after.bin", makeBuf(8, 0xcc));
    const r = await loadFileBuffer("after.bin");
    expect(r).not.toBeNull();
    expect(r!.metadata.size).toBe(8);
    expect(new Uint8Array(r!.buffer)[0]).toBe(0xcc);
  });

  it("does NOT touch the file-recents store", async () => {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_RECENTS, "readwrite");
      tx.objectStore(STORE_RECENTS).put({ id: "recent-1", path: "/test" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await clearAllBuffers();
    expect(await dumpStore(db, STORE_RECENTS)).toHaveLength(1);
  });
});

// calculateHash  (tested indirectly via saveFileBuffer + verifyHash)

describe("calculateHash (indirectly via saveFileBuffer + verifyHash)", () => {
  it("same bytes → same hash across two independent saves", async () => {
    await saveFileBuffer("h1.bin", makeBuf(32, 0xab));
    const hash1 = (await loadFileBuffer("h1.bin"))!.metadata.hash;

    await resetDB(); // clean slate, separate logical "session"

    await saveFileBuffer("h1.bin", makeBuf(32, 0xab));
    const hash2 = (await loadFileBuffer("h1.bin"))!.metadata.hash;

    expect(hash1).toBe(hash2);
  });

  it("different bytes → different hashes", async () => {
    await saveFileBuffer("hA.bin", makeBuf(32, 0x01));
    await saveFileBuffer("hB.bin", makeBuf(32, 0x02));
    const hA = (await loadFileBuffer("hA.bin"))!.metadata.hash;
    const hB = (await loadFileBuffer("hB.bin"))!.metadata.hash;
    expect(hA).not.toBe(hB);
  });

  it("empty buffer produces a valid 8-char hex hash", async () => {
    await saveFileBuffer("empty.bin", new ArrayBuffer(0));
    expect((await loadFileBuffer("empty.bin"))!.metadata.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it.each([1, 16, 255, 1024])("hash is always 8 lowercase hex chars for size %i", async (size) => {
    await saveFileBuffer(`sz-${size}.bin`, makeBuf(size));
    expect((await loadFileBuffer(`sz-${size}.bin`))!.metadata.hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

// Integration

describe("Integration", () => {
  it("full round-trip: save → list → load → delete → list", async () => {
    await saveFileBuffer("first.bin", makeBuf(10, 0x01));
    await saveFileBuffer("second.bin", makeBuf(20, 0x02));

    const afterSave = await listFileBuffers();
    expect(afterSave.map((f) => f.name)).toContain("first.bin");
    expect(afterSave.map((f) => f.name)).toContain("second.bin");

    expect(new Uint8Array((await loadFileBuffer("first.bin"))!.buffer)[0]).toBe(0x01);

    expect(await deleteFileBuffer("first.bin")).toBe(true);

    const afterDelete = await listFileBuffers();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]!.name).toBe("second.bin");
  });

  it("verifyHash passes after closeConnection + reopen (simulates page reload)", async () => {
    await saveFileBuffer("persist.bin", makeBuf(64, 0xaa));
    closeConnection();
    const r = await loadFileBuffer("persist.bin", { verifyHash: true });
    expect(r).not.toBeNull();
    expect(new Uint8Array(r!.buffer)[0]).toBe(0xaa);
  });

  it("save → clear → save again produces only the new content", async () => {
    await saveFileBuffer("cycle.bin", makeBuf(4, 0x11));
    await clearAllBuffers();
    await saveFileBuffer("cycle.bin", makeBuf(4, 0x22));
    expect(new Uint8Array((await loadFileBuffer("cycle.bin"))!.buffer)[0]).toBe(0x22);
  });

  it("file count transitions 0 → 3 → 0 correctly", async () => {
    expect(await listFileBuffers()).toHaveLength(0);
    await saveFileBuffer("one.bin", makeBuf(4));
    await saveFileBuffer("two.bin", makeBuf(4));
    await saveFileBuffer("three.bin", makeBuf(4));
    expect(await listFileBuffers()).toHaveLength(3);
    await clearAllBuffers();
    expect(await listFileBuffers()).toHaveLength(0);
  });

  it("5 parallel saves all persist with correct content", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => saveFileBuffer(`p-${i}.bin`, makeBuf(8, i))));
    expect(await listFileBuffers()).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      const r = await loadFileBuffer(`p-${i}.bin`);
      expect(new Uint8Array(r!.buffer)[0]).toBe(i);
    }
  });

  it("overwrite followed by verifyHash is consistent", async () => {
    await saveFileBuffer("ov.bin", makeBuf(4, 0xaa));
    await saveFileBuffer("ov.bin", makeBuf(4, 0xbb));
    const r = await loadFileBuffer("ov.bin", { verifyHash: true });
    expect(r).not.toBeNull();
    expect(new Uint8Array(r!.buffer)[0]).toBe(0xbb);
  });
});

// Coverage — singleton lifecycle and error paths
//
// Each describe block maps to a specific set of uncovered lines reported by
// the coverage tool.  Line numbers reference storage.ts directly.

// Helper: inject a one-shot transaction that fires onerror
//
// Spies on the INSTANCE-level `transaction` method (not the prototype) so that
// only the very next call to `db.transaction()` is intercepted; all subsequent
// calls — including those made by fake-indexeddb itself — use the real
// implementation.  The fake transaction fires `onerror` via queueMicrotask so
// that every handler the production code registers in the same synchronous
// block is already in place when the error fires.
//
function spyTransactionError(db: IDBDatabase, errorName = "UnknownError"): void {
  const domErr = new DOMException(errorName, errorName);

  // A minimal fake that satisfies every objectStore call shape used by storage.ts
  const fakeStore = {
    put: () => ({ onsuccess: null, onerror: null }),
    get: () => ({ onsuccess: null, onerror: null }),
    delete: () => ({ onsuccess: null, onerror: null }),
    count: () => ({ onsuccess: null, onerror: null }),
    clear: () => ({}),
    index: () => ({ openCursor: () => ({ onsuccess: null, onerror: null }) }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    objectStore: () => fakeStore,
    abort: () => {
      /* no-op */
    },
    oncomplete: null,
    onerror: null as (() => void) | null,
    error: domErr,
  };

  vi.spyOn(db, "transaction").mockImplementationOnce(() => {
    queueMicrotask(() => {
      if (typeof tx.onerror === "function") tx.onerror();
    });
    return tx as unknown as IDBTransaction;
  });
}

// Lines 91-93: cleanup closure inside getDB().then()
//
// getDB() registers `window.addEventListener("beforeunload", cleanup, { once: true })`.
// Dispatching the event fires: db.close(); dbInstance = null; dbPromise = null;

describe("Coverage — lines 91-93: beforeunload cleanup closure", () => {
  it("dispatching 'beforeunload' fires the cleanup closure (closes db, resets singletons)", async () => {
    const db1 = await getDB();
    expect(db1).toBeDefined();

    // Fire the registered one-time cleanup listener
    window.dispatchEvent(new Event("beforeunload"));

    // Singletons are now null; getDB() must open a fresh connection
    const db2 = await getDB();
    expect(db2).toBeDefined();
    expect(db2.objectStoreNames.contains("file-buffers")).toBe(true);
  });

  it("after beforeunload, the new connection can save and load normally", async () => {
    await getDB();
    window.dispatchEvent(new Event("beforeunload"));
    await saveFileBuffer("post-unload.bin", makeBuf(8, 0xcc));
    const r = await loadFileBuffer("post-unload.bin");
    expect(r).not.toBeNull();
    expect(new Uint8Array(r!.buffer)[0]).toBe(0xcc);
  });
});

// Lines 98-99: db 'close' event listener inside getDB().then()
//
// getDB() calls `db.addEventListener("close", () => { dbInstance = null; dbPromise = null; })`.
// fake-indexeddb does NOT dispatch a DOM "close" event when db.close() is called,
// so we intercept addEventListener to capture the handler and invoke it manually.
//
// IMPORTANT: save the original reference BEFORE vi.spyOn replaces it, so the
// delegate call inside the mock does not recurse into the spy.

describe("Coverage — lines 98-99: db 'close' event resets singletons", () => {
  it("invoking the captured 'close' handler resets dbInstance and dbPromise", async () => {
    let closeHandler: (() => void) | undefined;

    // Save BEFORE spying — spyOn replaces the prototype method
    const originalAddEventListener = IDBDatabase.prototype.addEventListener;

    vi.spyOn(IDBDatabase.prototype, "addEventListener").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function (this: IDBDatabase, type: string, handler: any, opts?: any) {
        if (type === "close") closeHandler = handler as () => void;
        // Call the saved original — not the current prototype property (which is the spy)
        return originalAddEventListener.call(this, type, handler, opts);
      },
    );

    await getDB();
    vi.restoreAllMocks();

    closeHandler?.();

    const db2 = await getDB();
    expect(db2).toBeDefined();
    expect(db2.objectStoreNames.contains("file-buffers")).toBe(true);
  });

  it("after the close handler resets singletons, all stores are available on the new connection", async () => {
    let closeHandler: (() => void) | undefined;

    const originalAddEventListener = IDBDatabase.prototype.addEventListener;

    vi.spyOn(IDBDatabase.prototype, "addEventListener").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function (this: IDBDatabase, type: string, handler: any, opts?: any) {
        if (type === "close") closeHandler = handler as () => void;
        return originalAddEventListener.call(this, type, handler, opts);
      },
    );

    await getDB();
    vi.restoreAllMocks();
    closeHandler?.();

    const db2 = await getDB();
    expect(db2.objectStoreNames.contains("file-buffers")).toBe(true);
    expect(db2.objectStoreNames.contains("file-metadata")).toBe(true);
    expect(db2.objectStoreNames.contains("file-recents")).toBe(true);
  });
});

// Lines 105-106: .catch branch in getDB() when openDB() rejects
//
// getDB() chains: openDB().then(...).catch((err) => { dbPromise = null; throw err; })
// Triggering request.onerror inside openDB() causes this branch to run.

describe("Coverage — lines 105-106: openDB rejection resets dbPromise", () => {
  it("rejects with StorageError when indexedDB.open fires onerror", async () => {
    closeConnection(); // ensure no existing singleton

    vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = {
        onblocked: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null as (() => void) | null,
        error: new DOMException("Simulated open failure"),
        result: null,
      };
      queueMicrotask(() => {
        if (typeof req.onerror === "function") req.onerror();
      });
      return req as IDBOpenDBRequest;
    });

    await expect(getDB()).rejects.toBeInstanceOf(StorageError);
  });

  it("after the rejection, dbPromise is reset so a subsequent getDB() succeeds", async () => {
    closeConnection();

    vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = {
        onblocked: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null as (() => void) | null,
        error: new DOMException("Simulated open failure"),
        result: null,
      };
      queueMicrotask(() => {
        if (typeof req.onerror === "function") req.onerror();
      });
      return req as IDBOpenDBRequest;
    });

    await getDB().catch(() => {
      /* expected */
    });
    vi.restoreAllMocks(); // restore before the real open

    // dbPromise must have been reset; real open should succeed
    const db = await getDB();
    expect(db).toBeDefined();
    expect(db.objectStoreNames.contains("file-buffers")).toBe(true);
  });

  it("StorageError from openDB has code UNKNOWN for a generic error", async () => {
    closeConnection();
    vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = {
        onblocked: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null as (() => void) | null,
        error: new DOMException("Generic failure"),
        result: null,
      };
      queueMicrotask(() => {
        if (typeof req.onerror === "function") req.onerror();
      });
      return req as IDBOpenDBRequest;
    });
    const err = await getDB().catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe("UNKNOWN");
  });

  it("StorageError from openDB has code VERSION_ERROR when error.name is 'VersionError'", async () => {
    closeConnection();
    vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      const versionErr = new DOMException("VersionError");
      Object.defineProperty(versionErr, "name", { value: "VersionError" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = {
        onblocked: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null as (() => void) | null,
        error: versionErr,
        result: null,
      };
      queueMicrotask(() => {
        if (typeof req.onerror === "function") req.onerror();
      });
      return req as IDBOpenDBRequest;
    });
    const err = await getDB().catch((e) => e);
    expect((err as StorageError).code).toBe("VERSION_ERROR");
  });
});

// Line 125: db.onversionchange handler inside openDB().request.onsuccess
//
// openDB sets `db.onversionchange = () => { db.close(); dbInstance = null; dbPromise = null; }`.
// fake-indexeddb throws InvalidStateError on db.dispatchEvent("versionchange") because
// the connection is in a closed state after the first call.
// The handler is assigned as a plain property, so we call it directly:
//   (db as any).onversionchange?.()

describe("Coverage — line 125: db.onversionchange resets singletons", () => {
  it("calling db.onversionchange() directly fires the handler and resets singletons", async () => {
    const db = await getDB();
    // Invoke the plain-property handler that storage.ts assigned in onsuccess
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).onversionchange?.();
    await new Promise((r) => setTimeout(r, 0));

    // Singletons are now null; a fresh getDB() must succeed
    const db2 = await getDB();
    expect(db2).toBeDefined();
    expect(db2.objectStoreNames.contains("file-buffers")).toBe(true);
  });

  it("after onversionchange resets, saveFileBuffer still works on the new connection", async () => {
    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).onversionchange?.();
    await new Promise((r) => setTimeout(r, 0));

    await saveFileBuffer("post-vc.bin", makeBuf(4, 0xab));
    const r = await loadFileBuffer("post-vc.bin");
    expect(r).not.toBeNull();
    expect(new Uint8Array(r!.buffer)[0]).toBe(0xab);
  });
});

// Lines 158-160: onAbort listener body inside saveFileBuffer
//
// The listener `onAbort` is registered synchronously inside the Promise
// constructor.  fake-indexeddb commits transactions in microtasks, so
// ctrl.abort() called after saveFileBuffer() always races and loses.
//
// Solution: spy on db.transaction to return a **hanging** fake transaction
// whose oncomplete never fires.  The Promise then stays pending until
// ctrl.abort() fires the onAbort listener, which calls:
//   transaction.abort();
//   reject(new DOMException("Aborted", "AbortError"));

describe("Coverage — lines 158-160: in-flight abort in saveFileBuffer", () => {
  it("rejects with DOMException AbortError when signal aborts after transaction begins", async () => {
    const db = await getDB();

    // Hanging transaction: oncomplete never fires automatically
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hangingTx: any = {
      objectStore: () => ({
        put: () => ({ onsuccess: null, onerror: null }),
      }),
      abort: () => {
        /* no-op — abort is called by onAbort before reject */
      },
      oncomplete: null,
      onerror: null,
      error: null,
    };

    vi.spyOn(db, "transaction").mockImplementationOnce(() => hangingTx as unknown as IDBTransaction);

    const ctrl = new AbortController();
    const p = saveFileBuffer("inflight-save.bin", makeBuf(4), { signal: ctrl.signal });

    // Yield so the Promise constructor has run and onAbort is registered
    await Promise.resolve();
    ctrl.abort(); // fires onAbort → reject(DOMException)

    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("in-flight abort with hanging transaction leaves no data in IDB", async () => {
    const db = await getDB();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hangingTx: any = {
      objectStore: () => ({
        put: () => ({ onsuccess: null, onerror: null }),
      }),
      abort: () => {
        /* no-op */
      },
      oncomplete: null,
      onerror: null,
      error: null,
    };

    vi.spyOn(db, "transaction").mockImplementationOnce(() => hangingTx as unknown as IDBTransaction);

    const ctrl = new AbortController();
    const p = saveFileBuffer("aborted-inflight.bin", makeBuf(4), { signal: ctrl.signal });
    await Promise.resolve();
    ctrl.abort();
    await p.catch(() => {
      /* expected */
    });

    // The hanging transaction never committed, so nothing was written
    await expect(loadFileBuffer("aborted-inflight.bin")).resolves.toBeNull();
  });
});

// Lines 167-169: transaction.onerror body in saveFileBuffer
//
// The handler inspects `transaction.error.name`:
//   const isQuota = error?.name === "QuotaExceededError";
//   reject(new StorageError(isQuota ? "Storage quota exceeded" : `Save failed: …`,
//                           isQuota ? "QUOTA_EXCEEDED" : "UNKNOWN", error));

describe("Coverage — lines 167-169: saveFileBuffer transaction.onerror", () => {
  it("rejects with StorageError (code UNKNOWN) when transaction fires onerror", async () => {
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    await expect(saveFileBuffer("save-tx-err.bin", makeBuf(4))).rejects.toBeInstanceOf(StorageError);
  });

  it("StorageError.code is UNKNOWN for a generic transaction error", async () => {
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    const err = await saveFileBuffer("save-tx-err-code.bin", makeBuf(4)).catch((e) => e);
    expect((err as StorageError).code).toBe("UNKNOWN");
  });

  it("rejects with StorageError (code QUOTA_EXCEEDED) when transaction error name is QuotaExceededError", async () => {
    const db = await getDB();

    // Build an error whose .name property is "QuotaExceededError"
    const quotaErr = new DOMException("QuotaExceededError");
    Object.defineProperty(quotaErr, "name", { value: "QuotaExceededError" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = {
      objectStore: () => ({
        put: () => ({ onsuccess: null, onerror: null }),
        get: () => ({ onsuccess: null, onerror: null }),
        delete: () => ({}),
        count: () => ({ onsuccess: null, onerror: null }),
        clear: () => ({}),
        index: () => ({ openCursor: () => ({ onsuccess: null, onerror: null }) }),
      }),
      abort: () => {
        /* no-op */
      },
      oncomplete: null,
      onerror: null as (() => void) | null,
      error: quotaErr,
    };

    vi.spyOn(db, "transaction").mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (typeof tx.onerror === "function") tx.onerror();
      });
      return tx as unknown as IDBTransaction;
    });

    const err = await saveFileBuffer("quota-err.bin", makeBuf(4)).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe("QUOTA_EXCEEDED");
    expect((err as StorageError).message).toMatch(/quota/i);
  });
});

// Lines 237-238: transaction.onerror body in loadFileBuffer

describe("Coverage — lines 237-238: loadFileBuffer transaction.onerror", () => {
  it("rejects with StorageError when the load transaction fires onerror", async () => {
    await saveFileBuffer("load-tx-err.bin", makeBuf(4));
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    await expect(loadFileBuffer("load-tx-err.bin")).rejects.toBeInstanceOf(StorageError);
  });

  it("StorageError message contains 'Load failed' on load transaction error", async () => {
    await saveFileBuffer("load-tx-msg.bin", makeBuf(4));
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    const err = await loadFileBuffer("load-tx-msg.bin").catch((e) => e);
    expect((err as StorageError).message).toMatch(/load failed/i);
  });
});

// Lines 262-264: transaction.onerror body in deleteFileBuffer

describe("Coverage — lines 262-264: deleteFileBuffer transaction.onerror", () => {
  it("rejects with StorageError when the delete transaction fires onerror", async () => {
    await saveFileBuffer("del-tx-err.bin", makeBuf(4));
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    await expect(deleteFileBuffer("del-tx-err.bin")).rejects.toBeInstanceOf(StorageError);
  });

  it("StorageError message contains 'Delete failed' on delete transaction error", async () => {
    await saveFileBuffer("del-tx-msg.bin", makeBuf(4));
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    const err = await deleteFileBuffer("del-tx-msg.bin").catch((e) => e);
    expect((err as StorageError).message).toMatch(/delete failed/i);
  });
});

describe("Coverage — line 329: listFileBuffers + clearAllBuffers transaction.onerror", () => {
  it("listFileBuffers rejects with StorageError when transaction fires onerror", async () => {
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    await expect(listFileBuffers()).rejects.toBeInstanceOf(StorageError);
  });

  it("StorageError message contains 'List failed' on list transaction error", async () => {
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    const err = await listFileBuffers().catch((e) => e);
    expect((err as StorageError).message).toMatch(/list failed/i);
  });

  it("clearAllBuffers rejects with StorageError when transaction fires onerror", async () => {
    await saveFileBuffer("clear-tx-err.bin", makeBuf(4));
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    await expect(clearAllBuffers()).rejects.toBeInstanceOf(StorageError);
  });

  it("StorageError message contains 'Clear failed' on clear transaction error", async () => {
    await saveFileBuffer("clear-tx-msg.bin", makeBuf(4));
    const db = await getDB();
    spyTransactionError(db, "UnknownError");
    const err = await clearAllBuffers().catch((e) => e);
    expect((err as StorageError).message).toMatch(/clear failed/i);
  });
});
