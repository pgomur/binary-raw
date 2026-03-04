/**
 * @file Recent files management using IndexedDB (same DB as storage.ts).
 * Domain-driven design: Result types, immutability, explicit error handling.
 */

import type { RecentFileEntry, FileFormat } from '@app-types/index'
import { Bytes } from '@app-types/index'

import { deleteFileBuffer, StorageError, getDB, STORE_RECENTS } from '@utils/storage'

const MAX_RECENTS = 20


// Result type for operations that can fail

/**
 * Result type for operations that can fail.
 * Uses discriminated union for type-safe error handling.
 */
export type Result<T, E = StorageError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

// Schema validation for stored data

/**
 * Serialized format for RecentFileEntry in IndexedDB.
 * Uses primitives only (no classes) for storage compatibility.
 */
interface SerializedRecent {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly format: string
  readonly lastOpened: string
  readonly pinned?: boolean
  readonly tags?: string[]
}

/**
 * Type guard to validate serialized recent entry.
 * @param obj - Unknown value to validate
 * @returns true if obj is a valid SerializedRecent
 */
function isValidSerializedRecent(obj: unknown): obj is SerializedRecent {
  if (typeof obj !== 'object' || obj === null) return false
  const r = obj as Record<string, unknown>

    return (
    typeof r['id'] === 'string' &&
    typeof r['name'] === 'string' &&
    typeof r['size'] === 'number' &&
    r['size'] >= 0 &&
    Number.isInteger(r['size']) &&
    typeof r['format'] === 'string' &&
    typeof r['lastOpened'] === 'string' &&
    !isNaN(Date.parse(r['lastOpened'] as string))
  )
}

/**
 * Converts serialized data to RecentFileEntry.
 * @param serialized - Serialized recent entry from IndexedDB
 * @returns RecentFileEntry instance
 */
function deserializeRecent(serialized: SerializedRecent): RecentFileEntry {
  return {
    id: serialized.id,
    name: serialized.name,
    size: Bytes.create(serialized.size),
    format: serialized.format as FileFormat,
    lastOpened: serialized.lastOpened,
    pinned: serialized.pinned ?? false,
    tags: Array.isArray(serialized.tags)
      ? serialized.tags.filter((t): t is string => typeof t === 'string')
      : []
  }
}

/**
 * Converts RecentFileEntry to storable format.
 * @param entry - Recent file entry to serialize
 * @returns Serializable object for IndexedDB
 */
function serializeRecent(entry: RecentFileEntry): SerializedRecent {
  return {
    id: entry.id,
    name: entry.name,
    size: entry.size,
    format: entry.format,
    lastOpened: entry.lastOpened,
    pinned: entry.pinned,
    tags: [...entry.tags]
  }
}

// Load recents

/**
 * Loads all recent files from IndexedDB.
 * Validates and deserializes each entry, filtering invalid ones.
 * @returns Result containing array of RecentFileEntry or error
 */
export async function loadRecents(): Promise<Result<readonly RecentFileEntry[]>> {
  try {
    const db = await getDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_RECENTS, "readonly")
      const store = transaction.objectStore(STORE_RECENTS)
      const request = store.getAll()

      request.onsuccess = () => {
        const raw = request.result as unknown[]
        const validEntries = raw
          .filter(isValidSerializedRecent)
          .map(deserializeRecent)
          .sort((a, b) => new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime())

        if (validEntries.length !== raw.length) {
          console.warn(`Filtered ${raw.length - validEntries.length} invalid recent entries`)
        }

        resolve({ ok: true, value: validEntries })
      }

      request.onerror = () => reject(new StorageError(
        'Failed to load recents',
        'UNKNOWN',
        request.error
      ))
    })

  } catch (cause) {
    return {
      ok: false,
      error: new StorageError(
        'Failed to load recents',
        'NOT_AVAILABLE',
        cause
      )
    }
  }
}

// Save a recent

/**
 * Options for saving a recent file.
 */
export interface SaveRecentOptions {
  /** Allow multiple entries with same name (default: false) */
  readonly allowDuplicateNames?: boolean
  /** Maximum number of recent files to keep (default: 20) */
  readonly maxRecents?: number
}

/**
 * Saves a file to the recent files list.
 * Adds to front, removes duplicates based on strategy, limits total count.
 * @param file - Recent file entry to save
 * @param options - Save options
 * @returns Result indicating success or failure
 */
export async function saveRecent(
  file: RecentFileEntry,
  options: SaveRecentOptions = {}
): Promise<Result<void>> {
  const { allowDuplicateNames = false, maxRecents = MAX_RECENTS } = options

  const loadResult = await loadRecents()

  if (!loadResult.ok) {
    console.warn('Could not load existing recents, overwriting')
  }

  const existing = loadResult.ok ? loadResult.value : []

  const filtered = allowDuplicateNames
    ? existing
    : existing.filter(r => r.name !== file.name && r.id !== file.id)

  const withoutIdDupes = filtered.filter(r => r.id !== file.id)

  const updated = [file, ...withoutIdDupes].slice(0, maxRecents)

  try {
    const db = await getDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_RECENTS, "readwrite")
      const store = transaction.objectStore(STORE_RECENTS)

      store.clear()

      for (const entry of updated) {
        store.put(serializeRecent(entry))
      }

      transaction.oncomplete = () => resolve({ ok: true, value: undefined })
      transaction.onerror = () => {
        const error = transaction.error
        const isQuota = error?.name === 'QuotaExceededError'
        reject(new StorageError(
          'Failed to save recent',
          isQuota ? 'QUOTA_EXCEEDED' : 'UNKNOWN',
          error
        ))
      }
    })

  } catch (cause) {
    return {
      ok: false,
      error: new StorageError(
        'Failed to save recent',
        'SERIALIZATION_ERROR',
        cause
      )
    }
  }
}

// Remove a recent

/**
 * Strategy for matching recent file to remove.
 * - by-name: Match by name OR id
 * - by-id: Match by id only
 * - by-name-strict: Match by name only
 */
export type RemoveStrategy = 'by-name' | 'by-id' | 'by-name-strict'

/**
 * Removes a recent file from the list.
 * Optionally deletes the associated file buffer.
 * @param identifier - File name or id to remove
 * @param strategy - Matching strategy (default: by-name)
 * @returns Result with true if file was found and removed
 */
export async function removeRecent(
  identifier: string,
  strategy: RemoveStrategy = 'by-name'
): Promise<Result<boolean>> {
  const loadResult = await loadRecents()
  if (!loadResult.ok) {
    return { ok: false, error: loadResult.error }
  }

  const current = loadResult.value

  let removed = false
  const buffersToClean: string[] = []

  const filtered = current.filter(r => {
    const match = strategy === 'by-id'
      ? r.id === identifier
      : strategy === 'by-name-strict'
        ? r.name === identifier
        : r.name === identifier || r.id === identifier

    if (match) {
      removed = true
      buffersToClean.push(r.name)
    }

    return !match
  })

  if (!removed) {
    return { ok: true, value: false }
  }

  try {
    const db = await getDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_RECENTS, "readwrite")
      const store = transaction.objectStore(STORE_RECENTS)

      store.clear()
      for (const entry of filtered) {
        store.put(serializeRecent(entry))
      }

      transaction.oncomplete = () => {
        Promise.all(buffersToClean.map(deleteFileBuffer)).catch(console.error)
        resolve({ ok: true, value: true })
      }
      transaction.onerror = () => reject(new StorageError(
        'Failed to remove recent',
        'NOT_AVAILABLE'
      ))
    })

  } catch (cause) {
    return {
      ok: false,
      error: new StorageError('Failed to remove recent', 'NOT_AVAILABLE', cause)
    }
  }
}

// Update an existing recent

/**
 * Fields that can be updated in a recent file entry.
 */
export type UpdatableFields = {
  readonly size?: RecentFileEntry['size']
  readonly format?: RecentFileEntry['format']
  readonly lastOpened?: string
  readonly pinned?: boolean
  readonly tags?: RecentFileEntry['tags']
}

/**
 * Updates specific fields of an existing recent file.
 * @param id - File id to update
 * @param updates - Fields to update (partial)
 * @returns Result with true if file was found and updated
 */
export async function updateRecent(
  id: string,
  updates: UpdatableFields
): Promise<Result<boolean>> {
  const loadResult = await loadRecents()
  if (!loadResult.ok) return { ok: false, error: loadResult.error }

  const current = loadResult.value
  const existing = current.find(r => r.id === id)

  if (existing === undefined) {
    return { ok: true, value: false }
  }

  const updated: RecentFileEntry = {
    id: existing.id,
    name: existing.name,
    size: updates.size !== undefined ? updates.size : existing.size,
    format: updates.format !== undefined ? updates.format : existing.format,
    lastOpened: updates.lastOpened !== undefined ? updates.lastOpened : existing.lastOpened,
    pinned: updates.pinned !== undefined ? updates.pinned : existing.pinned,
    tags: updates.tags !== undefined ? updates.tags : existing.tags
  }

  const newList = [
    updated,
    ...current.slice(0, current.indexOf(existing)),
    ...current.slice(current.indexOf(existing) + 1)
  ]

  try {
    const db = await getDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_RECENTS, "readwrite")
      const store = transaction.objectStore(STORE_RECENTS)

      store.clear()
      for (const entry of newList) {
        store.put(serializeRecent(entry))
      }

      transaction.oncomplete = () => resolve({ ok: true, value: true })
      transaction.onerror = () => reject(new StorageError(
        'Failed to update recent',
        'SERIALIZATION_ERROR'
      ))
    })

  } catch (cause) {
    return {
      ok: false,
      error: new StorageError('Failed to update recent', 'SERIALIZATION_ERROR', cause)
    }
  }
}

// Toggle pin status

/**
 * Toggles the pinned status of a recent file.
 * @param id - File id to toggle pin
 * @returns Result with true if file was found and updated
 */
export async function togglePinRecent(id: string): Promise<Result<boolean>> {
  const loadResult = await loadRecents()
  if (!loadResult.ok) return { ok: false, error: loadResult.error }

  const entry = loadResult.value.find(r => r.id === id)
  if (entry === undefined) return { ok: true, value: false }

  return updateRecent(id, { pinned: !entry.pinned })
}

// Mark file as opened now

/**
 * Updates the lastOpened timestamp to current time.
 * @param id - File id to touch
 * @returns Result with true if file was found and updated
 */
export async function touchRecent(id: string): Promise<Result<boolean>> {
  return updateRecent(id, { lastOpened: new Date().toISOString() })
}

// Clear all recents

/**
 * Options for clearing recent files.
 */
export interface ClearRecentsOptions {
  /** Also delete associated file buffers (default: true) */
  readonly clearBuffers?: boolean
}

/**
 * Clears all recent files from storage.
 * Optionally deletes associated file buffers.
 * @param options - Clear options
 * @returns Result indicating success or failure
 */
export async function clearRecents(
  options: ClearRecentsOptions = {}
): Promise<Result<void>> {
  const { clearBuffers = true } = options

  const loadResult = await loadRecents()

  try {
    const db = await getDB()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_RECENTS, "readwrite")
      const store = transaction.objectStore(STORE_RECENTS)

      store.clear()

      transaction.oncomplete = async () => {
        if (clearBuffers && loadResult.ok) {
          await Promise.all(loadResult.value.map(r => deleteFileBuffer(r.name)))
        }
        resolve({ ok: true, value: undefined })
      }
      transaction.onerror = () => reject(new StorageError(
        'Failed to clear recents',
        'NOT_AVAILABLE'
      ))
    })

  } catch (cause) {
    return {
      ok: false,
      error: new StorageError('Failed to clear recents', 'NOT_AVAILABLE', cause)
    }
  }
}

// Useful queries

/**
 * Finds a recent file by its id.
 * @param id - File id to search
 * @returns RecentFileEntry or null if not found
 */
export async function findRecentById(id: string): Promise<RecentFileEntry | null> {
  const result = await loadRecents()
  if (!result.ok) return null
  return result.value.find(r => r.id === id) ?? null
}

/**
 * Finds a recent file by its name.
 * @param name - File name to search
 * @returns RecentFileEntry or null if not found
 */
export async function findRecentByName(name: string): Promise<RecentFileEntry | null> {
  const result = await loadRecents()
  if (!result.ok) return null
  return result.value.find(r => r.name === name) ?? null
}

/**
 * Gets all pinned recent files.
 * @returns Array of pinned RecentFileEntry (empty on error)
 */
export async function getPinnedRecents(): Promise<readonly RecentFileEntry[]> {
  const result = await loadRecents()
  if (!result.ok) return []
  return result.value.filter(r => r.pinned)
}

// Backward compatibility (alias)

/** @deprecated Use RecentFileEntry instead */
export type RecentFile = RecentFileEntry