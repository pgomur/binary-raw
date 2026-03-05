/**
 * @file src/ui/components/inspector.ts
 * Inspection side panel: displays numeric interpretations, text, bits, and
 * metadata for the current selection or the byte under the cursor.
 * Also shows the ORIGINAL value when a byte has been modified.
 *
 * Factory pattern: mountInspector(container, options) → handle.
 */

import type { AbsoluteOffset, ByteCount, SelectionState, SectionNode } from "@app-types/index";
import { Offset, Range } from "@app-types/index";
import { shannonEntropy, type EntropyResult } from "@utils/entropy";
import { byteToHex, bytesToHexString, interpretBytes, formatOffset, formatSize, type ByteInterpretations } from "@utils/hex";
import { isPrintable, decode, type Encoding } from "@utils/encoding";
import { getOriginalByte, isByteModified } from "@core/editor";

// Public types

/** Configuration options passed to {@link mountInspector}. */
export interface InspectorOptions {
  /** Full file buffer. */
  readonly buffer: Uint8Array;
  /** Maximum number of bytes to show in the selection hex preview (default: 256). */
  readonly maxPreviewBytes?: number;
}

/** Handle returned by {@link mountInspector} for external updates and cleanup. */
export interface InspectorHandle {
  /**
   * Updates the inspector to show the byte at `offset` (single-byte view).
   * Called by `hex-view.ts` on every cursor move.
   *
   * @param offset - Absolute offset of the cursor.
   */
  setCursor(offset: AbsoluteOffset): void;

  /**
   * Updates the inspector to reflect the active selection.
   * Called from `onSelectionChange` in `editor.ts`.
   *
   * @param sel - Current selection state.
   */
  setSelection(sel: SelectionState): void;

  /**
   * Updates the inspector to show metadata for a sidebar section.
   * Called when the user clicks a section node.
   *
   * @param node - The clicked section node.
   */
  setSection(node: SectionNode): void;

  /**
   * Replaces the internal buffer reference (after an edit or a new file load).
   *
   * @param buffer - The new buffer.
   */
  setBuffer(buffer: Uint8Array): void;

  /** Clears the inspector (no active selection). */
  clear(): void;

  /** Tears down the component and releases DOM resources. */
  destroy(): void;
}

// CSS classes

const CLS = {
  root: "inspector",
  empty: "inspector__empty",
  section: "inspector__section",
  sectionTitle: "inspector__section-title",
  table: "inspector__table",
  row: "inspector__row",
  rowModified: "inspector__row--modified",
  label: "inspector__label",
  value: "inspector__value",
  valueOriginal: "inspector__value--original",
  valueMono: "inspector__value--mono",
  valueOffset: "inspector__value--offset",
  valueInt: "inspector__value--int",
  valueFloat: "inspector__value--float",
  valueMeta: "inspector__value--meta",
  bitGrid: "inspector__bit-grid",
  bit: "inspector__bit",
  bitOn: "inspector__bit--on",
  bitOff: "inspector__bit--off",
  bitLabel: "inspector__bit-label",
  hexPreview: "inspector__hex-preview",
  hexPreviewTrunc: "inspector__hex-preview-trunc",
  encodingSelect: "inspector__encoding-select",
  textPreview: "inspector__text-preview",
  textPreviewInvalid: "inspector__text-preview--invalid",
  metaGrid: "inspector__meta-grid",
  metaKey: "inspector__meta-key",
  metaVal: "inspector__meta-val",
  colorSwatch: "inspector__color-swatch",
  base64Preview: "inspector__base64-preview",
  encodingWrap: "inspector__encoding-wrap",
} as const;

/**
 * Encoding options exposed in the text-preview selector.
 * These are a subset of the `Encoding` type from `encoding.ts`
 * (`'binary'` is intentionally excluded from the UI).
 */
const ENCODING_OPTIONS = [
  { value: "utf-8" as Encoding, label: "UTF-8" },
  { value: "ascii" as Encoding, label: "ASCII" },
  { value: "utf-16le" as Encoding, label: "UTF-16 LE" },
  { value: "utf-16be" as Encoding, label: "UTF-16 BE" },
  { value: "utf-32le" as Encoding, label: "UTF-32 LE" },
  { value: "utf-32be" as Encoding, label: "UTF-32 BE" },
  { value: "latin-1" as Encoding, label: "Latin-1" },
] as const;

// Factory

/**
 * Mounts the inspector panel into `container` and returns an
 * {@link InspectorHandle} for pushing updates and cleanup.
 *
 * The panel renders one of four views depending on context:
 * - **Single byte** – offset, numeric value, bit grid, numeric interpretations,
 *   Unix timestamp guess, and the original value when the byte was edited.
 * - **Range** – start/end, hex preview, text preview (with encoding selector),
 *   numeric interpretations (≤ 8 bytes), entropy, color preview (3–4 bytes),
 *   Base64, and a list of modified bytes within the range.
 * - **Drag in progress** – provisional selection length only.
 * - **Section metadata** – name, type, range, flags, and parser metadata grid.
 *
 * @param container - The host `HTMLElement` into which the panel is rendered.
 * @param options   - Required configuration; see {@link InspectorOptions}.
 * @returns An {@link InspectorHandle} for pushing state updates and destroying the component.
 */
export function mountInspector(container: HTMLElement, options: InspectorOptions): InspectorHandle {
  let buffer = options.buffer;
  let maxPreviewBytes = options.maxPreviewBytes ?? 256;
  let destroyed = false;
  let selectedEncoding: Encoding = "utf-8";

  // Root render
  container.innerHTML = "";
  container.classList.add(CLS.root);

  const emptyEl = document.createElement("div");
  emptyEl.className = CLS.empty;
  emptyEl.textContent = "Click a byte or select a range";
  container.appendChild(emptyEl);

  // Public handle

  return {
    setCursor(offset: AbsoluteOffset): void {
      if (destroyed) return;
      const byte = buffer[offset];
      if (byte === undefined) return;
      renderSingleByte(offset, byte);
    },

    setSelection(sel: SelectionState): void {
      if (destroyed) return;
      if (sel.type === "none") {
        showEmpty();
        return;
      }
      if (sel.type === "selecting") {
        // During drag: show provisional length
        const len = (Offset.diff(sel.anchor, sel.current) + 1) as ByteCount;
        if (len === 1) {
          const byte = buffer[sel.anchor];
          if (byte !== undefined) renderSingleByte(sel.anchor, byte);
        } else {
          renderDragInProgress(len);
        }
        return;
      }

      if (sel.range.length === 1) {
        const byte = buffer[sel.range.start];
        if (byte !== undefined) renderSingleByte(sel.range.start, byte);
      } else {
        renderRange(sel.range.start, sel.range.end, sel.range.length);
      }
    },

    setSection(node: SectionNode): void {
      if (destroyed) return;
      renderSectionMeta(node);
    },

    setBuffer(newBuffer: Uint8Array): void {
      buffer = newBuffer;
    },

    clear(): void {
      if (destroyed) return;
      showEmpty();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      container.innerHTML = "";
    },
  };

  // Primary render functions

  /**
   * Renders the single-byte view: offset, numeric value, bit grid,
   * numeric interpretations, timestamp guess, and original value if modified.
   *
   * @param offset - Absolute offset of the byte.
   * @param byte   - Current value of the byte.
   */
  function renderSingleByte(offset: AbsoluteOffset, byte: number): void {
    clearDOM();

    const modified = isByteModified(offset);
    const original = modified ? getOriginalByte(offset) : undefined;

    // Offset
    appendSection("Offset", (table) => {
      appendRow(table, "Hex", `0x${formatOffset(offset)}`, CLS.valueOffset);
      appendRow(table, "Dec", String(offset), CLS.valueOffset);
    });

    // Current byte value (highlighted if modified)
    appendSection(modified ? "Byte (modified ✎)" : "Byte", (table) => {
      appendRow(table, "Hex", `0x${byteToHex(byte)}`, CLS.valueMono, modified);
      appendRow(table, "Dec", String(byte & 0xff), CLS.valueInt, modified);
      appendRow(table, "Oct", (byte & 0xff).toString(8).padStart(3, "0"), CLS.valueInt, modified);
      appendRow(table, "Binary", (byte & 0xff).toString(2).padStart(8, "0"), CLS.valueMono, modified);
      appendRow(table, "Char", isPrintable(byte) ? String.fromCharCode(byte) : "(non-printable)", CLS.valueInt);

      // Original value shown below the current value
      if (modified && original !== undefined) {
        appendRow(table, "Original", `0x${byteToHex(original)} · ${original & 0xff}`, CLS.valueOriginal, false, true);
      }
    });

    // Visual bit grid
    appendSection("Bits (b7 → b0)", (table) => {
      const grid = buildBitGrid(byte);
      table.parentElement?.replaceChild(grid, table);
    });

    // Numeric interpretations using up to 8 context bytes
    const ctxEnd = Math.min(offset + 8, buffer.length);
    const ctxBytes = buffer.subarray(offset, ctxEnd);
    const interp = interpretBytes(ctxBytes);

    appendSection("Numeric interpretations", (table) => {
      renderInterpretations(table, interp, ctxBytes.length);
    });

    // Timestamp interpretation
    if (ctxBytes.length >= 4) {
      appendSection("Time", (table) => {
        renderTimestamps(table, interp);
      });
    }
  }

  /**
   * Renders the range view: info, hex preview, text preview (with encoding
   * selector), numeric interpretations (≤ 8 bytes), entropy, color preview,
   * Base64, and a list of modified bytes within the range.
   *
   * @param start  - Inclusive start offset of the selection.
   * @param end    - Inclusive end offset of the selection.
   * @param length - Number of selected bytes.
   */
  function renderRange(start: AbsoluteOffset, end: AbsoluteOffset, length: ByteCount): void {
    clearDOM();

    const previewLen = Math.min(length, maxPreviewBytes);
    const sliceEnd = Math.min(start + previewLen, end + 1);
    const bytes = buffer.subarray(start, sliceEnd);

    // Range info
    appendSection("Selection", (table) => {
      appendRow(table, "Start", `0x${formatOffset(start)}`, CLS.valueOffset);
      appendRow(table, "End", `0x${formatOffset(end)}`, CLS.valueOffset);
      appendRow(table, "Length", formatSize(length), CLS.valueInt);
    });

    // Hex preview
    appendSection("Hex preview", (table) => {
      const wrap = table.parentElement;
      if (!wrap) return;

      const hexEl = document.createElement("div");
      hexEl.className = CLS.hexPreview;
      hexEl.textContent = bytesToHexString(bytes);

      if (length > previewLen) {
        const trunc = document.createElement("span");
        trunc.className = CLS.hexPreviewTrunc;
        trunc.textContent = ` … +${length - previewLen} more bytes`;
        hexEl.appendChild(trunc);
      }

      wrap.replaceChild(hexEl, table);
    });

    // Text preview with inline encoding selector
    appendSection("Text", (table) => {
      const sectionEl = table.closest("." + CLS.section);
      const titleEl = sectionEl?.querySelector("." + CLS.sectionTitle) as HTMLElement | null;
      if (!sectionEl || !titleEl) return;

      titleEl.style.display = "flex";
      titleEl.style.justifyContent = "space-between";
      titleEl.style.alignItems = "center";
      titleEl.style.paddingRight = "14px";

      const selectEl = document.createElement("select");
      selectEl.className = CLS.encodingSelect;

      const encodingWrap = document.createElement("div");
      encodingWrap.className = CLS.encodingWrap;

      for (const opt of ENCODING_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === selectedEncoding) o.selected = true;
        selectEl.appendChild(o);
      }

      encodingWrap.appendChild(selectEl);
      titleEl.appendChild(encodingWrap);

      const textEl = document.createElement("div");
      textEl.className = CLS.textPreview;

      function updateText(): void {
        const enc = selectEl.value as Encoding;
        selectedEncoding = enc;
        const decoded = decode(bytes, enc);

        textEl.textContent = decoded ?? "(invalid for this encoding)";
        textEl.classList.toggle(CLS.textPreviewInvalid, decoded === null);
      }

      selectEl.addEventListener("change", updateText);
      // Prevent select clicks from bubbling unexpectedly
      selectEl.addEventListener("mousedown", (e) => e.stopPropagation());

      updateText();

      table.remove();
      sectionEl.appendChild(textEl);
    });

    // Numeric interpretations only for selections of 8 bytes or fewer
    if (length <= 8) {
      const interp = interpretBytes(bytes);
      appendSection("Numeric interpretations", (table) => {
        renderInterpretations(table, interp, bytes.length);
      });
      if (length >= 4) {
        appendSection("Time", (table) => {
          renderTimestamps(table, interp);
        });
      }
    }

    // Entropy
    appendSection("Entropy", (table) => {
      renderEntropy(table, start, end);
    });

    // Color preview (RGB or RGBA)
    if (length === 3 || length === 4) {
      appendSection("Color preview", (table) => {
        renderColorPreview(table, bytes);
      });
    }

    // Base64
    appendSection("Base64", (table) => {
      renderBase64(table, bytes);
    });

    // Modified bytes within the range
    const modList: Array<{ offset: AbsoluteOffset; current: number; original: number }> = [];
    for (let i = start; i <= end && i < buffer.length; i++) {
      const abs = i as AbsoluteOffset;
      if (isByteModified(abs)) {
        const current = buffer[abs];
        const original = getOriginalByte(abs);
        if (current !== undefined && original !== undefined) {
          modList.push({ offset: abs, current, original });
        }
      }
    }

    if (modList.length > 0) {
      appendSection(`Modified bytes (${modList.length})`, (table) => {
        const visible = modList.slice(0, 32);
        for (const { offset: off, current, original } of visible) {
          appendRow(table, `0x${formatOffset(off)}`, `0x${byteToHex(current)} ← was 0x${byteToHex(original)}`, CLS.valueMono, true);
        }
        if (modList.length > 32) {
          appendRow(table, "…", `+${modList.length - 32} more`, CLS.valueMeta);
        }
      });
    }
  }

  /**
   * Renders a minimal view while a drag selection is in progress.
   *
   * @param len - Provisional selection length in bytes.
   */
  function renderDragInProgress(len: ByteCount): void {
    clearDOM();
    appendSection("Selecting…", (table) => {
      appendRow(table, "Length", `${len} byte${len === 1 ? "" : "s"}`);
    });
  }

  /**
   * Renders the section metadata view for a sidebar node click.
   *
   * @param node - The section node whose metadata should be displayed.
   */
  function renderSectionMeta(node: SectionNode): void {
    clearDOM();

    appendSection("Section", (table) => {
      appendRow(table, "Name", node.name, CLS.valueMeta);
      appendRow(table, "Type", node.type, CLS.valueMeta);
      appendRow(table, "Start", `0x${formatOffset(node.range.start)}`, CLS.valueOffset);
      appendRow(table, "End", `0x${formatOffset(node.range.end)}`, CLS.valueOffset);
      appendRow(table, "Size", formatSize(node.range.length), CLS.valueInt);

      if (node.virtualAddr !== undefined) {
        appendRow(table, "VAddr", `0x${node.virtualAddr.toString(16).toUpperCase()}`, CLS.valueOffset);
      }

      const flags = [node.flags.readable ? "R" : "-", node.flags.writable ? "W" : "-", node.flags.executable ? "X" : "-"].join("");
      appendRow(table, "Flags", flags, CLS.valueMeta);
    });

    const metaEntries = Object.entries(node.metadata);
    if (metaEntries.length > 0) {
      appendSection("Parser metadata", (table) => {
        const wrap = table.parentElement;
        if (!wrap) return;

        const grid = document.createElement("div");
        grid.className = CLS.metaGrid;

        for (const [key, val] of metaEntries) {
          const keyEl = document.createElement("span");
          keyEl.className = CLS.metaKey;
          keyEl.textContent = key;

          const valEl = document.createElement("span");
          valEl.className = CLS.metaVal;
          valEl.textContent = String(val);
          valEl.title = String(val);

          grid.appendChild(keyEl);
          grid.appendChild(valEl);
        }

        wrap.replaceChild(grid, table);
      });
    }
  }

  // Internal helpers

  function clearDOM(): void {
    container.innerHTML = "";
  }

  function showEmpty(): void {
    container.innerHTML = "";
    container.appendChild(emptyEl);
  }

  /**
   * Appends a titled section with an empty table to the container, then calls
   * `builder` with that table so the caller can populate or replace it.
   *
   * @param title   - Section heading text.
   * @param builder - Receives the empty `<table>` element to fill in (or replace).
   */
  function appendSection(title: string, builder: (table: HTMLTableElement) => void): void {
    const section = document.createElement("div");
    section.className = CLS.section;

    const titleEl = document.createElement("div");
    titleEl.className = CLS.sectionTitle;
    titleEl.textContent = title;
    section.appendChild(titleEl);

    const table = document.createElement("table");
    table.className = CLS.table;
    section.appendChild(table);

    container.appendChild(section);
    builder(table);
  }

  /**
   * Appends a key/value row to a table.
   *
   * @param table    - Target table element.
   * @param label    - Row label (left cell).
   * @param value    - Row value (right cell).
   * @param valueCls - Specific CSS class for the value cell (default: `null`).
   * @param modified - Highlight the row as a modified byte (default: `false`).
   * @param original - Style the value as the pre-edit original (default: `false`).
   */
  function appendRow(table: HTMLTableElement, label: string, value: string, valueCls: string | null = null, modified = false, original = false): void {
    const tr = document.createElement("tr");
    tr.className = CLS.row;
    if (modified) tr.classList.add(CLS.rowModified);

    const tdLabel = document.createElement("td");
    tdLabel.className = CLS.label;
    tdLabel.textContent = label;

    const tdValue = document.createElement("td");
    tdValue.className = CLS.value;
    tdValue.textContent = value;
    tdValue.title = value;
    if (valueCls) tdValue.classList.add(valueCls);
    if (original) tdValue.classList.add(CLS.valueOriginal);

    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    table.appendChild(tr);
  }

  /**
   * Builds the 8-bit visual grid for `byte`.
   * Bits are ordered b7 (MSB) → b0 (LSB), left to right.
   *
   * @param byte - The byte value to visualise.
   * @returns A `<div>` grid with one cell per bit.
   */
  function buildBitGrid(byte: number): HTMLElement {
    const grid = document.createElement("div");
    grid.className = CLS.bitGrid;

    for (let bit = 7; bit >= 0; bit--) {
      const isOn = ((byte >> bit) & 1) === 1;

      const cell = document.createElement("div");
      cell.className = `${CLS.bit} ${isOn ? CLS.bitOn : CLS.bitOff}`;
      cell.textContent = isOn ? "1" : "0";
      cell.title = `bit ${bit} (2^${bit} = ${(1 << bit) >>> 0})`;
      grid.appendChild(cell);

      const lbl = document.createElement("div");
      lbl.className = CLS.bitLabel;
      lbl.textContent = String(bit);
      grid.appendChild(lbl);
    }

    return grid;
  }

  /**
   * Populates `table` with the numeric interpretations available for
   * `availableBytes`. Only rows whose type requires enough bytes are shown.
   *
   * @param table          - Target table element.
   * @param interp         - Pre-computed interpretations from {@link interpretBytes}.
   * @param availableBytes - Number of bytes available at the current offset.
   */
  function renderInterpretations(table: HTMLTableElement, interp: ByteInterpretations, availableBytes: number): void {
    if (availableBytes >= 1) {
      if (interp.uint8 !== null) appendRow(table, "uint8", String(interp.uint8), CLS.valueInt);
      if (interp.int8 !== null) appendRow(table, "int8", String(interp.int8), CLS.valueInt);
    }
    if (availableBytes >= 2) {
      if (interp.uint16le !== null) appendRow(table, "uint16 LE", String(interp.uint16le), CLS.valueInt);
      if (interp.uint16be !== null) appendRow(table, "uint16 BE", String(interp.uint16be), CLS.valueInt);
      if (interp.int16le !== null) appendRow(table, "int16 LE", String(interp.int16le), CLS.valueInt);
      if (interp.int16be !== null) appendRow(table, "int16 BE", String(interp.int16be), CLS.valueInt);
    }
    if (availableBytes >= 4) {
      if (interp.uint32le !== null) appendRow(table, "uint32 LE", String(interp.uint32le), CLS.valueInt);
      if (interp.uint32be !== null) appendRow(table, "uint32 BE", String(interp.uint32be), CLS.valueInt);
      if (interp.int32le !== null) appendRow(table, "int32 LE", String(interp.int32le), CLS.valueInt);
      if (interp.int32be !== null) appendRow(table, "int32 BE", String(interp.int32be), CLS.valueInt);
      if (interp.float32le !== null) appendRow(table, "float32 LE", interp.float32le.toPrecision(7), CLS.valueFloat);
      if (interp.float32be !== null) appendRow(table, "float32 BE", interp.float32be.toPrecision(7), CLS.valueFloat);
    }
    if (availableBytes >= 8) {
      if (interp.float64le !== null) appendRow(table, "float64 LE", interp.float64le.toPrecision(15), CLS.valueFloat);
      if (interp.float64be !== null) appendRow(table, "float64 BE", interp.float64be.toPrecision(15), CLS.valueFloat);
      if (interp.uint64le !== null) appendRow(table, "uint64 LE", String(interp.uint64le), CLS.valueInt);
      if (interp.uint64be !== null) appendRow(table, "uint64 BE", String(interp.uint64be), CLS.valueInt);
      if (interp.int64le !== null) appendRow(table, "int64 LE", String(interp.int64le), CLS.valueInt);
      if (interp.int64be !== null) appendRow(table, "int64 BE", String(interp.int64be), CLS.valueInt);
    }
  }

  /**
   * Appends plausible Unix timestamp rows to `table` based on `interp`.
   * Only timestamps between 1980 and 2100 are considered valid.
   *
   * @param table  - Target table element.
   * @param interp - Pre-computed byte interpretations.
   */
  function renderTimestamps(table: HTMLTableElement, interp: ByteInterpretations): void {
    const format = (d: Date) => d.toISOString().replace("T", " ").replace(/\..+/, "");
    if (interp.uint32le !== null) {
      const d = new Date(interp.uint32le * 1000);
      if (d.getFullYear() > 1980 && d.getFullYear() < 2100) appendRow(table, "Unix 32 LE", format(d), CLS.valueOffset);
    }
    if (interp.uint32be !== null) {
      const d = new Date(interp.uint32be * 1000);
      if (d.getFullYear() > 1980 && d.getFullYear() < 2100) appendRow(table, "Unix 32 BE", format(d), CLS.valueOffset);
    }
    if (interp.uint64le !== null) {
      // Attempt millisecond interpretation for very large values, otherwise seconds
      const ms = Number(interp.uint64le);
      const d = new Date(ms);
      if (d.getFullYear() > 1980 && d.getFullYear() < 2100) appendRow(table, "Unix 64 LE", format(d), CLS.valueOffset);
    }
  }

  /**
   * Replaces `table` with an RGB/RGBA colour swatch derived from `bytes`.
   *
   * @param table - Target table element (will be replaced).
   * @param bytes - 3-byte (RGB) or 4-byte (RGBA) slice.
   */
  function renderColorPreview(table: HTMLTableElement, bytes: Uint8Array): void {
    const wrap = table.parentElement;
    if (!wrap) return;
    const swatch = document.createElement("div");
    swatch.className = CLS.colorSwatch;
    const r = bytes[0] ?? 0,
      g = bytes[1] ?? 0,
      b = bytes[2] ?? 0;
    const a = bytes.length === 4 ? ((bytes[3] ?? 255) / 255).toFixed(2) : "1.0";
    swatch.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
    wrap.replaceChild(swatch, table);
  }

  /**
   * Appends Shannon entropy rows (value and classification) to `table`.
   *
   * @param table - Target table element.
   * @param start - Inclusive start offset of the range.
   * @param end   - Inclusive end offset of the range.
   */
  function renderEntropy(table: HTMLTableElement, start: AbsoluteOffset, end: AbsoluteOffset): void {
    const res = shannonEntropy(buffer, Range.create(start, end));
    appendRow(table, "Shannon", `${res.entropy.toFixed(3)} bits`, CLS.valueFloat);
    appendRow(table, "Class", res.classification, CLS.valueMeta);
  }

  /**
   * Replaces `table` with a Base64-encoded representation of `bytes`.
   *
   * @param table - Target table element (will be replaced).
   * @param bytes - The bytes to encode.
   */
  function renderBase64(table: HTMLTableElement, bytes: Uint8Array): void {
    const wrap = table.parentElement;
    if (!wrap) return;
    const b64 = btoa(
      Array.from(bytes)
        .map((b) => String.fromCharCode(b))
        .join(""),
    );
    const div = document.createElement("div");
    div.className = CLS.base64Preview;
    div.textContent = b64;
    wrap.replaceChild(div, table);
  }
}
