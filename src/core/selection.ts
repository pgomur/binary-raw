/**
 * @file Global state for the active byte selection.
 * Pub/sub pattern: hex-view writes, inspector and status-bar read.
 */

import type { SelectionState, AbsoluteOffset, ByteCount } from "@app-types/index";
import { Offset, Bytes, Selection } from "@app-types/index";

// Internal state

let current: SelectionState = Selection.none();
const listeners = new Set<(sel: SelectionState) => void>();

// Public API

/**
 * Returns the current active selection.
 */
export function getSelection(): SelectionState {
  return current;
}

/**
 * Sets a new selection and notifies all subscribers.
 */
export function setSelection(sel: SelectionState): void {
  current = sel;
  notify();
}

/**
 * Clears the current selection.
 */
export function clearSelection(): void {
  current = Selection.none();
  notify();
}

/**
 * Starts a new selection at the given offset.
 */
export function startSelection(offset: AbsoluteOffset): void {
  current = Selection.start(offset);
  notify();
}

/**
 * Updates the current selection to the given offset.
 * If there's no active selection, creates a new one.
 */
export function updateSelection(offset: AbsoluteOffset): void {
  if (current.type === "none") {
    current = Selection.start(offset);
  } else if (current.type === "selecting") {
    current = Selection.update(current, offset);
  } else {
    // If already selected, start new from previous anchor
    current = Selection.start(offset);
  }

  notify();
}

/**
 * Commits the current selection (finalizes the range).
 */
export function commitSelection(): void {
  current = Selection.commit(current);
  notify();
}

/**
 * Subscribes a function to be called whenever the selection changes.
 * Returns a function to unsubscribe.
 */
export function onSelectionChange(fn: (sel: SelectionState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Completely resets the state. Called by editor.ts when closing a file.
 */
export function resetSelection(): void {
  current = Selection.none();
  listeners.clear();
}

// Helpers

function notify(): void {
  for (const fn of listeners) {
    fn(current);
  }
}

// Selection utils

/**
 * Returns the minimum and maximum offset of the selection (normalized).
 * Useful when start > end due to reverse drag.
 */
export function normalizeSelection(sel: SelectionState): { min: AbsoluteOffset; max: AbsoluteOffset } | null {
  if (sel.type === "none") return null;

  if (sel.type === "selecting") {
    // FIXED: Use Offset.create instead of casts
    const min = Offset.create(Math.min(sel.anchor, sel.current));
    const max = Offset.create(Math.max(sel.anchor, sel.current));
    return { min, max };
  }

  // Selected
  const min = Offset.create(Math.min(sel.range.start, sel.range.end));
  const max = Offset.create(Math.max(sel.range.start, sel.range.end));
  return { min, max };
}

/**
 * Returns true if `offset` is within the current selection.
 */
export function isOffsetSelected(offset: AbsoluteOffset): boolean {
  if (current.type === "none") return false;

  const normalized = normalizeSelection(current);
  if (!normalized) return false;

  // Direct comparison works because they are number at runtime
  return offset >= normalized.min && offset <= normalized.max;
}

/**
 * Length of the selection in bytes.
 */
export function selectionLength(sel: SelectionState): ByteCount {
  if (sel.type === "none") return Bytes.create(0);
  if (sel.type === "selecting") {
    return (Offset.diff(sel.anchor, sel.current) + 1) as ByteCount;
  }
  return sel.range.length;
}
