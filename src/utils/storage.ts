/**
 * @file Robust heavy file persistence using IndexedDB.
 *
 * Features:
 * - Singleton connection pool with automatic cleanup
 * - Versioned migration system
 * - Indexed metadata (size, date, hash)
 * - Quota and storage error handling
 * - Promise-based API with abort support
 */

// Constants

const DB_NAME = "binary-raw-db";
const DB_VERSION = 3; // Incremented to add recents store
const STORE_BUFFERS = "file-buffers";
const STORE_METADATA = "file-metadata";
// EXPORTED: Shared with recents.ts
export const STORE_RECENTS = "file-recents";
const MAX_KEY_LENGTH = 500; // IndexedDB limit for string keys

// ── Types ─────────────────────────────────────────────────────

export interface FileMetadata {
  /** Unique file name (primary key) */
  readonly name: string;
  /** Size in bytes */
  readonly size: number;
  /** Save timestamp (ms since epoch) */
  readonly savedAt: number;
  /** Integrity hash (FNV-1a 32-bit) */
  readonly hash?: string;
}

/**
 * Summary information about a stored file for listing.
 * Omits hash to reduce overhead in large listings.
 */
export interface StorageInfo {
  /** File name */
  readonly name: string;
  /** Size in bytes */
  readonly size: number;
  /** Save timestamp */
  readonly savedAt: number;
}

/**
 * Storage-specific error with categorized error codes.
 * Provides programmatic error handling via code property.
 */
export class StorageError extends Error {
  /**
   * @param message - Human-readable error description
   * @param code - Error category for switch/case handling
   * @param cause - Original IndexedDB error (optional)
   */
  constructor(
    message: string,
    public readonly code: "QUOTA_EXCEEDED" | "VERSION_ERROR" | "BLOCKED" | "NOT_AVAILABLE" | "SERIALIZATION_ERROR" | "UNKNOWN",
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

// Singleton connection

let dbPromise: Promise<IDBDatabase> | null = null;
let dbInstance: IDBDatabase | null = null;

/**
 * Gets a cached IndexedDB connection or creates a new one.
 * Reuses existing instance if already open.
 * Sets up automatic cleanup on beforeunload and close events.
 * @returns Promise that resolves with the IDBDatabase instance
 * @throws {StorageError} If database opening fails
 */
export function getDB(): Promise<IDBDatabase> {
  if (dbInstance !== null) {
    return Promise.resolve(dbInstance);
  }

  if (!dbPromise) {
    dbPromise = openDB()
      .then((db) => {
        dbInstance = db;

        const cleanup = () => {
          db.close();
          dbInstance = null;
          dbPromise = null;
        };

        window.addEventListener("beforeunload", cleanup, { once: true });
        db.addEventListener("close", () => {
          dbInstance = null;
          dbPromise = null;
        });

        return db;
      })
      .catch((err) => {
        dbPromise = null;
        throw err;
      });
  }

  return dbPromise;
}

/**
 * Opens the IndexedDB database with versioned migrations.
 * Handles upgrade blocked, versionchange, and opening errors.
 * @returns Promise that resolves with the IDBDatabase instance
 * @throws {StorageError} With code BLOCKED if another tab is blocking the upgrade
 * @throws {StorageError} With code VERSION_ERROR if version is invalid
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onblocked = () => {
      reject(new StorageError("Database upgrade blocked by another tab. Please close other tabs.", "BLOCKED"));
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains(STORE_BUFFERS)) {
          db.createObjectStore(STORE_BUFFERS);
        }
      }

      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          const metaStore = db.createObjectStore(STORE_METADATA, { keyPath: "name" });
          metaStore.createIndex("savedAt", "savedAt", { unique: false });
          metaStore.createIndex("size", "size", { unique: false });
        }
      }

      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains(STORE_RECENTS)) {
          db.createObjectStore(STORE_RECENTS, { keyPath: "id" });
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      // Runtime version error handling
      db.onversionchange = () => {
        db.close();
        dbInstance = null;
        dbPromise = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      const error = request.error;
      const code = error?.name === "VersionError" ? "VERSION_ERROR" : "UNKNOWN";
      reject(new StorageError(`Failed to open database: ${error?.message}`, code, error));
    };
  });
}

// Validation and utilities

/**
 * Validates that the file name is valid for IndexedDB.
 * @param name - Name to validate
 * @throws {StorageError} If name is invalid or exceeds limit
 */
function validateKey(name: string): void {
  if (!name || typeof name !== "string") {
    throw new StorageError("Invalid file name", "UNKNOWN");
  }
  if (name.length > MAX_KEY_LENGTH) {
    throw new StorageError(`File name too long (max ${MAX_KEY_LENGTH})`, "UNKNOWN");
  }
}

/**
 * Calculates FNV-1a 32-bit hash for integrity verification.
 * @param buffer - Data to hash
 * @returns Hash as hexadecimal string (8 characters)
 */
function calculateHash(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hash = 0x811c9dc5;

  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    if (b === undefined) continue;
    hash ^= b;
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Main operations

/**
 * Saves a binary file to IndexedDB with associated metadata.
 * Uses atomic transaction: if metadata fails, buffer is rolled back.
 * @param name - Unique file identifier
 * @param buffer - Binary content to save
 * @param options - Additional options (signal for abort)
 * @returns Promise that resolves when save completes
 * @throws {StorageError} With code QUOTA_EXCEEDED if quota exceeded
 * @throws {DOMException} With name "AbortError" if operation aborted
 */
export async function saveFileBuffer(name: string, buffer: ArrayBuffer, options?: { signal?: AbortSignal }): Promise<void> {
  validateKey(name);

  if (options?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_BUFFERS, STORE_METADATA], "readwrite");
    const bufferStore = transaction.objectStore(STORE_BUFFERS);
    const metaStore = transaction.objectStore(STORE_METADATA);

    // Abort handling
    const onAbort = () => {
      transaction.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    // Metadata
    const metadata: FileMetadata = {
      name,
      size: buffer.byteLength,
      savedAt: Date.now(),
      hash: calculateHash(buffer),
    };

    // Operations
    const bufferRequest = bufferStore.put(buffer, name);
    const metaRequest = metaStore.put(metadata);

    // Successful commit
    transaction.oncomplete = () => {
      options?.signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    // Errors
    transaction.onerror = () => {
      const error = transaction.error;
      const isQuota = error?.name === "QuotaExceededError";
      reject(new StorageError(isQuota ? "Storage quota exceeded" : `Save failed: ${error?.message}`, isQuota ? "QUOTA_EXCEEDED" : "UNKNOWN", error));
    };

    // Cleanup listener on success
    bufferRequest.onsuccess = () => {
      // Buffer saved, waiting for metadata
    };
  });
}

/**
 * Retrieves a binary file and its metadata from IndexedDB.
 * @param name - Unique file identifier
 * @param options - Options: verifyHash for integrity check, signal for abort
 * @returns Object with buffer and metadata, or null if not found
 * @throws {StorageError} If hash verification fails (corrupted data)
 * @throws {DOMException} With name "AbortError" if operation aborted
 */
export async function loadFileBuffer(name: string, options?: { verifyHash?: boolean; signal?: AbortSignal }): Promise<{ buffer: ArrayBuffer; metadata: FileMetadata } | null> {
  validateKey(name);

  if (options?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_BUFFERS, STORE_METADATA], "readonly");
    const bufferStore = transaction.objectStore(STORE_BUFFERS);
    const metaStore = transaction.objectStore(STORE_METADATA);

    const bufferReq = bufferStore.get(name);
    const metaReq = metaStore.get(name);

    let buffer: ArrayBuffer | undefined;
    let metadata: FileMetadata | undefined;

    bufferReq.onsuccess = () => {
      buffer = bufferReq.result;
    };

    metaReq.onsuccess = () => {
      metadata = metaReq.result;
    };

    transaction.oncomplete = () => {
      if (!buffer || !metadata) {
        resolve(null);
        return;
      }

      // Optional integrity verification
      if (options?.verifyHash && metadata.hash) {
        const currentHash = calculateHash(buffer);
        if (currentHash !== metadata.hash) {
          reject(new StorageError("Data integrity check failed - file may be corrupted", "UNKNOWN"));
          return;
        }
      }

      resolve({ buffer, metadata });
    };

    transaction.onerror = () => {
      reject(new StorageError(`Load failed: ${transaction.error?.message}`, "UNKNOWN"));
    };
  });
}

/**
 * Deletes a file and its metadata atomically.
 * @param name - Unique file identifier to delete
 * @returns true if file existed and was deleted, false if not found
 * @throws {StorageError} If delete operation fails
 */
export async function deleteFileBuffer(name: string): Promise<boolean> {
  validateKey(name);
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_BUFFERS, STORE_METADATA], "readwrite");
    const bufferStore = transaction.objectStore(STORE_BUFFERS);
    const metaStore = transaction.objectStore(STORE_METADATA);

    // Check existence first
    const checkReq = metaStore.count(name);
    let existed = false;

    checkReq.onsuccess = () => {
      existed = checkReq.result > 0;
      if (existed) {
        bufferStore.delete(name);
        metaStore.delete(name);
      }
    };

    transaction.oncomplete = () => resolve(existed);
    transaction.onerror = () => reject(new StorageError(`Delete failed: ${transaction.error?.message}`, "UNKNOWN"));
  });
}

/**
 * Lists all stored files sorted by date (most recent first).
 * @returns Array of StorageInfo with summary information for each file
 * @throws {StorageError} If read operation fails
 */
export async function listFileBuffers(): Promise<StorageInfo[]> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_METADATA, "readonly");
    const store = transaction.objectStore(STORE_METADATA);
    const index = store.index("savedAt");
    const request = index.openCursor(null, "prev"); // Most recent first

    const results: StorageInfo[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const meta = cursor.value as FileMetadata;
        results.push({
          name: meta.name,
          size: meta.size,
          savedAt: meta.savedAt,
        });
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve(results);
    transaction.onerror = () => reject(new StorageError(`List failed: ${transaction.error?.message}`, "UNKNOWN"));
  });
}

/**
 * Deletes all stored files and metadata.
 * Warning: irreversible destructive operation.
 * @returns Promise that resolves when cleanup completes
 * @throws {StorageError} If clear operation fails
 */
export async function clearAllBuffers(): Promise<void> {
  const db = await getDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_BUFFERS, STORE_METADATA], "readwrite");
    transaction.objectStore(STORE_BUFFERS).clear();
    transaction.objectStore(STORE_METADATA).clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new StorageError(`Clear failed: ${transaction.error?.message}`, "UNKNOWN"));
  });
}

/**
 * Explicitly closes the IndexedDB connection.
 * Useful for testing or when resources need to be released early.
 * Invalidates the singleton so next getDB() call creates a new connection.
 */
export function closeConnection(): void {
  dbInstance?.close();
  dbInstance = null;
  dbPromise = null;
}
