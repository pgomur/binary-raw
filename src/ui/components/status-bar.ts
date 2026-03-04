/**
 * @file src/ui/components/status-bar.ts
 * Status bar: cursor offset, byte value, file size, format, selected bytes,
 * and percentage position. Read-only — reflects state, emits no commands.
 */

import type { SelectionState, AbsoluteOffset, ByteCount, FileFormat } from "@app-types/index";
import { Offset } from "@app-types/index";
import { formatOffset, formatOffsetHex, formatByteStatus, formatSize, bytesToHexString } from "@utils/hex";

// Public types

/** Configuration options passed to {@link mountStatusBar}. */
export interface StatusBarOptions {
  /** Total file size in bytes. */
  readonly fileSize: ByteCount;
  /** Detected file format. */
  readonly format: FileFormat;
  /** File name. */
  readonly filename?: string;
}

/** Handle returned by {@link mountStatusBar} for external updates and cleanup. */
export interface StatusBarHandle {
  /**
   * Updates the cursor offset and the byte value at that position.
   * Called by `hex-view.ts` on every mouse/keyboard move.
   *
   * @param offset    - The absolute offset of the cursor.
   * @param byteValue - The raw byte value at that offset.
   */
  setCursor(offset: AbsoluteOffset, byteValue: number): void;

  /**
   * Updates the active selection display.
   * Called from `onSelectionChange` in `editor.ts`.
   *
   * @param sel    - Current selection state.
   * @param buffer - The full file buffer (used for the hex preview).
   */
  setSelection(sel: SelectionState, buffer: Uint8Array): void;

  /**
   * Clears the cursor display (mouse has left the hex view).
   */
  clearCursor(): void;

  /**
   * Tears down the component and releases resources.
   */
  destroy(): void;
}

// CSS classes

const CLS = {
  root: "status-bar",
  segment: "status-bar__segment",
  segmentLabel: "status-bar__label",
  segmentValue: "status-bar__value",
  separator: "status-bar__separator",
  formatBadge: "status-bar__format-badge",
  progressTrack: "status-bar__progress-track",
  progressFill: "status-bar__progress-fill",
  dimmed: "status-bar__value--dimmed",
} as const;

// Factory

/**
 * Mounts the status bar into `container` and returns a {@link StatusBarHandle}
 * for external updates and cleanup.
 *
 * Segments rendered (left to right):
 * 1. **Size** – static total file size.
 * 2. **Offset** – current cursor position in decimal and hex.
 * 3. **Byte** – value at the cursor as `hex (dec) 'char'`.
 * 4. **Binary** – 8-bit binary representation of the current byte.
 * 5. **Selection** – byte count and hex preview of the active selection.
 * 6. **Pos** – percentage progress bar.
 *
 * @param container - The host `HTMLElement` into which the bar is rendered.
 * @param options   - Required configuration; see {@link StatusBarOptions}.
 * @returns A {@link StatusBarHandle} for pushing state updates and destroying the component.
 */
export function mountStatusBar(container: HTMLElement, options: StatusBarOptions): StatusBarHandle {
  const { fileSize, format, filename } = options;

  let destroyed = false;

  // Render
  container.innerHTML = "";
  container.classList.add(CLS.root);

  // 1. File size (static info first)
  const { wrap: sizeWrap, value: sizeValue } = makeSegment("Size");
  sizeValue.textContent = formatSize(fileSize);
  sizeValue.title = `${fileSize} bytes`;
  container.appendChild(sizeWrap);
  container.appendChild(makeSeparator());

  // 2. Offset (cursor position)
  const { wrap: cursorWrap, value: cursorValue } = makeSegment("Offset");
  container.appendChild(cursorWrap);
  container.appendChild(makeSeparator());

  // 3. Byte (Hex / Dec / Char)
  const { wrap: byteWrap, value: byteValue } = makeSegment("Byte");
  container.appendChild(byteWrap);
  container.appendChild(makeSeparator());

  // 4. Binary (bit-level view)
  const { wrap: binWrap, value: binValue } = makeSegment("Binary");
  container.appendChild(binWrap);
  container.appendChild(makeSeparator());

  // 5. Selection
  const { wrap: selWrap, value: selValue } = makeSegment("Selection");
  container.appendChild(selWrap);
  container.appendChild(makeSeparator());

  // 6. Position (progress bar)
  const { wrap: progressWrap, value: progressValue } = makeSegment("Pos");
  const progressTrack = document.createElement("div");
  progressTrack.className = CLS.progressTrack;
  progressTrack.setAttribute("role", "progressbar");
  const progressFill = document.createElement("div");
  progressFill.className = CLS.progressFill;
  progressFill.style.width = "0%";
  progressTrack.appendChild(progressFill);
  progressWrap.appendChild(progressTrack);
  container.appendChild(progressWrap);

  // Initial state
  resetCursorDisplay();
  resetByteDisplay();
  resetBinaryDisplay();
  resetSelectionDisplay();

  // Display helpers

  function resetCursorDisplay(): void {
    cursorValue.textContent = "—";
    cursorValue.classList.add(CLS.dimmed);
    cursorValue.title = "";
    updateProgress(null);
  }

  function resetByteDisplay(): void {
    byteValue.textContent = "—";
    byteValue.classList.add(CLS.dimmed);
    byteValue.title = "";
  }

  function resetBinaryDisplay(): void {
    binValue.textContent = "—";
    binValue.classList.add(CLS.dimmed);
    binValue.title = "";
  }

  function resetSelectionDisplay(): void {
    selValue.textContent = "None";
    selValue.classList.add(CLS.dimmed);
    selValue.title = "";
  }

  function updateProgress(offset: AbsoluteOffset | null): void {
    const pct = offset !== null && fileSize > 0 ? Math.round((offset / fileSize) * 100) : 0;
    progressValue.textContent = `${pct}%`;
    progressFill.style.width = `${pct}%`;
    progressTrack.setAttribute("aria-valuenow", String(pct));
  }

  // Public API

  return {
    setCursor(offset: AbsoluteOffset, value: number): void {
      if (destroyed) return;

      // Offset
      cursorValue.classList.remove(CLS.dimmed);
      cursorValue.textContent = formatOffset(offset);
      cursorValue.title = `${formatOffsetHex(offset)} (dec: ${offset})`;
      updateProgress(offset);

      // Byte: Hex | Dec | Char
      byteValue.classList.remove(CLS.dimmed);
      const hex = `0x${(value & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
      const dec = (value & 0xff).toString();
      const char = value >= 32 && value <= 126 ? `'${String.fromCharCode(value)}'` : "";
      byteValue.textContent = char ? `${hex} (${dec}) ${char}` : `${hex} (${dec})`;

      // Binary: 8 visual bits
      binValue.classList.remove(CLS.dimmed);
      binValue.textContent = (value & 0xff).toString(2).padStart(8, "0");
    },

    setSelection(sel: SelectionState, buffer: Uint8Array): void {
      if (destroyed) return;

      if (sel.type === "none") {
        resetSelectionDisplay();
        return;
      }

      // During drag ('selecting'): provisional length, no preview
      if (sel.type === "selecting") {
        const len = (Offset.diff(sel.anchor, sel.current) + 1) as ByteCount;
        selValue.classList.remove(CLS.dimmed);
        selValue.textContent = `${len} byte${len === 1 ? "" : "s"}`;
        selValue.title = "";
        return;
      }

      // 'selected': final length + hex preview of the first bytes
      const { start, end, length } = sel.range;

      // Preview: up to 8 bytes as a hex string
      const previewLen = Math.min(8, length);
      const sliceEnd = Math.min(start + previewLen, end + 1);
      const previewBytes = buffer.subarray(start, sliceEnd);
      const hex = bytesToHexString(previewBytes);
      const preview = length > previewLen ? `${hex} … (${length} bytes total)` : hex;

      selValue.classList.remove(CLS.dimmed);
      selValue.textContent = `${length} byte${length === 1 ? "" : "s"}`;
      selValue.title = preview;
    },

    clearCursor(): void {
      if (destroyed) return;
      resetCursorDisplay();
      resetByteDisplay();
      resetBinaryDisplay();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      container.innerHTML = "";
    },
  };
}

// Internal helpers

/**
 * Creates a labelled status-bar segment containing a `<span>` for the value.
 * Optionally appends the segment to `appendTo`.
 *
 * @param label    - The label text displayed to the left of the value.
 * @param appendTo - Optional parent element to append the segment to.
 * @returns An object with the outer `wrap` div and the inner `value` span.
 */
function makeSegment(
  label: string,
  appendTo?: HTMLElement,
): {
  wrap: HTMLDivElement;
  value: HTMLSpanElement;
} {
  const wrap = document.createElement("div");
  wrap.className = CLS.segment;

  const labelEl = document.createElement("span");
  labelEl.className = CLS.segmentLabel;
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const value = document.createElement("span");
  value.className = CLS.segmentValue;
  wrap.appendChild(value);

  appendTo?.appendChild(wrap);

  return { wrap, value };
}

/**
 * Creates a visual separator `<div>` (aria-hidden).
 */
function makeSeparator(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = CLS.separator;
  el.setAttribute("aria-hidden", "true");
  return el;
}
