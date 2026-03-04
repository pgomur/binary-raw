/**
 * @file src/ui/components/hex-view.ts
 * Virtualised hex view. Renders only the visible rows.
 * Manages selection via click and drag.
 */

import { formatOffset, byteToHex, sliceRows, totalRows, type HexRow } from "@utils/hex";
import { byteToAsciiChar } from "@utils/encoding";
import { startSelection, updateSelection, commitSelection, onSelectionChange, clearSelection, normalizeSelection, getSelection } from "@core/selection";
import { getBuffer, getModified, editByte, onEditorChange } from "@core/editor";
import type { SelectionState, SectionNode, AbsoluteOffset } from "@app-types/index";
import { Offset } from "@app-types/index";

// Constants

const ROW_HEIGHT_PX = 20; // height of each .hex-row in px — must match CSS
const OVERSCAN_ROWS = 8; // extra rows above/below the viewport for smooth scrolling

// Types

/** Configuration options passed to {@link mountHexView}. */
export interface HexViewOptions {
  /** Offsets belonging to parsed sections → `byte--str` CSS class. */
  structuredOffsets: Set<number>;
  /** Offsets that are magic bytes / header bytes → `byte--sig` CSS class. */
  signatureOffsets: Set<number>;
  /** Bytes per row: 8, 16, or 32. */
  cols: number;
  /** Parsed sections used for structure-based highlighting. */
  sections: SectionNode[];
}

/** Handle returned by {@link mountHexView} for external control and cleanup. */
export interface HexViewHandle {
  /** Fully re-renders the view (after a column change, edit, etc.). */
  refresh(): void;
  /** Scrolls until `offset` is visible, optionally centering it. */
  scrollToOffset(offset: number, forceCenter?: boolean): void;
  /** Changes the column count and re-renders. */
  setCols(cols: number): void;
  /** Replaces the structured-offsets set (after a re-parse). */
  setStructuredOffsets(offsets: Set<number>): void;
  /** Removes all event listeners and clears the DOM. */
  destroy(): void;
}

// Internal state

interface State {
  cols: number;
  structuredOffsets: Set<number>;
  signatureOffsets: Set<number>;
  /** Offset where the current drag selection started. */
  dragStart: AbsoluteOffset | null;
  /** Offset currently being edited via double-click inline editing. */
  editingOffset: AbsoluteOffset | null;
  renderedStartRow: number;
  renderedEndRow: number;
  /** Whether the current interaction is a candidate for a simple click (no significant drag). */
  clickCandidate: boolean;
}

// Factory

/**
 * Mounts the virtualised hex view inside the `#hex-rows` container and
 * returns a {@link HexViewHandle} for external control and cleanup.
 *
 * The buffer and modifications are read from `core/editor` (singleton).
 * Selection state is read from and written to `core/selection` (singleton).
 *
 * Rendering is virtualised: only the rows within the current viewport plus
 * an internal overscan row constant above and below are present in the DOM at any time.
 * Top and bottom spacers simulate the full scroll height.
 *
 * Features:
 * - **Click** – selects a single byte; triggers inline hex editing.
 * - **Shift+click** – extends the selection from the existing anchor.
 * - **Drag** – selects a byte range.
 * - **Arrow keys** – moves the single-byte selection one step at a time.
 * - **Inline editing** – double-click (via mouseup candidate) opens a
 *   contenteditable hex cell; Tab advances to the next byte.
 *
 * @param container - The `div#hex-rows` element in the DOM.
 * @param options   - Column count and special-offset sets; see {@link HexViewOptions}.
 * @returns A {@link HexViewHandle} for refreshing, scrolling, and destroying the view.
 */
export function mountHexView(container: HTMLElement, options: HexViewOptions): HexViewHandle {
  const state: State = {
    cols: options.cols,
    structuredOffsets: options.structuredOffsets,
    signatureOffsets: options.signatureOffsets,
    dragStart: null,
    editingOffset: null,
    renderedStartRow: -1,
    renderedEndRow: -1,
    clickCandidate: false,
  };

  // Spacers simulate the full scroll height without rendering all rows
  const topSpacer = makeSpacer();
  const bottomSpacer = makeSpacer();
  container.appendChild(topSpacer);
  container.appendChild(bottomSpacer);

  // Virtualised render

  function render(force = false): void {
    const buf = getBuffer();
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight;
    const numRows = totalRows(buf.length, state.cols);

    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT_PX);
    const lastVisible = Math.ceil((scrollTop + viewH) / ROW_HEIGHT_PX);
    const startRow = Math.max(0, firstVisible - OVERSCAN_ROWS);
    const endRow = Math.min(numRows, lastVisible + OVERSCAN_ROWS);

    if (!force && startRow === state.renderedStartRow && endRow === state.renderedEndRow) return;

    state.renderedStartRow = startRow;
    state.renderedEndRow = endRow;

    // Adjust spacers
    topSpacer.style.height = `${startRow * ROW_HEIGHT_PX}px`;
    bottomSpacer.style.height = `${(numRows - endRow) * ROW_HEIGHT_PX}px`;

    // Remove previous rows (everything except spacers)
    for (const child of Array.from(container.children)) {
      if (child !== topSpacer && child !== bottomSpacer) {
        container.removeChild(child);
      }
    }

    // Build new rows
    const rows = sliceRows(buf, state.cols, startRow, endRow);
    const sel = getSelection();
    const modified = getModified();
    const fragment = document.createDocumentFragment();

    for (const row of rows) {
      fragment.appendChild(buildRow(row, state, sel, modified));
    }

    container.insertBefore(fragment, bottomSpacer);
  }

  // Event handlers

  function onScroll(): void {
    render();
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // left button only
    const rawOffset = offsetFromTarget(e.target as Element);
    if (rawOffset === null) return;
    const offset = Offset.create(rawOffset);

    // Shift+click: extend the selection from the existing anchor
    if (e.shiftKey) {
      const sel = getSelection();
      const norm = normalizeSelection(sel);
      if (norm) {
        startSelection(norm.min);
        updateSelection(offset);
        render(true);
        return;
      }
    }

    e.preventDefault();
    state.dragStart = offset;
    state.clickCandidate = true;
    startSelection(offset);
    render(true);
  }

  function onMouseMove(e: MouseEvent): void {
    if (state.dragStart === null) return;
    const rawOffset = offsetFromTarget(e.target as Element);
    if (rawOffset === null) return;

    const offset = Offset.create(rawOffset);
    if (offset !== state.dragStart) {
      state.clickCandidate = false;
      updateSelection(offset);
      render(true);
    }
  }

  function onMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return; // left button only
    if (state.dragStart !== null) {
      commitSelection();

      // If this was a click (same start/end offset), open inline editing
      if (state.clickCandidate) {
        startInlineEdit(state.dragStart);
      }
    }
    state.dragStart = null;
    state.clickCandidate = false;
  }

  function onMouseLeave(): void {
    if (state.dragStart !== null) {
      commitSelection();
      state.dragStart = null;
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Escape cancels inline editing
    if (e.key === "Escape" && state.editingOffset !== null) {
      cancelInlineEdit();
      return;
    }

    // Arrow-key navigation: only when there is an active selection
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      const sel = getSelection();
      const norm = normalizeSelection(sel);
      if (!norm) return;

      e.preventDefault();
      const buf = getBuffer();
      const min = norm.min; // AbsoluteOffset
      let next: number = min;

      if (e.key === "ArrowRight") next = Math.min(buf.length - 1, min + 1);
      if (e.key === "ArrowLeft") next = Math.max(0, min - 1);
      if (e.key === "ArrowDown") next = Math.min(buf.length - 1, min + state.cols);
      if (e.key === "ArrowUp") next = Math.max(0, min - state.cols);

      const nextOffset = Offset.create(next);
      startSelection(nextOffset);
      commitSelection();
      ensureVisible(next);
      render(true);
    }
  }

  function onClickOutside(e: MouseEvent): void {
    if (!container.contains(e.target as Node)) {
      clearSelection();
      render(true);
    }
  }

  container.addEventListener("scroll", onScroll, { passive: true });
  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("mousemove", onMouseMove);
  container.addEventListener("mouseup", onMouseUp);
  container.addEventListener("mouseleave", onMouseLeave);
  // dblclick and click are handled via mouseup (clickCandidate flag)
  container.setAttribute("tabindex", "0");
  container.addEventListener("keydown", onKeyDown);
  document.addEventListener("mousedown", onClickOutside);

  // Subscribe to external selection changes (inspector, sidebar, etc.)
  const unsubSel = onSelectionChange(() => render(true));
  // Subscribe to editor changes (edits, undo/redo)
  const unsubEdit = onEditorChange(() => render(true));

  // Initial render
  render(true);

  // Public handle

  return {
    refresh(): void {
      render(true);
    },

    scrollToOffset(offset: number, forceCenter = true): void {
      ensureVisible(offset, forceCenter);
      render(true);
    },

    setCols(cols: number): void {
      state.cols = cols;
      state.renderedStartRow = -1;
      state.renderedEndRow = -1;
      render(true);
    },

    setStructuredOffsets(offsets: Set<number>): void {
      state.structuredOffsets = offsets;
      render(true);
    },

    destroy(): void {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mouseleave", onMouseLeave);
      container.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onClickOutside);
      unsubSel();
      unsubEdit();
      container.innerHTML = "";
    },
  };

  // Inline editing

  /**
   * Opens the inline hex editor for the byte at `offset`.
   * Accepts up to 2 hex characters; Enter/blur commits, Escape cancels,
   * Tab advances to the adjacent byte.
   *
   * @param offset - The absolute offset of the byte to edit.
   */
  function startInlineEdit(offset: AbsoluteOffset): void {
    state.editingOffset = offset;
    const byteElOrNull = container.querySelector<HTMLElement>(`[data-offset="${offset}"].byte`);
    if (!byteElOrNull) return;
    const el = byteElOrNull;

    const original = el.textContent ?? "";
    el.contentEditable = "true";
    el.style.outline = "1px solid #60a5fa";
    el.style.minWidth = "2ch";

    setTimeout(() => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }, 10);

    function commit(): void {
      const raw = el.textContent?.trim() ?? "";
      const val = parseInt(raw, 16);
      if (!isNaN(val) && val >= 0 && val <= 255) {
        editByte(offset, val);
      } else {
        el.textContent = original;
      }
      el.contentEditable = "false";
      el.style.outline = "";
      el.style.minWidth = "";
      state.editingOffset = null;
    }

    el.addEventListener("blur", commit, { once: true });
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        el.blur();
      }
      if (e.key === "Escape") {
        el.textContent = original;
        el.blur();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        commit();
        const next = e.shiftKey ? offset - 1 : offset + 1;
        const buf = getBuffer();
        if (next >= 0 && next < buf.length) {
          ensureVisible(next);
          render(true);
          startInlineEdit(Offset.create(next));
        }
      }

      const isHex = /^[0-9a-fA-F]$/.test(e.key);
      const isNav = ["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(e.key);
      if (!isHex && !isNav) e.preventDefault();

      // Reject input beyond 2 hex characters when nothing is selected
      const currentText = el.textContent ?? "";
      if (isHex && currentText.length >= 2) {
        if (window.getSelection()?.toString().length === 0) {
          e.preventDefault();
        }
      }
    });
  }

  /**
   * Cancels the active inline edit, restoring the byte's original display value.
   */
  function cancelInlineEdit(): void {
    const offset = state.editingOffset;
    if (offset === null) return;

    const byteEl = container.querySelector<HTMLElement>(`[data-offset="${offset}"].byte`);
    if (byteEl) {
      // Restore value from the buffer (offset is already AbsoluteOffset)
      const buf = getBuffer();
      const original = buf[offset];
      if (original !== undefined) {
        byteEl.textContent = byteToHex(original);
      }
      byteEl.contentEditable = "false";
      byteEl.style.outline = "";
      byteEl.style.minWidth = "";
    }
    state.editingOffset = null;
  }

  // Scroll helper

  /**
   * Scrolls the container so that `offset` is visible.
   * When `forceCenter` is `true` (or the row is near the edges),
   * the row is vertically centred in the viewport.
   *
   * @param offset      - The absolute byte offset to reveal.
   * @param forceCenter - Force centering even when the row is already in view.
   */
  function ensureVisible(offset: number, forceCenter = false): void {
    const row = Math.floor(offset / state.cols);
    const rowTop = row * ROW_HEIGHT_PX;
    const rowBot = rowTop + ROW_HEIGHT_PX;

    const viewportHeight = container.clientHeight;
    const scrollTop = container.scrollTop;

    const isWellVisible = !forceCenter && rowTop >= scrollTop + viewportHeight * 0.2 && rowBot <= scrollTop + viewportHeight * 0.8;

    if (!isWellVisible) {
      container.scrollTop = rowTop - viewportHeight / 2 + ROW_HEIGHT_PX / 2;
    }
  }
}

// Row construction

/**
 * Builds a single `.hex-row` DOM element from a {@link HexRow} descriptor.
 *
 * @param row      - Slice descriptor with offset and byte values.
 * @param state    - Current component state (cols, offset sets).
 * @param sel      - Current selection state (for highlighting).
 * @param modified - Map of modified offsets to their new values.
 * @returns The fully populated row `<div>`.
 */
function buildRow(row: HexRow, state: State, sel: SelectionState, modified: ReadonlyMap<AbsoluteOffset, number>): HTMLElement {
  const { structuredOffsets, signatureOffsets, cols } = state;

  const normSel = normalizeSelection(sel);
  const selMin = normSel ? normSel.min : -1;
  const selMax = normSel ? normSel.max : -1;

  const div = document.createElement("div");
  div.className = "hex-row";
  div.dataset["offset"] = String(row.offset);

  // Offset column
  const offsetEl = document.createElement("span");
  offsetEl.className = "hex-row__offset";
  offsetEl.textContent = formatOffset(row.offset);
  div.appendChild(offsetEl);

  // Bytes column
  const bytesEl = document.createElement("div");
  bytesEl.className = "hex-row__bytes";

  // ASCII column
  const asciiEl = document.createElement("span");
  asciiEl.className = "hex-row__ascii";

  let rowHighlighted = false;

  for (let i = 0; i < row.bytes.length; i++) {
    const abs = row.offset + i;
    const byte = row.bytes[i];
    if (byte === undefined) continue;

    const absOffset = Offset.create(abs);
    const isSel = abs >= selMin && abs <= selMax;
    const isSig = signatureOffsets.has(abs);
    const isMod = modified.has(absOffset);
    const isStr = structuredOffsets.has(abs);
    const isNull = byte === 0;

    if (isSel) rowHighlighted = true;

    // Byte span
    const byteEl = document.createElement("span");
    byteEl.className = byteClass(isSel, isSig, isMod, isStr, isNull);
    byteEl.textContent = byteToHex(byte);
    byteEl.dataset["offset"] = String(abs);
    bytesEl.appendChild(byteEl);

    // ASCII char span (uses .ascii-char instead of .byte to avoid hex spacing)
    const charEl = document.createElement("span");
    charEl.className = `ascii-char ${asciiClass(isSel, isSig, isStr)}`;
    charEl.textContent = byteToAsciiChar(byte);
    charEl.dataset["offset"] = String(abs);
    asciiEl.appendChild(charEl);
  }

  // Padding for incomplete last rows
  for (let i = row.bytes.length; i < cols; i++) {
    const pad = document.createElement("span");
    pad.className = "byte";
    pad.textContent = "  ";
    bytesEl.appendChild(pad);
  }

  div.appendChild(bytesEl);
  div.appendChild(asciiEl);

  if (rowHighlighted) div.classList.add("hex-row--highlighted");

  return div;
}

// CSS class helpers

/**
 * Returns the CSS class string for a hex byte cell based on its state flags.
 * Priority order: selected > modified > signature > structured > null.
 */
function byteClass(isSel: boolean, isSig: boolean, isMod: boolean, isStr: boolean, isNull: boolean): string {
  if (isSel) return "byte byte--sel";
  if (isMod) return "byte byte--mod";
  if (isSig) return "byte byte--sig";
  if (isStr) return "byte byte--str";
  if (isNull) return "byte byte--null";
  return "byte";
}

/**
 * Returns the additional CSS class string for an ASCII char cell.
 */
function asciiClass(isSel: boolean, isSig: boolean, isStr: boolean): string {
  if (isSel) return "ascii-sel";
  if (isSig) return "ascii-sig";
  if (isStr) return "ascii-str";
  return "";
}

// DOM helpers

/**
 * Extracts the numeric offset from the `data-offset` attribute of the closest
 * `.byte` ancestor of `target`. Returns `null` if none is found or the value
 * is not a valid integer. Returns a plain `number` — callers apply
 * {@link Offset.create} themselves.
 *
 * @param target - The element that received the pointer event.
 */
function offsetFromTarget(target: Element): number | null {
  const el = target.closest<HTMLElement>("[data-offset].byte");
  if (!el) return null;
  const offset = parseInt(el.dataset["offset"] ?? "", 10);
  return isNaN(offset) ? null : offset;
}

/**
 * Creates a zero-height, aria-hidden spacer `<div>` used to simulate
 * the full scroll height in the virtualised list.
 */
function makeSpacer(): HTMLElement {
  const div = document.createElement("div");
  div.style.height = "0px";
  div.setAttribute("aria-hidden", "true");
  return div;
}
