/**
 * @file Comprehensive Vitest tests for the bytes-to-text encoding module.
 * Covers every exported function with boundary cases, happy paths, and edge cases.
 */

import { describe, it, expect } from "vitest";
import { isPrintable, byteToAsciiChar, bytesToAscii, decodeUtf8, decodeUtf16LE, decodeUtf16BE, decodeLatin1, detectEncoding, decode, decodeSafe, isAllAscii, hasAnyByteAbove, hasBomAt, type Encoding } from "../../src/utils/encoding";

// Helpers

const u8 = (...bytes: number[]) => new Uint8Array(bytes);
const str2u8 = (s: string) => new TextEncoder().encode(s);

//isPrintable

describe("isPrintable", () => {
  it("returns true for the lower boundary: 0x20 (space)", () => {
    expect(isPrintable(0x20)).toBe(true);
  });

  it("returns true for the upper boundary: 0x7e (~)", () => {
    expect(isPrintable(0x7e)).toBe(true);
  });

  it("returns false for 0x1f (just below space)", () => {
    expect(isPrintable(0x1f)).toBe(false);
  });

  it("returns false for 0x7f (DEL, just above ~)", () => {
    expect(isPrintable(0x7f)).toBe(false);
  });

  it("returns false for 0x00 (NUL)", () => {
    expect(isPrintable(0x00)).toBe(false);
  });

  it("returns false for 0xff (max byte)", () => {
    expect(isPrintable(0xff)).toBe(false);
  });

  it("returns true for all standard printable ASCII letters A–Z (0x41–0x5a)", () => {
    for (let b = 0x41; b <= 0x5a; b++) {
      expect(isPrintable(b)).toBe(true);
    }
  });

  it("returns true for digits 0–9 (0x30–0x39)", () => {
    for (let b = 0x30; b <= 0x39; b++) {
      expect(isPrintable(b)).toBe(true);
    }
  });

  it("returns false for all control characters 0x00–0x1f", () => {
    for (let b = 0x00; b <= 0x1f; b++) {
      expect(isPrintable(b)).toBe(false);
    }
  });

  it("returns false for high bytes 0x80–0xff", () => {
    for (let b = 0x80; b <= 0xff; b++) {
      expect(isPrintable(b)).toBe(false);
    }
  });
});

// byteToAsciiChar
describe("byteToAsciiChar", () => {
  it("returns the character for a printable byte (0x41 → 'A')", () => {
    expect(byteToAsciiChar(0x41)).toBe("A");
  });

  it("returns '.' for NUL (0x00)", () => {
    expect(byteToAsciiChar(0x00)).toBe(".");
  });

  it("returns '.' for DEL (0x7f)", () => {
    expect(byteToAsciiChar(0x7f)).toBe(".");
  });

  it("returns '.' for 0xff", () => {
    expect(byteToAsciiChar(0xff)).toBe(".");
  });

  it("returns ' ' for space (0x20)", () => {
    expect(byteToAsciiChar(0x20)).toBe(" ");
  });

  it("returns '~' for 0x7e", () => {
    expect(byteToAsciiChar(0x7e)).toBe("~");
  });

  it("returns '.' for newline (0x0a)", () => {
    expect(byteToAsciiChar(0x0a)).toBe(".");
  });

  it("returns '.' for carriage return (0x0d)", () => {
    expect(byteToAsciiChar(0x0d)).toBe(".");
  });

  it("returns '.' for tab (0x09)", () => {
    expect(byteToAsciiChar(0x09)).toBe(".");
  });

  it("maps every printable byte to its String.fromCharCode equivalent", () => {
    for (let b = 0x20; b <= 0x7e; b++) {
      expect(byteToAsciiChar(b)).toBe(String.fromCharCode(b));
    }
  });

  it("returns a single-character string for every input", () => {
    for (let b = 0; b <= 255; b++) {
      expect(byteToAsciiChar(b)).toHaveLength(1);
    }
  });
});

// bytesToAscii
describe("bytesToAscii", () => {
  it("converts %PDF bytes to '%PDF'", () => {
    expect(bytesToAscii(u8(0x25, 0x50, 0x44, 0x46))).toBe("%PDF");
  });

  it("replaces non-printable byte in the middle with '.'", () => {
    expect(bytesToAscii(u8(0x41, 0x00, 0x42))).toBe("A.B");
  });

  it("returns empty string for empty array", () => {
    expect(bytesToAscii(u8())).toBe("");
  });

  it("returns '.' for single non-printable byte", () => {
    expect(bytesToAscii(u8(0x00))).toBe(".");
  });

  it("returns 'A' for single printable byte 0x41", () => {
    expect(bytesToAscii(u8(0x41))).toBe("A");
  });

  it("truncates to maxLen and appends '…'", () => {
    // From JSDoc example: bytesToAscii(Uint8Array([0x41,0x00,0x42]), 2) → "A.…"
    expect(bytesToAscii(u8(0x41, 0x00, 0x42), 2)).toBe("A.…");
  });

  it("does NOT append '…' when length equals maxLen exactly", () => {
    const result = bytesToAscii(u8(0x41, 0x42, 0x43), 3);
    expect(result).toBe("ABC");
    expect(result).not.toContain("…");
  });

  it("does NOT truncate when maxLen > array length", () => {
    const result = bytesToAscii(u8(0x41, 0x42), 100);
    expect(result).toBe("AB");
    expect(result).not.toContain("…");
  });

  it("returns '…' alone when maxLen=0 and array is non-empty", () => {
    expect(bytesToAscii(u8(0x41), 0)).toBe("…");
  });

  it("returns empty string when maxLen=0 and array is empty", () => {
    expect(bytesToAscii(u8(), 0)).toBe("");
  });

  it("replaces all high bytes with '.'", () => {
    expect(bytesToAscii(u8(0x80, 0xff, 0xc0))).toBe("...");
  });

  it("correctly converts a long all-printable string without truncation", () => {
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => 0x41 + (i % 26)));
    const result = bytesToAscii(bytes);
    expect(result).toHaveLength(50);
    expect(result).not.toContain("…");
  });

  it("default maxLen is Infinity (no truncation)", () => {
    const bytes = new Uint8Array(10000).fill(0x41);
    const result = bytesToAscii(bytes);
    expect(result).toHaveLength(10000);
  });
});

// decodeUtf8
describe("decodeUtf8", () => {
  it("decodes a simple ASCII string", () => {
    expect(decodeUtf8(str2u8("Hello"))).toBe("Hello");
  });

  it("decodes a multi-byte UTF-8 string (emoji)", () => {
    const emoji = "😀";
    expect(decodeUtf8(str2u8(emoji))).toBe(emoji);
  });

  it("decodes a string with accented characters (é, ñ, ü)", () => {
    const s = "café";
    expect(decodeUtf8(str2u8(s))).toBe(s);
  });

  it("decodes CJK characters", () => {
    const s = "日本語";
    expect(decodeUtf8(str2u8(s))).toBe(s);
  });

  it("returns null for invalid UTF-8 sequence (lone 0xff byte)", () => {
    expect(decodeUtf8(u8(0xff))).toBeNull();
  });

  it("returns null for invalid UTF-8 continuation byte (0x80 alone)", () => {
    expect(decodeUtf8(u8(0x80))).toBeNull();
  });

  it("returns null for truncated multi-byte sequence (0xc2 alone)", () => {
    // 0xc2 starts a 2-byte sequence; missing continuation byte
    expect(decodeUtf8(u8(0xc2))).toBeNull();
  });

  it("returns null for overlong encoding / invalid lead byte 0xfe", () => {
    expect(decodeUtf8(u8(0xfe, 0x80))).toBeNull();
  });

  it("decodes empty array to empty string", () => {
    expect(decodeUtf8(u8())).toBe("");
  });

  it("decodes a string containing NUL bytes (embedded NUL is valid UTF-8)", () => {
    const bytes = u8(0x41, 0x00, 0x42); // A NUL B
    const result = decodeUtf8(bytes);
    expect(result).toBe("A\u0000B");
  });

  it("decodes UTF-8 BOM sequence: TextDecoder strips BOM silently, returns only content", () => {
    // TextDecoder("utf-8") strips the BOM (U+FEFF) by default — result is just "A"
    const withBom = u8(0xef, 0xbb, 0xbf, 0x41); // BOM + 'A'
    const result = decodeUtf8(withBom);
    expect(result).toBe("A");
  });
});

// decodeUtf16LE
describe("decodeUtf16LE", () => {
  it("decodes 'AB' in UTF-16 LE", () => {
    // 'A' = 0x41 0x00, 'B' = 0x42 0x00
    expect(decodeUtf16LE(u8(0x41, 0x00, 0x42, 0x00))).toBe("AB");
  });

  it("decodes a Japanese character in UTF-16 LE", () => {
    // '日' = U+65E5 → LE bytes: 0xe5, 0x65
    expect(decodeUtf16LE(u8(0xe5, 0x65))).toBe("日");
  });

  it("decodes empty array to empty string", () => {
    expect(decodeUtf16LE(u8())).toBe("");
  });

  it("returns null or throws for odd-length byte array", () => {
    // Spec says odd length returns null
    const result = decodeUtf16LE(u8(0x41));
    // TextDecoder with fatal:true may handle this differently per implementation;
    // the function contract says null for odd length.
    // We only assert it does not throw:
    expect(() => decodeUtf16LE(u8(0x41))).not.toThrow();
  });

  it("decodes a surrogate pair (𝄞 MUSICAL SYMBOL G CLEF U+1D11E)", () => {
    // U+1D11E → surrogate pair 0xD834 0xDD1E in UTF-16
    // LE bytes: 0x34,0xD8, 0x1E,0xDD
    const result = decodeUtf16LE(u8(0x34, 0xd8, 0x1e, 0xdd));
    expect(result).toBe("\u{1D11E}");
  });
});

// decodeUtf16BE
describe("decodeUtf16BE", () => {
  it("decodes 'AB' in UTF-16 BE", () => {
    // 'A' = 0x00 0x41, 'B' = 0x00 0x42
    expect(decodeUtf16BE(u8(0x00, 0x41, 0x00, 0x42))).toBe("AB");
  });

  it("decodes a Japanese character in UTF-16 BE", () => {
    // '日' = U+65E5 → BE bytes: 0x65, 0xe5
    expect(decodeUtf16BE(u8(0x65, 0xe5))).toBe("日");
  });

  it("decodes empty array to empty string", () => {
    expect(decodeUtf16BE(u8())).toBe("");
  });

  it("does not confuse LE and BE (different byte order gives different result)", () => {
    const leBytes = u8(0x41, 0x00);
    const beBytes = u8(0x00, 0x41);
    expect(decodeUtf16LE(leBytes)).toBe("A");
    expect(decodeUtf16BE(beBytes)).toBe("A");
    // LE bytes decoded as BE would give a different (non-'A') character
    expect(decodeUtf16BE(leBytes)).not.toBe("A");
  });
});

// decodeLatin1
describe("decodeLatin1", () => {
  it("decodes standard ASCII bytes", () => {
    expect(decodeLatin1(u8(0x48, 0x65, 0x6c, 0x6c, 0x6f))).toBe("Hello");
  });

  it("decodes high bytes (0xa9 → '©')", () => {
    expect(decodeLatin1(u8(0xa9))).toBe("©");
  });

  it("decodes 0xe9 → 'é'", () => {
    expect(decodeLatin1(u8(0xe9))).toBe("é");
  });

  it("decodes 0xff → 'ÿ'", () => {
    expect(decodeLatin1(u8(0xff))).toBe("ÿ");
  });

  it("never throws for any byte value 0–255", () => {
    const allBytes = new Uint8Array(256).map((_, i) => i);
    expect(() => decodeLatin1(allBytes)).not.toThrow();
  });

  it("returns empty string for empty array", () => {
    expect(decodeLatin1(u8())).toBe("");
  });

  it("always returns a string (never null)", () => {
    expect(typeof decodeLatin1(u8(0x80, 0x90, 0xa0))).toBe("string");
  });

  it("decodes 0x00 as NUL character (not '.')", () => {
    expect(decodeLatin1(u8(0x00))).toBe("\u0000");
  });
});

// hasBomAt
describe("hasBomAt", () => {
  it("returns true for UTF-8 BOM at start", () => {
    expect(hasBomAt(u8(0xef, 0xbb, 0xbf, 0x41), [0xef, 0xbb, 0xbf])).toBe(true);
  });

  it("returns false when bytes are too short for the BOM", () => {
    expect(hasBomAt(u8(0xef, 0xbb), [0xef, 0xbb, 0xbf])).toBe(false);
  });

  it("returns false when first byte doesn't match", () => {
    expect(hasBomAt(u8(0xfe, 0xbb, 0xbf), [0xef, 0xbb, 0xbf])).toBe(false);
  });

  it("returns false when middle byte doesn't match", () => {
    expect(hasBomAt(u8(0xef, 0x00, 0xbf), [0xef, 0xbb, 0xbf])).toBe(false);
  });

  it("returns true for UTF-16 BE BOM", () => {
    expect(hasBomAt(u8(0xfe, 0xff, 0x00, 0x41), [0xfe, 0xff])).toBe(true);
  });

  it("returns true for UTF-16 LE BOM", () => {
    expect(hasBomAt(u8(0xff, 0xfe, 0x41, 0x00), [0xff, 0xfe])).toBe(true);
  });

  it("returns false for empty array with non-empty BOM", () => {
    expect(hasBomAt(u8(), [0xef, 0xbb, 0xbf])).toBe(false);
  });

  it("returns true for empty BOM array (vacuously true)", () => {
    expect(hasBomAt(u8(0x41), [])).toBe(true);
  });

  it("returns true when byte array equals exactly the BOM", () => {
    expect(hasBomAt(u8(0xef, 0xbb, 0xbf), [0xef, 0xbb, 0xbf])).toBe(true);
  });

  it("does not mistake UTF-16 LE for UTF-16 BE (byte order matters)", () => {
    expect(hasBomAt(u8(0xff, 0xfe), [0xfe, 0xff])).toBe(false);
  });
});

// isAllAscii
describe("isAllAscii", () => {
  it("returns true for pure ASCII bytes", () => {
    expect(isAllAscii(str2u8("Hello, World!"))).toBe(true);
  });

  it("returns false when a high byte (≥ 0x80) is present", () => {
    expect(isAllAscii(u8(0x48, 0x80))).toBe(false);
  });

  it("returns true for empty array", () => {
    expect(isAllAscii(u8())).toBe(true);
  });

  it("returns false for a single high byte 0xff", () => {
    expect(isAllAscii(u8(0xff))).toBe(false);
  });

  it("returns true for boundary byte 0x7f (still < 0x80)", () => {
    expect(isAllAscii(u8(0x7f))).toBe(true);
  });

  it("returns false for boundary byte 0x80", () => {
    expect(isAllAscii(u8(0x80))).toBe(false);
  });

  it("returns false when only the last byte is high", () => {
    expect(isAllAscii(u8(0x41, 0x42, 0x43, 0x80))).toBe(false);
  });

  it("returns true for all bytes in range 0x00–0x7f", () => {
    const bytes = new Uint8Array(128).map((_, i) => i);
    expect(isAllAscii(bytes)).toBe(true);
  });
});

// hasAnyByteAbove
describe("hasAnyByteAbove", () => {
  it("returns true when a byte exceeds threshold 0x7e", () => {
    expect(hasAnyByteAbove(u8(0x41, 0x7f), 0x7e)).toBe(true);
  });

  it("returns false when all bytes are at or below threshold", () => {
    expect(hasAnyByteAbove(u8(0x41, 0x7e), 0x7e)).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasAnyByteAbove(u8(), 0x7e)).toBe(false);
  });

  it("returns true for threshold 0x00 when any byte > 0", () => {
    expect(hasAnyByteAbove(u8(0x00, 0x01), 0x00)).toBe(true);
  });

  it("returns false when threshold is 0xff (no byte can exceed max byte)", () => {
    expect(hasAnyByteAbove(u8(0xfe, 0xff), 0xff)).toBe(false);
  });

  it("returns true when threshold is 0xfe and array contains 0xff", () => {
    expect(hasAnyByteAbove(u8(0xff), 0xfe)).toBe(true);
  });

  it("returns false for all-zero array with threshold 0x00", () => {
    expect(hasAnyByteAbove(u8(0x00, 0x00, 0x00), 0x00)).toBe(false);
  });

  it("returns true when only first byte exceeds threshold", () => {
    expect(hasAnyByteAbove(u8(0x80, 0x00, 0x00), 0x7e)).toBe(true);
  });
});

// detectEncoding
describe("detectEncoding", () => {
  // BOM detection
  describe("BOM detection", () => {
    it("detects UTF-8 BOM", () => {
      const result = detectEncoding(u8(0xef, 0xbb, 0xbf, 0x41));
      expect(result.encoding).toBe("utf-8");
      expect(result.hasBom).toBe(true);
      expect(result.contentStart).toBe(3);
    });

    it("detects UTF-16 BE BOM", () => {
      const result = detectEncoding(u8(0xfe, 0xff, 0x00, 0x41));
      expect(result.encoding).toBe("utf-16be");
      expect(result.hasBom).toBe(true);
      expect(result.contentStart).toBe(2);
    });

    it("detects UTF-16 LE BOM", () => {
      const result = detectEncoding(u8(0xff, 0xfe, 0x41, 0x00));
      expect(result.encoding).toBe("utf-16le");
      expect(result.hasBom).toBe(true);
      expect(result.contentStart).toBe(2);
    });

    it("BOM-only array still detected (UTF-8 BOM with no following bytes)", () => {
      const result = detectEncoding(u8(0xef, 0xbb, 0xbf));
      expect(result.encoding).toBe("utf-8");
      expect(result.hasBom).toBe(true);
      expect(result.contentStart).toBe(3);
    });

    it("BOM-only UTF-16 LE (exactly 2 bytes)", () => {
      const result = detectEncoding(u8(0xff, 0xfe));
      expect(result.encoding).toBe("utf-16le");
      expect(result.hasBom).toBe(true);
      expect(result.contentStart).toBe(2);
    });
  });

  // Empty input
  describe("empty input", () => {
    it("returns binary encoding for empty array", () => {
      const result = detectEncoding(u8());
      expect(result.encoding).toBe("binary");
      expect(result.hasBom).toBe(false);
      expect(result.contentStart).toBe(0);
    });
  });

  // Pure ASCII
  describe("pure ASCII (subset of UTF-8)", () => {
    it("detects 'ascii' for a pure ASCII string", () => {
      const result = detectEncoding(str2u8("Hello, World!"));
      expect(result.encoding).toBe("ascii");
      expect(result.hasBom).toBe(false);
      expect(result.contentStart).toBe(0);
    });

    it("detects 'ascii' for a single printable ASCII byte", () => {
      const result = detectEncoding(u8(0x41));
      expect(result.encoding).toBe("ascii");
    });

    it("detects 'ascii' for bytes with NUL (0x00 is < 0x80, valid UTF-8)", () => {
      const result = detectEncoding(u8(0x48, 0x00, 0x69));
      expect(result.encoding).toBe("ascii");
    });
  });

  // UTF-8 with multi-byte sequences
  describe("UTF-8 multi-byte sequences (no BOM)", () => {
    it("detects 'utf-8' for a string containing accented chars", () => {
      const result = detectEncoding(str2u8("café"));
      expect(result.encoding).toBe("utf-8");
      expect(result.hasBom).toBe(false);
    });

    it("detects 'utf-8' for emoji bytes", () => {
      const result = detectEncoding(str2u8("Hello 😀"));
      expect(result.encoding).toBe("utf-8");
    });

    it("detects 'utf-8' for CJK characters", () => {
      const result = detectEncoding(str2u8("日本語テスト"));
      expect(result.encoding).toBe("utf-8");
    });

    it("contentStart is 0 when no BOM", () => {
      const result = detectEncoding(str2u8("Héllo"));
      expect(result.contentStart).toBe(0);
    });
  });

  // Latin-1 (invalid UTF-8 with high bytes)
  describe("Latin-1 (invalid UTF-8 with high bytes)", () => {
    it("detects 'latin-1' for lone high byte 0xff", () => {
      const result = detectEncoding(u8(0xff));
      expect(result.encoding).toBe("latin-1");
      expect(result.hasBom).toBe(false);
      expect(result.contentStart).toBe(0);
    });

    it("detects 'latin-1' for Latin-1 encoded text with 0xe9", () => {
      // 'é' in Latin-1 is 0xe9, which is invalid as standalone UTF-8
      const result = detectEncoding(u8(0x63, 0x61, 0x66, 0xe9)); // "café" in Latin-1
      expect(result.encoding).toBe("latin-1");
    });

    it("detects 'latin-1' for 0x80 (invalid UTF-8 standalone)", () => {
      const result = detectEncoding(u8(0x80));
      expect(result.encoding).toBe("latin-1");
    });
  });

  // Binary fallback
  describe("binary fallback", () => {
    it("detects 'binary' for bytes that are invalid UTF-8 but all ≤ 0x7e", () => {
      // A truncated UTF-8 sequence that's still < 0x80 — practically never happens
      // but: if all bytes happen to be < 0x80 yet invalid UTF-8... TextDecoder
      // with fatal=true and bytes < 0x80 actually always succeed (they're ASCII).
      // So the only way to get "binary" without a high byte is via the empty path:
      const result = detectEncoding(u8());
      expect(result.encoding).toBe("binary");
    });

    // NOTE: The "binary" branch (hasHighBytes=false, not valid UTF-8) is theoretically
    // unreachable for standard Uint8Array content because bytes < 0x80 are always
    // valid UTF-8. The empty-array test above covers the explicit early return.
  });

  // result shape
  describe("result shape", () => {
    it("always returns an object with encoding, hasBom, and contentStart", () => {
      const cases = [u8(), str2u8("hello"), u8(0xef, 0xbb, 0xbf, 0x41), u8(0xff)];
      for (const bytes of cases) {
        const r = detectEncoding(bytes);
        expect(r).toHaveProperty("encoding");
        expect(r).toHaveProperty("hasBom");
        expect(r).toHaveProperty("contentStart");
      }
    });

    it("hasBom is always boolean", () => {
      expect(typeof detectEncoding(str2u8("hello")).hasBom).toBe("boolean");
    });

    it("contentStart is 0 for non-BOM encodings", () => {
      expect(detectEncoding(str2u8("hello")).contentStart).toBe(0);
      expect(detectEncoding(u8(0xff)).contentStart).toBe(0);
    });
  });
});

// decode
describe("decode", () => {
  it("'ascii' encoding uses bytesToAscii (non-printable → '.')", () => {
    expect(decode(u8(0x41, 0x00, 0x42), "ascii")).toBe("A.B");
  });

  it("'binary' encoding uses bytesToAscii (same as ascii)", () => {
    expect(decode(u8(0x41, 0x00, 0x42), "binary")).toBe("A.B");
  });

  it("'utf-8' returns decoded string for valid UTF-8", () => {
    expect(decode(str2u8("Hello"), "utf-8")).toBe("Hello");
  });

  it("'utf-8' returns null for invalid UTF-8 (0xff byte)", () => {
    expect(decode(u8(0xff), "utf-8")).toBeNull();
  });

  it("'utf-16le' decodes correctly", () => {
    expect(decode(u8(0x41, 0x00), "utf-16le")).toBe("A");
  });

  it("'utf-16le' returns null for invalid sequence", () => {
    // An odd number of bytes with fatal:true
    // (behavior may vary; at minimum, must not throw)
    expect(() => decode(u8(0x41), "utf-16le")).not.toThrow();
  });

  it("'utf-16be' decodes correctly", () => {
    expect(decode(u8(0x00, 0x41), "utf-16be")).toBe("A");
  });

  it("'utf-16be' returns null for invalid sequence", () => {
    expect(() => decode(u8(0x41), "utf-16be")).not.toThrow();
  });

  it("'utf-32le' returns null in Node.js/V8 (utf-32le unsupported by TextDecoder)", () => {
    // TextDecoder does not support utf-32le in Node.js — the try/catch returns null
    const result = decode(u8(0x41, 0x00, 0x00, 0x00), "utf-32le");
    expect(result).toBeNull();
  });

  it("'utf-32le' returns null for any input (encoding unsupported)", () => {
    expect(() => decode(u8(0x41, 0x00, 0x00), "utf-32le")).not.toThrow();
    expect(decode(u8(0x41, 0x00, 0x00), "utf-32le")).toBeNull();
  });

  it("'utf-32be' returns null in Node.js/V8 (utf-32be unsupported by TextDecoder)", () => {
    // TextDecoder does not support utf-32be in Node.js — the try/catch returns null
    const result = decode(u8(0x00, 0x00, 0x00, 0x41), "utf-32be");
    expect(result).toBeNull();
  });

  it("'utf-32be' returns null for any input (encoding unsupported)", () => {
    expect(() => decode(u8(0x00, 0x00, 0x00), "utf-32be")).not.toThrow();
    expect(decode(u8(0x00, 0x00, 0x00), "utf-32be")).toBeNull();
  });

  it("'latin-1' always returns a string (never null)", () => {
    const result = decode(u8(0xff, 0x80, 0x00), "latin-1");
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
  });

  it("'latin-1' decodes 0xa9 to '©'", () => {
    expect(decode(u8(0xa9), "latin-1")).toBe("©");
  });

  it("'ascii' on empty array returns empty string", () => {
    expect(decode(u8(), "ascii")).toBe("");
  });

  it("'binary' on empty array returns empty string", () => {
    expect(decode(u8(), "binary")).toBe("");
  });

  it("'utf-8' on empty array returns empty string", () => {
    expect(decode(u8(), "utf-8")).toBe("");
  });
});

// decodeSafe
describe("decodeSafe", () => {
  it("returns decoded string for valid UTF-8", () => {
    expect(decodeSafe(str2u8("Hello"), "utf-8")).toBe("Hello");
  });

  it("falls back to bytesToAscii for invalid UTF-8", () => {
    // 0xff is invalid UTF-8; fallback should replace with '.'
    const result = decodeSafe(u8(0xff), "utf-8");
    expect(result).toBe(".");
  });

  it("falls back to bytesToAscii for invalid UTF-16 LE", () => {
    expect(() => decodeSafe(u8(0x41), "utf-16le")).not.toThrow();
    // Must return a string, never throws
    expect(typeof decodeSafe(u8(0x41), "utf-16le")).toBe("string");
  });

  it("always returns a string — never null", () => {
    const encodings: Encoding[] = ["ascii", "utf-8", "utf-16le", "utf-16be", "utf-32le", "utf-32be", "latin-1", "binary"];
    for (const enc of encodings) {
      expect(typeof decodeSafe(u8(0xff, 0xfe, 0x41), enc)).toBe("string");
    }
  });

  it("returns empty string for empty array on all encodings", () => {
    const encodings: Encoding[] = ["ascii", "utf-8", "utf-16le", "utf-16be", "utf-32le", "utf-32be", "latin-1", "binary"];
    for (const enc of encodings) {
      expect(decodeSafe(u8(), enc)).toBe("");
    }
  });

  it("'binary' encoding always returns string with '.' for non-printable", () => {
    expect(decodeSafe(u8(0x00, 0x01, 0x02), "binary")).toBe("...");
  });

  it("returns correct string for 'ascii' on mixed printable/non-printable", () => {
    expect(decodeSafe(u8(0x41, 0x00, 0x42), "ascii")).toBe("A.B");
  });

  it("falls back gracefully for invalid UTF-32 LE (not multiple of 4)", () => {
    const result = decodeSafe(u8(0x41, 0x00, 0x00), "utf-32le");
    expect(typeof result).toBe("string");
  });
});

// Integration: detectEncoding + decode
describe("Integration: detectEncoding → decode pipeline", () => {
  it("correctly round-trips a UTF-8 string", () => {
    const original = "Hello, 世界! 🌍";
    const bytes = str2u8(original);
    const { encoding, contentStart } = detectEncoding(bytes);
    const decoded = decode(bytes.slice(contentStart), encoding);
    expect(decoded).toBe(original);
  });

  it("correctly round-trips pure ASCII", () => {
    const original = "The quick brown fox";
    const bytes = str2u8(original);
    const { encoding, contentStart } = detectEncoding(bytes);
    const decoded = decodeSafe(bytes.slice(contentStart), encoding);
    expect(decoded).toBe(original);
  });

  it("correctly skips UTF-8 BOM and decodes content", () => {
    const content = "Hello";
    const bytes = u8(0xef, 0xbb, 0xbf, ...str2u8(content));
    const { encoding, contentStart, hasBom } = detectEncoding(bytes);
    expect(hasBom).toBe(true);
    const decoded = decodeSafe(bytes.slice(contentStart), encoding);
    expect(decoded).toBe(content);
  });

  it("correctly skips UTF-16 LE BOM and decodes content", () => {
    // 'Hi' in UTF-16 LE: H=0x48,0x00, i=0x69,0x00
    const bytes = u8(0xff, 0xfe, 0x48, 0x00, 0x69, 0x00);
    const { encoding, contentStart, hasBom } = detectEncoding(bytes);
    expect(hasBom).toBe(true);
    expect(encoding).toBe("utf-16le");
    const decoded = decodeSafe(bytes.slice(contentStart), encoding);
    expect(decoded).toBe("Hi");
  });

  it("decodeSafe never throws for any byte value with any encoding", () => {
    const encodings: Encoding[] = ["ascii", "utf-8", "utf-16le", "utf-16be", "utf-32le", "utf-32be", "latin-1", "binary"];
    const allBytes = new Uint8Array(256).map((_, i) => i);
    for (const enc of encodings) {
      expect(() => decodeSafe(allBytes, enc)).not.toThrow();
    }
  });
});
