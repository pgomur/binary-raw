/**
 * @file Bytes to text conversion for different encodings.
 * Heuristic encoding detection. No imports.
 */

// Public types

/**
 * Encodings supported by this module.
 * "binary" is the fallback when no encoding fits:
 * non-printable bytes are replaced with '.'.
 */
export type Encoding =
  | "ascii"
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "utf-32le"
  | "utf-32be"
  | "latin-1"
  | "binary";

/** Result of detecting encoding for a byte block. */
export interface DetectedEncoding {
  readonly encoding: Encoding;
  /** True if detection found an explicit BOM */
  readonly hasBom: boolean;
  /** Offset where actual content starts (after BOM, if any) */
  readonly contentStart: number;
}

// Constants

/** Replacement character for non-printable bytes in ASCII column.
 * A neutral character easy to distinguish in the ASCII column.
 */
const NON_PRINTABLE_CHAR = ".";

/** Recognized BOMs, ordered from longest to shortest to avoid false positives.
 * Ordered from longest to shortest to avoid false positives — a shorter BOM
 * could appear in the middle of valid UTF-8 data.
 */
const BOMS = [
  { encoding: "utf-8"    as Encoding, bytes: [0xef, 0xbb, 0xbf] },
  { encoding: "utf-16be" as Encoding, bytes: [0xfe, 0xff]       },
  { encoding: "utf-16le" as Encoding, bytes: [0xff, 0xfe]       },
] as const;

// Printable ASCII

/**
 * Returns true if byte corresponds to a printable ASCII character.
 * Range: 0x20 (space) – 0x7E (~).
 * Bytes outside this range are displayed as '.' in the ASCII column.
 */
export function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

/**
 * Converts a byte to its printable ASCII character.
 * If not printable, returns NON_PRINTABLE_CHAR ('.').
 *
 * @example byteToAsciiChar(0x41) → "A"
 * @example byteToAsciiChar(0x00) → "."
 */
export function byteToAsciiChar(byte: number): string {
  return isPrintable(byte) ? String.fromCharCode(byte) : NON_PRINTABLE_CHAR;
}

/**
 * Converts a Uint8Array to ASCII string replacing non-printable
 * bytes with '.'. Optionally truncates to `maxLen` characters
 * adding '…' at the end if there is more content.
 *
 * Used by hex-view.ts to render the ASCII column of each row.
 *
 * @param bytes  - Bytes to convert
 * @param maxLen - Maximum length of resulting string (not counting '…')
 *
 * @example bytesToAscii(new Uint8Array([0x25,0x50,0x44,0x46])) → "%PDF"
 * @example bytesToAscii(new Uint8Array([0x41,0x00,0x42]), 2)   → "A.…"
 */
export function bytesToAscii(bytes: Uint8Array, maxLen = Infinity): string {
  const len = Math.min(bytes.length, maxLen);
  let result = "";

  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    // Explicit guard: if undefined (shouldn't happen), use '.'
    result += b !== undefined ? byteToAsciiChar(b) : NON_PRINTABLE_CHAR;
  }

  if (bytes.length > maxLen) result += "…";
  return result;
}

// Decoders

/**
 * Decodes a Uint8Array as strict UTF-8.
 * Returns null if bytes do not form a valid UTF-8 sequence.
 *
 * @example decodeUtf8(new Uint8Array([0x48,0x65,0x6c,0x6c,0x6f])) → "Hello"
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodes a Uint8Array as strict UTF-16 Little-Endian.
 * Returns null if sequence is not valid UTF-16 LE.
 * Bytes must come in pairs — odd length will return null.
 */
export function decodeUtf16LE(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodes a Uint8Array as strict UTF-16 Big-Endian.
 * Returns null if sequence is not valid UTF-16 BE.
 */
export function decodeUtf16BE(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodes a Uint8Array as Latin-1 (ISO-8859-1).
 * Never fails: each byte 0–255 has a valid Latin-1 codepoint.
 */
export function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("iso-8859-1").decode(bytes);
}

// Encoding detection

/**
 * Detects the most likely encoding of a byte block.
 * Priority: explicit BOM → valid UTF-8 → pure ASCII → Latin-1 → binary.
 *
 * Not infallible — it's a quick heuristic for the inspector.
 * For production use a dedicated library (chardet, jschardet).
 *
 * @param bytes - Byte block to analyze (doesn't need to be the whole file)
 * @returns DetectedEncoding with detected encoding, whether there's a BOM, and where content starts
 */
export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (bytes.length === 0) {
    return { encoding: "binary", hasBom: false, contentStart: 0 };
  }

  // 1. Search for BOM
  for (const bom of BOMS) {
    if (hasBomAt(bytes, bom.bytes)) {
      return {
        encoding:     bom.encoding,
        hasBom:       true,
        contentStart: bom.bytes.length,
      };
    }
  }

  // 2. Try valid UTF-8
  const utf8 = decodeUtf8(bytes);
  if (utf8 !== null) {
    // Check if pure ASCII (subset of UTF-8, all bytes < 0x80)
    const allAscii = isAllAscii(bytes);
    return {
      encoding:     allAscii ? "ascii" : "utf-8",
      hasBom:       false,
      contentStart: 0,
    };
  }

  // 3. High bytes present but not UTF-8 → Latin-1
  const hasHighBytes = hasAnyByteAbove(bytes, 0x7e);
  return {
    encoding:     hasHighBytes ? "latin-1" : "binary",
    hasBom:       false,
    contentStart: 0,
  };
}

/**
 * Decodes bytes with the given encoding.
 * For "binary" and "ascii" replaces non-printable bytes with '.'.
 * Returns null if encoding fails (only can fail utf-8, utf-16le, utf-16be).
 *
 * @example decode(bytes, "utf-8")   → "Hello" | null
 * @example decode(bytes, "binary")  → always string, never null
 */
export function decode(bytes: Uint8Array, encoding: Encoding): string | null {
  switch (encoding) {
    case "ascii":
    case "binary":   return bytesToAscii(bytes);
    case "utf-8":    return decodeUtf8(bytes);
    case "utf-16le": return decodeUtf16LE(bytes);
    case "utf-16be": return decodeUtf16BE(bytes);
    case "utf-32le":
      try { return new TextDecoder("utf-32le", { fatal: true }).decode(bytes); } catch { return null; }
    case "utf-32be":
      try { return new TextDecoder("utf-32be", { fatal: true }).decode(bytes); } catch { return null; }
    case "latin-1":  return decodeLatin1(bytes);
  }
}

/**
 * Decodes bytes with the given encoding.
 * Falls back to "binary" if encoding fails.
 * Useful for inspector when you always want to show something.
 */
export function decodeSafe(bytes: Uint8Array, encoding: Encoding): string {
  return decode(bytes, encoding) ?? bytesToAscii(bytes);
}

// Byte analysis helpers

/**
 * Returns true if all bytes in the array are pure ASCII (< 0x80).
 * Undefined bytes are ignored.
 */
export function isAllAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // Skip if undefined; if >= 0x80, not ASCII
    if (b === undefined) continue;
    if (b >= 0x80) return false;
  }
  return true;
}

/**
 * Returns true if any byte in the array is greater than `threshold`.
 * Undefined bytes are ignored.
 */
export function hasAnyByteAbove(bytes: Uint8Array, threshold: number): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // Skip if undefined; if exceeds threshold, return true
    if (b === undefined) continue;
    if (b > threshold) return true;
  }
  return false;
}

/**
 * Returns true if byte array starts with the given BOM sequence.
 * Safe with noUncheckedIndexedAccess — compares byte by byte with guard.
 */
export function hasBomAt(bytes: Uint8Array, bom: readonly number[]): boolean {
  if (bytes.length < bom.length) return false;
  for (let i = 0; i < bom.length; i++) {
    const b = bytes[i];
    // Explicit guard: if undefined or doesn't match, no BOM
    if (b === undefined || b !== bom[i]) return false;
  }
  return true;
}
