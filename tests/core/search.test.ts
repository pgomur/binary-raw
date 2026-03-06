/**
 * @file Comprehensive Vitest tests for the binary search utilities module.
 */

import { describe, it, expect, vi } from "vitest";

// Mock @app-types

vi.mock("@app-types/index", () => ({
  Offset: {
    create: (n: number) => n,
    add: (a: number, b: number) => a + b,
    diff: (a: number, b: number) => a - b,
  },
  Bytes: {
    create: (n: number) => n,
    fromRange: (start: number, end: number) => end - start + 1,
  },
}));

// Mock @core/buffer
// readUint8 is used internally by findNext/findAll.
// We provide a real implementation backed by a DataView so tests exercise
// the actual search logic without depending on buffer.ts internals.

vi.mock("@core/buffer", () => ({
  readUint8: (buf: { view: DataView }, offset: number): number => buf.view.getUint8(offset),
}));

import { findNext, findAll, asciiToBytes, findAscii, hexToBytes, findHexPattern } from "../../src/core/search";

// Helpers

type FakeBuf = { view: DataView; byteLength: number };

/** Build the minimal BinaryBuffer shape expected by the module. */
const makeBuf = (...bytes: number[]): FakeBuf => {
  const ab = new Uint8Array(bytes).buffer;
  return { view: new DataView(ab), byteLength: bytes.length };
};

/** Build a BinaryBuffer of `n` zero bytes. */
const zeroBuf = (n: number): FakeBuf => makeBuf(...new Array<number>(n).fill(0));

/** Branded offset helper (transparent after mock). */
const O = (n: number) => n as Parameters<typeof findNext>[2];

/** Build a ByteRange from plain numbers. */
const range = (start: number, end: number) => ({
  start,
  end,
  length: end - start + 1,
});

// asciiToBytes

describe("asciiToBytes", () => {
  it("returns a Uint8Array", () => {
    expect(asciiToBytes("A")).toBeInstanceOf(Uint8Array);
  });

  it("converts a single character", () => {
    expect(asciiToBytes("A")[0]).toBe(0x41);
  });

  it("converts a multi-character string", () => {
    expect(Array.from(asciiToBytes("ABC"))).toEqual([0x41, 0x42, 0x43]);
  });

  it("converts 'Hello' correctly", () => {
    expect(Array.from(asciiToBytes("Hello"))).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it("returns an empty Uint8Array for an empty string", () => {
    const result = asciiToBytes("");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it("length matches the string length", () => {
    const text = "binary";
    expect(asciiToBytes(text).length).toBe(text.length);
  });

  it("clamps char codes with & 0xFF (high unicode → low byte)", () => {
    // charCode 0x141 (Ł) & 0xFF = 0x41 ('A')
    const result = asciiToBytes("\u0141");
    expect(result[0]).toBe(0x41);
  });

  it("handles space (0x20) and tilde (0x7E)", () => {
    expect(asciiToBytes(" ")[0]).toBe(0x20);
    expect(asciiToBytes("~")[0]).toBe(0x7e);
  });

  it("handles NUL character (charCode 0)", () => {
    expect(asciiToBytes("\u0000")[0]).toBe(0x00);
  });
});

// hexToBytes

describe("hexToBytes", () => {
  it("returns a Uint8Array", () => {
    expect(hexToBytes("FF")).toBeInstanceOf(Uint8Array);
  });

  it("converts 'FF' → [255]", () => {
    expect(Array.from(hexToBytes("FF"))).toEqual([255]);
  });

  it("converts '00' → [0]", () => {
    expect(Array.from(hexToBytes("00"))).toEqual([0]);
  });

  it("converts 'DEADBEEF' → [0xDE, 0xAD, 0xBE, 0xEF]", () => {
    expect(Array.from(hexToBytes("DEADBEEF"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("handles lowercase hex 'deadbeef'", () => {
    expect(Array.from(hexToBytes("deadbeef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("handles mixed case 'DeAdBeEf'", () => {
    expect(Array.from(hexToBytes("DeAdBeEf"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("strips internal spaces: '25 50 44 46' → [0x25, 0x50, 0x44, 0x46]", () => {
    expect(Array.from(hexToBytes("25 50 44 46"))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("strips tabs and newlines as whitespace", () => {
    expect(Array.from(hexToBytes("FF\t00\nAB"))).toEqual([0xff, 0x00, 0xab]);
  });

  it("output length is (cleaned hex length) / 2", () => {
    expect(hexToBytes("AABBCC").length).toBe(3);
  });

  it("throws for an odd-length hex string (after whitespace removal)", () => {
    expect(() => hexToBytes("F")).toThrow("even number of characters");
  });

  it("throws for 'FFF' (odd after strip)", () => {
    expect(() => hexToBytes("FFF")).toThrow("even number of characters");
  });

  it("throws for invalid hex characters", () => {
    expect(() => hexToBytes("ZZ")).toThrow("Invalid hex string");
  });

  it("throws for 'GH'", () => {
    expect(() => hexToBytes("GH")).toThrow("Invalid hex string");
  });

  it("returns empty Uint8Array for empty string (0 chars → 0 bytes)", () => {
    // '' has length 0, which is even → valid, produces 0 bytes
    expect(Array.from(hexToBytes(""))).toEqual([]);
  });
});

// findNext

describe("findNext", () => {
  // Empty / degenerate inputs

  it("returns null for an empty pattern", () => {
    expect(findNext(makeBuf(0xaa, 0xbb), new Uint8Array([]), O(0))).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(findNext(zeroBuf(0), new Uint8Array([0xaa]), O(0))).toBeNull();
  });

  it("returns null when pattern is longer than the buffer", () => {
    expect(findNext(makeBuf(0xaa), new Uint8Array([0xaa, 0xbb]), O(0))).toBeNull();
  });

  it("returns null when remaining bytes from startOffset < pattern length", () => {
    // buffer = [0xAA, 0xBB], startOffset=1, pattern=[0xBB, 0xCC] length 2 → 1 byte left → null
    expect(findNext(makeBuf(0xaa, 0xbb), new Uint8Array([0xbb, 0xcc]), O(1))).toBeNull();
  });

  // Single-byte patterns

  it("finds a single-byte pattern at offset 0", () => {
    expect(findNext(makeBuf(0xaa, 0xbb), new Uint8Array([0xaa]), O(0))).toBe(0);
  });

  it("finds a single-byte pattern at a non-zero offset", () => {
    expect(findNext(makeBuf(0x00, 0xbb, 0xcc), new Uint8Array([0xbb]), O(0))).toBe(1);
  });

  it("finds a single-byte pattern at the last position", () => {
    expect(findNext(makeBuf(0x00, 0x00, 0xff), new Uint8Array([0xff]), O(0))).toBe(2);
  });

  // Multi-byte patterns

  it("finds a 2-byte pattern", () => {
    expect(findNext(makeBuf(0x00, 0xaa, 0xbb, 0x00), new Uint8Array([0xaa, 0xbb]), O(0))).toBe(1);
  });

  it("finds a 4-byte pattern (PDF magic %PDF at offset 0)", () => {
    const buf = makeBuf(0x25, 0x50, 0x44, 0x46, 0x00);
    expect(findNext(buf, new Uint8Array([0x25, 0x50, 0x44, 0x46]), O(0))).toBe(0);
  });

  it("finds a 4-byte pattern at a non-zero offset", () => {
    const buf = makeBuf(0x00, 0xde, 0xad, 0xbe, 0xef);
    expect(findNext(buf, new Uint8Array([0xde, 0xad, 0xbe, 0xef]), O(0))).toBe(1);
  });

  // startOffset

  it("uses offset 0 by default when startOffset is omitted", () => {
    expect(findNext(makeBuf(0xaa, 0x00), new Uint8Array([0xaa]))).toBe(0);
  });

  it("respects startOffset: starts search from the given offset", () => {
    // pattern [0xAA] exists at 0 and 2; starting at 1 → finds 2
    expect(findNext(makeBuf(0xaa, 0x00, 0xaa), new Uint8Array([0xaa]), O(1))).toBe(2);
  });

  it("finds the pattern at exactly startOffset", () => {
    expect(findNext(makeBuf(0x00, 0xaa, 0xbb), new Uint8Array([0xaa, 0xbb]), O(1))).toBe(1);
  });

  // First occurrence

  it("returns the first match when the pattern occurs multiple times", () => {
    expect(findNext(makeBuf(0xaa, 0xbb, 0xaa, 0xbb), new Uint8Array([0xaa, 0xbb]), O(0))).toBe(0);
  });

  // Not found

  it("returns null when pattern is not present anywhere", () => {
    expect(findNext(makeBuf(0x01, 0x02, 0x03), new Uint8Array([0xff]), O(0))).toBeNull();
  });

  it("returns null when startOffset is past the only occurrence", () => {
    expect(findNext(makeBuf(0xaa, 0xbb, 0xcc, 0xdd), new Uint8Array([0xaa, 0xbb]), O(1))).toBeNull();
  });

  // Return type

  it("returns a number (offset) when found", () => {
    const result = findNext(makeBuf(0xaa), new Uint8Array([0xaa]), O(0));
    expect(typeof result).toBe("number");
  });
});

// findAll

describe("findAll", () => {
  // Empty / degenerate inputs

  it("returns an empty array for an empty pattern", () => {
    expect(findAll(makeBuf(0xaa), new Uint8Array([]))).toEqual([]);
  });

  it("returns an empty array for an empty buffer", () => {
    expect(findAll(zeroBuf(0), new Uint8Array([0xaa]))).toEqual([]);
  });

  it("returns an empty array when pattern is longer than the buffer", () => {
    expect(findAll(makeBuf(0xaa), new Uint8Array([0xaa, 0xbb]))).toEqual([]);
  });

  it("returns a readonly array", () => {
    const result = findAll(makeBuf(0xaa), new Uint8Array([0xaa]));
    expect(Array.isArray(result)).toBe(true);
  });

  // All occurrences

  it("finds a single occurrence", () => {
    const result = findAll(makeBuf(0x00, 0xaa, 0x00), new Uint8Array([0xaa]));
    expect(result).toEqual([1]);
  });

  it("finds multiple non-overlapping occurrences", () => {
    const result = findAll(makeBuf(0xaa, 0x00, 0xaa, 0x00, 0xaa), new Uint8Array([0xaa]));
    expect(result).toEqual([0, 2, 4]);
  });

  it("finds a 2-byte pattern at multiple positions", () => {
    const result = findAll(makeBuf(0xaa, 0xbb, 0x00, 0xaa, 0xbb), new Uint8Array([0xaa, 0xbb]));
    expect(result).toEqual([0, 3]);
  });

  it("returns empty when pattern is not present", () => {
    expect(findAll(makeBuf(0x01, 0x02, 0x03), new Uint8Array([0xff]))).toEqual([]);
  });

  // maxResults

  it("respects maxResults: stops after reaching the limit", () => {
    const result = findAll(makeBuf(0xaa, 0xaa, 0xaa, 0xaa), new Uint8Array([0xaa]), { maxResults: 2 });
    expect(result).toEqual([0, 1]);
    expect(result.length).toBe(2);
  });

  it("maxResults: 1 returns only the first match", () => {
    const result = findAll(makeBuf(0xaa, 0x00, 0xaa), new Uint8Array([0xaa]), { maxResults: 1 });
    expect(result).toEqual([0]);
  });

  it("maxResults larger than matches returns all of them", () => {
    const result = findAll(makeBuf(0xaa, 0x00, 0xaa), new Uint8Array([0xaa]), { maxResults: 100 });
    expect(result).toEqual([0, 2]);
  });

  // range

  it("respects range.start: ignores matches before it", () => {
    // [0xAA, 0x00, 0xAA, 0x00, 0xAA]; range starts at 1 → matches at 2,4
    const result = findAll(makeBuf(0xaa, 0x00, 0xaa, 0x00, 0xaa), new Uint8Array([0xaa]), { range: range(1, 4) });
    expect(result).not.toContain(0);
    expect(result).toContain(2);
    expect(result).toContain(4);
  });

  it("respects range.end: does not search beyond it", () => {
    // pattern at 0 and 4; range ends at 2 → only 0 found
    const result = findAll(makeBuf(0xaa, 0x00, 0x00, 0x00, 0xaa), new Uint8Array([0xaa]), { range: range(0, 2) });
    expect(result).toContain(0);
    expect(result).not.toContain(4);
  });

  it("returns empty when range.start > range.end", () => {
    const result = findAll(makeBuf(0xaa, 0xbb), new Uint8Array([0xaa]), { range: range(5, 2) });
    expect(result).toEqual([]);
  });

  it("returns empty when range is smaller than pattern length", () => {
    // range [0,0] = 1 byte, pattern = 2 bytes → impossible
    const result = findAll(makeBuf(0xaa, 0xbb), new Uint8Array([0xaa, 0xbb]), { range: range(0, 0) });
    expect(result).toEqual([]);
  });

  it("combines range and maxResults correctly", () => {
    // [0xAA,0xAA,0xAA,0xAA,0xAA], range [1,4], maxResults 2 → [1,2]
    const result = findAll(makeBuf(0xaa, 0xaa, 0xaa, 0xaa, 0xaa), new Uint8Array([0xaa]), { range: range(1, 4), maxResults: 2 });
    expect(result.length).toBe(2);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
  });

  it("with no options uses the full buffer", () => {
    const result = findAll(makeBuf(0xff, 0x00, 0xff), new Uint8Array([0xff]));
    expect(result).toEqual([0, 2]);
  });
});

// findAscii

describe("findAscii", () => {
  //  Basic

  it("finds an ASCII string in the buffer", () => {
    const buf = makeBuf(...Array.from(new TextEncoder().encode("Hello World")));
    const result = findAscii(buf, "World");
    expect(result).toContain(6);
  });

  it("finds ASCII at offset 0", () => {
    const buf = makeBuf(0x48, 0x65, 0x6c, 0x6c, 0x6f); // "Hello"
    expect(findAscii(buf, "Hello")).toEqual([0]);
  });

  it("returns empty for an empty search string (treated as 0-length pattern)", () => {
    const buf = makeBuf(0x41, 0x42);
    expect(findAscii(buf, "")).toEqual([]);
  });

  it("returns empty when text is not present", () => {
    const buf = makeBuf(0x41, 0x42, 0x43); // "ABC"
    expect(findAscii(buf, "XY")).toEqual([]);
  });

  it("finds multiple occurrences of the same ASCII string", () => {
    // "AAAA" → 0x41 four times
    const buf = makeBuf(0x41, 0x41, 0x41, 0x41);
    const result = findAscii(buf, "A");
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it("is case-sensitive ('hello' ≠ 'Hello')", () => {
    const buf = makeBuf(...Array.from(new TextEncoder().encode("Hello")));
    expect(findAscii(buf, "hello")).toEqual([]);
    expect(findAscii(buf, "Hello")).toEqual([0]);
  });

  // options passthrough

  it("respects maxResults option", () => {
    const buf = makeBuf(0x41, 0x41, 0x41, 0x41); // "AAAA"
    const result = findAscii(buf, "A", { maxResults: 2 });
    expect(result.length).toBe(2);
  });

  it("respects range option", () => {
    // "ABAB" → A at 0,2; B at 1,3; range [1,3] → A only at 2
    const buf = makeBuf(0x41, 0x42, 0x41, 0x42);
    const result = findAscii(buf, "A", { range: range(1, 3) });
    expect(result).not.toContain(0);
    expect(result).toContain(2);
  });
});

// findHexPattern

describe("findHexPattern", () => {
  // Basic

  it("finds a hex pattern in the buffer", () => {
    const buf = makeBuf(0x00, 0xde, 0xad, 0xbe, 0xef, 0x00);
    expect(findHexPattern(buf, "DEADBEEF")).toEqual([1]);
  });

  it("finds PDF magic bytes (%PDF = 25 50 44 46)", () => {
    const buf = makeBuf(0x25, 0x50, 0x44, 0x46, 0x2d);
    expect(findHexPattern(buf, "25504446")).toEqual([0]);
  });

  it("handles lowercase hex", () => {
    const buf = makeBuf(0xaa, 0xbb);
    expect(findHexPattern(buf, "aabb")).toEqual([0]);
  });

  it("handles space-separated hex string", () => {
    const buf = makeBuf(0x01, 0x02, 0x03);
    expect(findHexPattern(buf, "01 02 03")).toEqual([0]);
  });

  it("returns empty when pattern is not present", () => {
    const buf = makeBuf(0x01, 0x02, 0x03);
    expect(findHexPattern(buf, "FF")).toEqual([]);
  });

  it("returns multiple occurrences", () => {
    const buf = makeBuf(0xff, 0x00, 0xff, 0x00, 0xff);
    expect(findHexPattern(buf, "FF")).toEqual([0, 2, 4]);
  });

  // Error propagation from hexToBytes

  it("throws for an odd-length hex string", () => {
    const buf = makeBuf(0x01);
    expect(() => findHexPattern(buf, "F")).toThrow("even number of characters");
  });

  it("throws for an invalid hex string", () => {
    const buf = makeBuf(0x01);
    expect(() => findHexPattern(buf, "ZZ")).toThrow("Invalid hex string");
  });

  // options passthrough

  it("respects maxResults option", () => {
    const buf = makeBuf(0xff, 0xff, 0xff, 0xff);
    const result = findHexPattern(buf, "FF", { maxResults: 2 });
    expect(result.length).toBe(2);
  });

  it("respects range option", () => {
    const buf = makeBuf(0xff, 0x00, 0xff, 0x00, 0xff);
    const result = findHexPattern(buf, "FF", { range: range(1, 3) });
    expect(result).not.toContain(0);
    expect(result).toContain(2);
    expect(result).not.toContain(4);
  });
});

// Integration

describe("Integration", () => {
  it("findNext + findAll on same buffer return consistent first result", () => {
    const buf = makeBuf(0x00, 0xaa, 0xbb, 0x00, 0xaa, 0xbb);
    const pattern = new Uint8Array([0xaa, 0xbb]);
    const first = findNext(buf, pattern, O(0));
    const all = findAll(buf, pattern);
    expect(first).toBe(all[0]);
  });

  it("findAscii and findHexPattern agree for the same bytes", () => {
    // 'A' = 0x41
    const buf = makeBuf(0x00, 0x41, 0x00, 0x41);
    const byAscii = findAscii(buf, "A");
    const byHex = findHexPattern(buf, "41");
    expect(byAscii).toEqual(byHex);
  });

  it("hexToBytes output is suitable as direct findAll pattern", () => {
    const buf = makeBuf(0xde, 0xad, 0xbe, 0xef);
    const pattern = hexToBytes("DEADBEEF");
    expect(findAll(buf, pattern)).toEqual([0]);
  });

  it("asciiToBytes output is suitable as direct findAll pattern", () => {
    const text = "PDF";
    const buf = makeBuf(...Array.from(new TextEncoder().encode("%%PDF%%")));
    const pattern = asciiToBytes(text);
    const result = findAll(buf, pattern);
    expect(result).toContain(2);
  });

  it("findAll with maxResults=1 returns the same result as findNext", () => {
    const buf = makeBuf(0xaa, 0x00, 0xaa, 0x00);
    const pattern = new Uint8Array([0xaa]);
    const next = findNext(buf, pattern, O(0));
    const all = findAll(buf, pattern, { maxResults: 1 });
    expect(all[0]).toBe(next);
    expect(all.length).toBe(1);
  });

  it("searching after the last match returns null from findNext and empty from findAll", () => {
    const buf = makeBuf(0xaa, 0x00, 0x00);
    const pattern = new Uint8Array([0xaa]);
    expect(findNext(buf, pattern, O(1))).toBeNull();
    expect(findAll(buf, pattern, { range: range(1, 2) })).toEqual([]);
  });

  it("findAll with range covering the full buffer matches findAll without range", () => {
    const buf = makeBuf(0xaa, 0x00, 0xaa, 0x00, 0xaa);
    const pattern = new Uint8Array([0xaa]);
    const withRange = findAll(buf, pattern, { range: range(0, 4) });
    const withoutRange = findAll(buf, pattern);
    expect(withRange).toEqual(withoutRange);
  });
});
