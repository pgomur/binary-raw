/**
 * @file Hex conversion and formatting utilities.
 */

// Offset formatting

/**
 * Formatea un offset numérico como string hex de 8 dígitos.
 * @example formatOffset(16) → "00000010"
 */
export function formatOffset(offset: number): string {
  return offset.toString(16).padStart(8, "0").toUpperCase();
}

/**
 * Formatea un offset con prefijo 0x.
 * @example formatOffsetHex(16) → "0x000010"
 */
export function formatOffsetHex(offset: number): string {
  return "0x" + offset.toString(16).padStart(6, "0").toUpperCase();
}

// Byte → string

/**
 * Converts a byte (0–255) to 2-digit uppercase hex string.
 * Applies 0xFF mask for safety if input is out of range.
 * @example byteToHex(255) → "FF"
 * @example byteToHex(0)   → "00"
 * @example byteToHex(256) → "00" (mask applied)
 * @example byteToHex(-1)  → "FF" (mask applied)
 */
export function byteToHex(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, "0").toUpperCase();
}

/**
 * Converts a byte to its decimal representation.
 * Applies 0xFF mask for safety.
 * @example byteToDec(255) → "255"
 * @example byteToDec(256) → "0" (mask applied)
 */
export function byteToDec(byte: number): string {
  return (byte & 0xff).toString(10);
}

/**
 * Formats a byte for the statusbar: "0xFF · 255"
 */
export function formatByteStatus(byte: number): string {
  return `0x${byteToHex(byte)} · ${byteToDec(byte)}`;
}

// String hex → number

/**
 * Parses a hex string (with or without 0x prefix) to number.
 * Returns null if string is not valid hex.
 * @example parseHex("FF")     → 255
 * @example parseHex("0x1F4") → 500
 * @example parseHex("ZZ")    → null
 * @example parseHex("")      → null
 */
export function parseHex(hex: string): number | null {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean === "" || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const value = parseInt(clean, 16);
  return isNaN(value) ? null : value;
}

// Buffer → hex lines

/**
 * Describes a hex-view row ready for rendering.
 */
export interface HexRow {
  /** Absolute offset of the first byte in the row */
  offset: number;
  /** Array of up to `cols` bytes */
  bytes: Uint8Array;
}

/**
 * Splits a buffer into rows of `cols` bytes each.
 * Only generates rows within range [startRow, endRow).
 * Used by virtualized scroll in hex-view.ts.
 *
 * @param buffer   - Complete file buffer
 * @param cols     - Bytes per row (8, 16, or 32)
 * @param startRow - Index of first row to generate
 * @param endRow   - Index of last row (exclusive)
 */
export function sliceRows(
  buffer: Uint8Array,
  cols: number,
  startRow: number,
  endRow: number
): HexRow[] {
  const rows: HexRow[] = [];
  const totalRows = Math.ceil(buffer.length / cols);
  const clampedEnd = Math.min(endRow, totalRows);

  for (let i = startRow; i < clampedEnd; i++) {
    const offset = i * cols;
    rows.push({
      offset,
      bytes: buffer.subarray(offset, offset + cols),
    });
  }

  return rows;
}

/**
 * Total number of rows in a buffer for a given column width.
 */
export function totalRows(bufferLength: number, cols: number): number {
  return Math.ceil(bufferLength / cols);
}

// Hex string search

/**
 * Converts a byte array to space-separated hex string.
 * @example bytesToHexString([0x25, 0x50, 0x44]) → "25 50 44"
 */
export function bytesToHexString(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map(byteToHex)
    .join(" ");
}

/**
 * Converts a space-separated hex string to Uint8Array.
 * Ignores extra spaces. Returns null if string contains
 * non-hexadecimal characters or is empty.
 * @example hexStringToBytes("25 50 44") → Uint8Array([37, 80, 68])
 * @example hexStringToBytes("")         → null
 */
export function hexStringToBytes(hexStr: string): Uint8Array | null {
  const trimmed = hexStr.trim();
  if (trimmed === "") return null;

  const tokens = trimmed.split(/\s+/);
  const result: number[] = [];

  for (const token of tokens) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(token)) return null;
    result.push(parseInt(token, 16));
  }

  return new Uint8Array(result);
}

// Numeric interpretations

/**
 * All numeric interpretations of a byte range.
 * Returns null if range has insufficient bytes for a type.
 */
export interface ByteInterpretations {
  uint8:    number | null;
  int8:     number | null;
  uint16le: number | null;
  uint16be: number | null;
  int16le:  number | null;
  int16be:  number | null;
  uint32le: number | null;
  uint32be: number | null;
  int32le:  number | null;
  int32be:  number | null;
  float32le: number | null;
  float32be: number | null;
  float64le: number | null;
  float64be: number | null;
  uint64le:  bigint | null;
  uint64be:  bigint | null;
  int64le:   bigint | null;
  int64be:   bigint | null;
}

/**
 * Calculates all numeric interpretations of the first
 * bytes of a Uint8Array. Uses DataView internally to ensure
 * correct byte order.
 */
export function interpretBytes(bytes: Uint8Array): ByteInterpretations {
  const len = bytes.length;
  const buf = bytes.slice().buffer;
  const view = new DataView(buf);

  return {
    uint8:     len >= 1 ? view.getUint8(0)               : null,
    int8:      len >= 1 ? view.getInt8(0)                : null,
    uint16le:  len >= 2 ? view.getUint16(0, true)        : null,
    uint16be:  len >= 2 ? view.getUint16(0, false)       : null,
    int16le:   len >= 2 ? view.getInt16(0, true)         : null,
    int16be:   len >= 2 ? view.getInt16(0, false)        : null,
    uint32le:  len >= 4 ? view.getUint32(0, true)        : null,
    uint32be:  len >= 4 ? view.getUint32(0, false)       : null,
    int32le:   len >= 4 ? view.getInt32(0, true)         : null,
    int32be:   len >= 4 ? view.getInt32(0, false)        : null,
    float32le: len >= 4 ? view.getFloat32(0, true)       : null,
    float32be: len >= 4 ? view.getFloat32(0, false)      : null,
    float64le: len >= 8 ? view.getFloat64(0, true)       : null,
    float64be: len >= 8 ? view.getFloat64(0, false)      : null,
    uint64le:  len >= 8 ? view.getBigUint64(0, true)     : null,
    uint64be:  len >= 8 ? view.getBigUint64(0, false)    : null,
    int64le:   len >= 8 ? view.getBigInt64(0, true)      : null,
    int64be:   len >= 8 ? view.getBigInt64(0, false)     : null,
  };
}

// Size formatting

/**
 * Formats a byte size to human-readable string.
 * @example formatSize(42318)     → "42.3 KB"
 * @example formatSize(1048576)   → "1.0 MB"
 * @example formatSize(500)       → "500 B"
 * @example formatSize(0)        → "0 B"
 */
export function formatSize(bytes: number): string {
  if (bytes < 0) throw new RangeError("bytes cannot be negative");
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}