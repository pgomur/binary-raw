/**
 * @file Command pattern for byte editing with undo/redo.
 * Tracks which bytes have been modified from the original.
 *
 * State architecture:
 * - buffer: current editable state
 * - originalSnapshot: immutable copy of initial state (for comparison)
 * - modified: cache of bytes that differ from original (for fast UI)
 * - undoStack/redoStack: command history
 */

import type { AbsoluteOffset, ByteCount } from "@app-types/index";
import { Offset, Bytes } from "@app-types/index";

// Types

interface ByteEdit {
  readonly offset: AbsoluteOffset;
  readonly oldValue: number;
  readonly newValue: number;
}

interface Command {
  readonly edits: readonly ByteEdit[];
}

// Listeners

export type ChangeListener = (modifiedCount: number) => void;
const listeners = new Set<ChangeListener>();

// State

let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));

// Immutable snapshot of original state (only created in init)
let originalSnapshot: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));

// Cache of modified bytes: offset -> current value (not the original)
// Maintained for O(1) in UI, lazily recalculated if needed
const modifiedCache = new Map<AbsoluteOffset, number>();

let undoStack: Command[] = [];
let redoStack: Command[] = [];

// Initialization

export function initEditor(buf: ArrayBuffer): void {
  // Create independent copies
  const copy = new Uint8Array(buf.slice(0));
  buffer = copy;
  // FIXED: Snapshot is a separate copy, not a reference
  originalSnapshot = new Uint8Array(buf.slice(0));

  undoStack = [];
  redoStack = [];
  modifiedCache.clear();
  rebuildModifiedCache(); // Initial build
  notify();
}

export function destroyEditor(): void {
  buffer = new Uint8Array(new ArrayBuffer(0));
  originalSnapshot = new Uint8Array(new ArrayBuffer(0));
  undoStack = [];
  redoStack = [];
  modifiedCache.clear();
  listeners.clear();
}

// Reading

export function getBuffer(): Uint8Array<ArrayBuffer> {
  return buffer;
}

/**
 * Returns map of modified bytes: offset -> CURRENT value.
 * To get the original value, use getOriginalByte(offset).
 */
export function getModified(): ReadonlyMap<AbsoluteOffset, number> {
  return modifiedCache;
}

export function modifiedCount(): number {
  return modifiedCache.size;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/**
 * Gets the ORIGINAL value of a byte (from initial snapshot).
 * O(1), never changes during editor lifetime.
 */
export function getOriginalByte(offset: AbsoluteOffset): number | undefined {
  return originalSnapshot[offset];
}

/**
 * Checks if a specific byte has been modified from the original.
 */
export function isByteModified(offset: AbsoluteOffset): boolean {
  const current = buffer[offset];
  const original = originalSnapshot[offset];
  // FIXED: Guard for noUncheckedIndexedAccess
  if (current === undefined || original === undefined) return false;
  return current !== original;
}

// Writing

export function editByte(offset: AbsoluteOffset, newValue: number): void {
  if (offset < 0 || offset >= buffer.length) return;

  const current = buffer[offset];
  if (current === undefined) return;

  const clamped = newValue & 0xff;
  if (current === clamped) return;

  executeCommand({ edits: [{ offset, oldValue: current, newValue: clamped }] });
}

export function editRange(startOffset: AbsoluteOffset, values: number[]): void {
  if (!Array.isArray(values) || values.length === 0) return;

  const edits: ByteEdit[] = [];

  for (let i = 0; i < values.length; i++) {
    const abs = Offset.add(startOffset, Bytes.create(i));
    if (abs >= buffer.length) break;

    const current = buffer[abs];
    const input = values[i];
    if (current === undefined || input === undefined) continue;

    const clamped = input & 0xff;
    if (current !== clamped) {
      edits.push({ offset: abs, oldValue: current, newValue: clamped });
    }
  }

  if (edits.length > 0) {
    executeCommand({ edits });
  }
}

// Undo / Redo

export function undo(): void {
  const cmd = undoStack.pop();
  if (!cmd) return;

  // Revert edits in reverse order to maintain consistency
  for (let i = cmd.edits.length - 1; i >= 0; i--) {
    const edit = cmd.edits[i];
    if (edit === undefined) continue;

    if (edit.offset >= buffer.length) continue;

    buffer[edit.offset] = edit.oldValue;
  }

  redoStack.push(cmd);
  rebuildModifiedCache();
  notify();
}

export function redo(): void {
  const cmd = redoStack.pop();
  if (!cmd) return;

  for (const edit of cmd.edits) {
    if (edit.offset >= buffer.length) continue;
    buffer[edit.offset] = edit.newValue;
  }

  undoStack.push(cmd);
  rebuildModifiedCache();
  notify();
}

// Export

export function exportBuffer(): Blob {
  return new Blob([buffer], { type: "application/octet-stream" });
}

// Subscription

export function onEditorChange(fn: ChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Internal helpers

/**
 * Executes a new command: applies, saves to undo, clears redo.
 */
function executeCommand(cmd: Command): void {
  for (const edit of cmd.edits) {
    if (edit.offset >= buffer.length) continue;
    buffer[edit.offset] = edit.newValue;
  }

  undoStack.push(cmd);
  redoStack = [];
  rebuildModifiedCache();
  notify();
}

/**
 * SINGLE FUNCTION to rebuild modified cache.
 * Single source of truth: compares buffer vs originalSnapshot.
 * O(N) where N = buffer.length, but only executes after commands.
 */
function rebuildModifiedCache(): void {
  modifiedCache.clear();

  for (let i = 0; i < buffer.length; i++) {
    const offset = Offset.create(i);
    const current = buffer[offset];
    const original = originalSnapshot[offset];

    if (current === undefined || original === undefined) continue;

    if (current !== original) {
      modifiedCache.set(offset, current);
    }
  }
}

function notify(): void {
  const count = modifiedCache.size;
  for (const fn of listeners) fn(count);
}
