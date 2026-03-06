/**
 * @file Comprehensive Vitest tests for the BinaryBuffer module.
 *
 * The @app-types branded-type helpers (Offset, Bytes) are mocked as
 * transparent pass-throughs so the tests focus purely on buffer logic.
 */

import { describe, it, expect, vi } from "vitest";

// Mock @app-types
// Branded types are just numbers at runtime. We mock the helpers as
// transparent pass-throughs so every test stays self-contained.

vi.mock("@app-types/index", () => ({
  Offset: {
    create: (n: number) => n,
    add: (a: number, b: number) => a + b,
    diff: (a: number, b: number) => a - b,
  },
  Bytes: {
    create: (n: number) => n,
  },
}));

import { BufferError, loadBuffer, readUint8, readInt8, readUint16, readInt16, readUint32, readInt32, readUint64, readInt64, readFloat32, readFloat64, readBytes, readMagic, findBytes, compareBytes, swapEndian16, swapEndian32, isEmpty, remainingBytes, type BinaryBuffer } from "../../src/core/buffer";

// Helpers

/** Branded-type helpers exposed as plain numbers (matches the mock above). */
const O = (n: number) => n as ReturnType<(typeof import("../../src/types/index"))["Offset"]["create"]>;
const B = (n: number) => n as ReturnType<(typeof import("../../src/types/index"))["Bytes"]["create"]>;

/** Build a BinaryBuffer from an explicit list of bytes. */
const buf = (...bytes: number[]): BinaryBuffer => loadBuffer(new Uint8Array(bytes).buffer);

/** Build a BinaryBuffer of `n` zero bytes. */
const zeroBuf = (n: number): BinaryBuffer => loadBuffer(new ArrayBuffer(n));

/** Build a BinaryBuffer and write `value` at `offset` via DataView setter. */
const bufWith = (size: number, write: (view: DataView) => void): BinaryBuffer => {
  const ab = new ArrayBuffer(size);
  write(new DataView(ab));
  return loadBuffer(ab);
};

// BufferError

describe("BufferError", () => {
  it("extends Error", () => {
    expect(new BufferError("m", "OUT_OF_BOUNDS")).toBeInstanceOf(Error);
  });

  it("is instanceof BufferError", () => {
    expect(new BufferError("m", "OUT_OF_BOUNDS")).toBeInstanceOf(BufferError);
  });

  it("name is 'BufferError'", () => {
    expect(new BufferError("m", "OUT_OF_BOUNDS").name).toBe("BufferError");
  });

  it("message is preserved", () => {
    expect(new BufferError("bad offset", "INVALID_OFFSET").message).toBe("bad offset");
  });

  it.each(["OUT_OF_BOUNDS", "OVERFLOW", "INVALID_OFFSET"] as const)("code '%s' is preserved", (code) => {
    expect(new BufferError("m", code).code).toBe(code);
  });

  it("can be caught and narrowed by code in a switch", () => {
    const err = new BufferError("oob", "OUT_OF_BOUNDS");
    let handled = "";
    switch (err.code) {
      case "OUT_OF_BOUNDS":
        handled = "oob";
        break;
      default:
        handled = "other";
    }
    expect(handled).toBe("oob");
  });
});

// loadBuffer

describe("loadBuffer", () => {
  it("returns an object with byteLength, view, and buffer", () => {
    const b = loadBuffer(new ArrayBuffer(4));
    expect(b).toHaveProperty("byteLength");
    expect(b).toHaveProperty("view");
    expect(b).toHaveProperty("buffer");
  });

  it("byteLength matches ArrayBuffer.byteLength", () => {
    expect(loadBuffer(new ArrayBuffer(16)).byteLength).toBe(16);
  });

  it("byteLength is 0 for an empty ArrayBuffer", () => {
    expect(loadBuffer(new ArrayBuffer(0)).byteLength).toBe(0);
  });

  it("view is a DataView over the same buffer", () => {
    const ab = new ArrayBuffer(4);
    const b = loadBuffer(ab);
    expect(b.view).toBeInstanceOf(DataView);
    expect(b.view.buffer).toBe(ab);
  });

  it("buffer is the exact same ArrayBuffer reference", () => {
    const ab = new ArrayBuffer(8);
    expect(loadBuffer(ab).buffer).toBe(ab);
  });

  it("byteLength of a 1-byte buffer is 1", () => {
    expect(loadBuffer(new ArrayBuffer(1)).byteLength).toBe(1);
  });
});

// readUint8 / readInt8

describe("readUint8", () => {
  it("reads 0x00 at offset 0", () => {
    expect(readUint8(buf(0x00), O(0))).toBe(0);
  });

  it("reads 0xFF at offset 0", () => {
    expect(readUint8(buf(0xff), O(0))).toBe(255);
  });

  it("reads the correct byte at a non-zero offset", () => {
    expect(readUint8(buf(0x00, 0x41, 0xff), O(1))).toBe(0x41);
  });

  it("reads the last byte at offset byteLength - 1", () => {
    expect(readUint8(buf(0x01, 0x02, 0xab), O(2))).toBe(0xab);
  });

  it("throws BufferError OUT_OF_BOUNDS when offset equals byteLength", () => {
    const b = buf(0x01);
    expect(() => readUint8(b, O(1))).toThrowError(BufferError);
    try {
      readUint8(b, O(1));
    } catch (e) {
      expect((e as BufferError).code).toBe("OUT_OF_BOUNDS");
    }
  });

  it("throws BufferError OUT_OF_BOUNDS for an empty buffer", () => {
    expect(() => readUint8(zeroBuf(0), O(0))).toThrowError(BufferError);
  });

  it("throws BufferError OUT_OF_BOUNDS for a large offset", () => {
    expect(() => readUint8(buf(0x01, 0x02), O(100))).toThrowError(BufferError);
  });
});

describe("readInt8", () => {
  it("reads 0x00 → 0", () => {
    expect(readInt8(buf(0x00), O(0))).toBe(0);
  });

  it("reads 0x7F → 127 (max positive)", () => {
    expect(readInt8(buf(0x7f), O(0))).toBe(127);
  });

  it("reads 0x80 → -128 (min negative)", () => {
    expect(readInt8(buf(0x80), O(0))).toBe(-128);
  });

  it("reads 0xFF → -1", () => {
    expect(readInt8(buf(0xff), O(0))).toBe(-1);
  });

  it("reads at non-zero offset correctly", () => {
    expect(readInt8(buf(0x00, 0x80), O(1))).toBe(-128);
  });

  it("throws BufferError OUT_OF_BOUNDS when out of range", () => {
    expect(() => readInt8(buf(0x01), O(1))).toThrowError(BufferError);
  });
});

// readUint16 / readInt16

describe("readUint16", () => {
  it("LE (default): [0x01, 0x00] → 1", () => {
    expect(readUint16(buf(0x01, 0x00), O(0))).toBe(1);
  });

  it("BE: [0x00, 0x01] → 1", () => {
    expect(readUint16(buf(0x00, 0x01), O(0), false)).toBe(1);
  });

  it("LE: [0xFF, 0xFF] → 65535 (max uint16)", () => {
    expect(readUint16(buf(0xff, 0xff), O(0))).toBe(65535);
  });

  it("BE: [0xFF, 0x00] → 65280", () => {
    expect(readUint16(buf(0xff, 0x00), O(0), false)).toBe(0xff00);
  });

  it("reads at non-zero offset", () => {
    expect(readUint16(buf(0x00, 0x01, 0x00), O(1))).toBe(1);
  });

  it("throws OUT_OF_BOUNDS when only 1 byte is available", () => {
    expect(() => readUint16(buf(0x01), O(0))).toThrowError(BufferError);
  });

  it("throws OUT_OF_BOUNDS when offset + 2 > byteLength", () => {
    expect(() => readUint16(buf(0x01, 0x02, 0x03), O(2))).toThrowError(BufferError);
  });
});

describe("readInt16", () => {
  it("LE: [0xFF, 0xFF] → -1", () => {
    expect(readInt16(buf(0xff, 0xff), O(0))).toBe(-1);
  });

  it("BE: [0x80, 0x00] → -32768 (min int16)", () => {
    expect(readInt16(buf(0x80, 0x00), O(0), false)).toBe(-32768);
  });

  it("LE: [0x00, 0x80] → -32768", () => {
    expect(readInt16(buf(0x00, 0x80), O(0))).toBe(-32768);
  });

  it("LE: [0xFF, 0x7F] → 32767 (max int16)", () => {
    expect(readInt16(buf(0xff, 0x7f), O(0))).toBe(32767);
  });

  it("throws OUT_OF_BOUNDS when buffer is too small", () => {
    expect(() => readInt16(buf(0xff), O(0))).toThrowError(BufferError);
  });
});

// readUint32 / readInt32

describe("readUint32", () => {
  it("LE: [0x01,0x00,0x00,0x00] → 1", () => {
    expect(readUint32(buf(0x01, 0x00, 0x00, 0x00), O(0))).toBe(1);
  });

  it("BE: [0x00,0x00,0x00,0x01] → 1", () => {
    expect(readUint32(buf(0x00, 0x00, 0x00, 0x01), O(0), false)).toBe(1);
  });

  it("LE: all-0xFF → 4294967295 (max uint32)", () => {
    expect(readUint32(buf(0xff, 0xff, 0xff, 0xff), O(0))).toBe(4294967295);
  });

  it("reads 0xDEADBEEF in BE", () => {
    expect(readUint32(buf(0xde, 0xad, 0xbe, 0xef), O(0), false)).toBe(0xdeadbeef);
  });

  it("reads at non-zero offset", () => {
    expect(readUint32(buf(0x00, 0x01, 0x00, 0x00, 0x00), O(1))).toBe(1);
  });

  it("throws OUT_OF_BOUNDS with only 3 bytes available", () => {
    expect(() => readUint32(buf(0x01, 0x02, 0x03), O(0))).toThrowError(BufferError);
  });

  it("throws OUT_OF_BOUNDS when offset + 4 > byteLength", () => {
    expect(() => readUint32(buf(0x01, 0x02, 0x03, 0x04), O(1))).toThrowError(BufferError);
  });
});

describe("readInt32", () => {
  it("LE: all-0xFF → -1", () => {
    expect(readInt32(buf(0xff, 0xff, 0xff, 0xff), O(0))).toBe(-1);
  });

  it("BE: [0x80,0x00,0x00,0x00] → -2147483648 (min int32)", () => {
    expect(readInt32(buf(0x80, 0x00, 0x00, 0x00), O(0), false)).toBe(-2147483648);
  });

  it("LE: [0x00,0x00,0x00,0x80] → -2147483648", () => {
    expect(readInt32(buf(0x00, 0x00, 0x00, 0x80), O(0))).toBe(-2147483648);
  });

  it("BE: [0x7F,0xFF,0xFF,0xFF] → 2147483647 (max int32)", () => {
    expect(readInt32(buf(0x7f, 0xff, 0xff, 0xff), O(0), false)).toBe(2147483647);
  });

  it("throws OUT_OF_BOUNDS when buffer is too small", () => {
    expect(() => readInt32(buf(0x01, 0x02, 0x03), O(0))).toThrowError(BufferError);
  });
});

// readUint64 / readInt64

describe("readUint64", () => {
  it("LE: [0x01,...zeros...] → 1n", () => {
    const b = bufWith(8, (v) => v.setBigUint64(0, 1n, true));
    expect(readUint64(b, O(0))).toBe(1n);
  });

  it("BE: [...zeros...,0x01] → 1n", () => {
    const b = bufWith(8, (v) => v.setBigUint64(0, 1n, false));
    expect(readUint64(b, O(0), false)).toBe(1n);
  });

  it("LE: all-0xFF → 18446744073709551615n (max uint64)", () => {
    const b = loadBuffer(new Uint8Array(8).fill(0xff).buffer);
    expect(readUint64(b, O(0))).toBe(18446744073709551615n);
  });

  it("returns a bigint", () => {
    const b = bufWith(8, (v) => v.setBigUint64(0, 42n, true));
    expect(typeof readUint64(b, O(0))).toBe("bigint");
  });

  it("reads at a non-zero offset", () => {
    const b = bufWith(9, (v) => v.setBigUint64(1, 7n, true));
    expect(readUint64(b, O(1))).toBe(7n);
  });

  it("throws OUT_OF_BOUNDS when fewer than 8 bytes are available", () => {
    expect(() => readUint64(zeroBuf(7), O(0))).toThrowError(BufferError);
  });

  it("throws OUT_OF_BOUNDS when offset + 8 > byteLength", () => {
    expect(() => readUint64(zeroBuf(8), O(1))).toThrowError(BufferError);
  });
});

describe("readInt64", () => {
  it("LE: all-0xFF → -1n", () => {
    const b = loadBuffer(new Uint8Array(8).fill(0xff).buffer);
    expect(readInt64(b, O(0))).toBe(-1n);
  });

  it("BE: [0x80,...zeros...] → min int64", () => {
    const b = bufWith(8, (v) => v.setBigInt64(0, -9223372036854775808n, false));
    expect(readInt64(b, O(0), false)).toBe(-9223372036854775808n);
  });

  it("LE: value 42n round-trips correctly", () => {
    const b = bufWith(8, (v) => v.setBigInt64(0, 42n, true));
    expect(readInt64(b, O(0))).toBe(42n);
  });

  it("returns a bigint", () => {
    const b = bufWith(8, (v) => v.setBigInt64(0, -1n, true));
    expect(typeof readInt64(b, O(0))).toBe("bigint");
  });

  it("throws OUT_OF_BOUNDS when buffer is too small", () => {
    expect(() => readInt64(zeroBuf(7), O(0))).toThrowError(BufferError);
  });
});

// readFloat32 / readFloat64

describe("readFloat32", () => {
  it("LE: IEEE 1.0 → 1.0", () => {
    const b = bufWith(4, (v) => v.setFloat32(0, 1.0, true));
    expect(readFloat32(b, O(0))).toBeCloseTo(1.0, 6);
  });

  it("BE: IEEE 1.0 BE → 1.0", () => {
    const b = bufWith(4, (v) => v.setFloat32(0, 1.0, false));
    expect(readFloat32(b, O(0), false)).toBeCloseTo(1.0, 6);
  });

  it("LE: IEEE -1.0 → -1.0", () => {
    const b = bufWith(4, (v) => v.setFloat32(0, -1.0, true));
    expect(readFloat32(b, O(0))).toBeCloseTo(-1.0, 6);
  });

  it("LE: 0.0 → 0.0", () => {
    expect(readFloat32(zeroBuf(4), O(0))).toBe(0.0);
  });

  it("LE: Infinity bytes → Infinity", () => {
    const b = bufWith(4, (v) => v.setFloat32(0, Infinity, true));
    expect(readFloat32(b, O(0))).toBe(Infinity);
  });

  it("LE: NaN bytes → NaN", () => {
    const b = bufWith(4, (v) => v.setFloat32(0, NaN, true));
    expect(Number.isNaN(readFloat32(b, O(0)))).toBe(true);
  });

  it("reads at a non-zero offset", () => {
    const b = bufWith(5, (v) => v.setFloat32(1, 3.14, true));
    expect(readFloat32(b, O(1))).toBeCloseTo(3.14, 5);
  });

  it("throws OUT_OF_BOUNDS with only 3 bytes available", () => {
    expect(() => readFloat32(zeroBuf(3), O(0))).toThrowError(BufferError);
  });
});

describe("readFloat64", () => {
  it("LE: IEEE 1.0 → 1.0", () => {
    const b = bufWith(8, (v) => v.setFloat64(0, 1.0, true));
    expect(readFloat64(b, O(0))).toBeCloseTo(1.0, 10);
  });

  it("BE: IEEE 1.0 BE → 1.0", () => {
    const b = bufWith(8, (v) => v.setFloat64(0, 1.0, false));
    expect(readFloat64(b, O(0), false)).toBeCloseTo(1.0, 10);
  });

  it("LE: Math.PI round-trips correctly", () => {
    const b = bufWith(8, (v) => v.setFloat64(0, Math.PI, true));
    expect(readFloat64(b, O(0))).toBeCloseTo(Math.PI, 10);
  });

  it("LE: 0.0 → 0.0", () => {
    expect(readFloat64(zeroBuf(8), O(0))).toBe(0.0);
  });

  it("LE: -Infinity bytes → -Infinity", () => {
    const b = bufWith(8, (v) => v.setFloat64(0, -Infinity, true));
    expect(readFloat64(b, O(0))).toBe(-Infinity);
  });

  it("reads at a non-zero offset", () => {
    const b = bufWith(9, (v) => v.setFloat64(1, 2.718, true));
    expect(readFloat64(b, O(1))).toBeCloseTo(2.718, 10);
  });

  it("throws OUT_OF_BOUNDS with only 7 bytes available", () => {
    expect(() => readFloat64(zeroBuf(7), O(0))).toThrowError(BufferError);
  });

  it("throws OUT_OF_BOUNDS when offset + 8 > byteLength", () => {
    expect(() => readFloat64(zeroBuf(8), O(1))).toThrowError(BufferError);
  });
});

// readBytes

describe("readBytes", () => {
  it("returns a Uint8Array", () => {
    expect(readBytes(buf(0x01, 0x02), O(0), B(2))).toBeInstanceOf(Uint8Array);
  });

  it("reads the correct bytes from offset 0", () => {
    expect(Array.from(readBytes(buf(0xaa, 0xbb, 0xcc), O(0), B(3)))).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("reads a sub-range at a non-zero offset", () => {
    expect(Array.from(readBytes(buf(0x00, 0xaa, 0xbb), O(1), B(2)))).toEqual([0xaa, 0xbb]);
  });

  it("reads 0 bytes → returns an empty Uint8Array", () => {
    expect(Array.from(readBytes(buf(0x01, 0x02), O(0), B(0)))).toEqual([]);
  });

  it("reads the last single byte", () => {
    expect(Array.from(readBytes(buf(0x01, 0x02, 0xff), O(2), B(1)))).toEqual([0xff]);
  });

  it("reads the entire buffer", () => {
    const bytes = [0x01, 0x02, 0x03, 0x04];
    expect(Array.from(readBytes(buf(...bytes), O(0), B(4)))).toEqual(bytes);
  });

  it("is a defensive copy (mutating the result does not affect the buffer)", () => {
    const b = buf(0xaa, 0xbb);
    const result = readBytes(b, O(0), B(1));
    result[0] = 0xff;
    expect(readUint8(b, O(0))).toBe(0xaa); // original unchanged
  });

  it("throws OUT_OF_BOUNDS when length exceeds available bytes", () => {
    expect(() => readBytes(buf(0x01, 0x02), O(0), B(3))).toThrowError(BufferError);
  });

  it("throws OUT_OF_BOUNDS when offset + length > byteLength", () => {
    expect(() => readBytes(buf(0x01, 0x02, 0x03), O(2), B(2))).toThrowError(BufferError);
  });
});

// readMagic

describe("readMagic", () => {
  it("reads the first N bytes (magic bytes)", () => {
    expect(Array.from(readMagic(buf(0x25, 0x50, 0x44, 0x46, 0x00), B(4)))).toEqual([0x25, 0x50, 0x44, 0x46]); // %PDF
  });

  it("reads from offset 0 always", () => {
    expect(readMagic(buf(0xca, 0xfe, 0xba, 0xbe), B(4))[0]).toBe(0xca);
  });

  it("clamps length to byteLength when length > buffer size", () => {
    const result = readMagic(buf(0x01, 0x02), B(100));
    expect(result.byteLength).toBe(2);
    expect(Array.from(result)).toEqual([0x01, 0x02]);
  });

  it("returns empty Uint8Array for an empty buffer", () => {
    expect(Array.from(readMagic(zeroBuf(0), B(4)))).toEqual([]);
  });

  it("returns empty Uint8Array when length = 0", () => {
    expect(Array.from(readMagic(buf(0x01, 0x02), B(0)))).toEqual([]);
  });

  it("reads exactly byteLength bytes when length === byteLength", () => {
    const result = readMagic(buf(0xaa, 0xbb, 0xcc), B(3));
    expect(Array.from(result)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("returns a Uint8Array instance", () => {
    expect(readMagic(buf(0x01), B(1))).toBeInstanceOf(Uint8Array);
  });
});

// findBytes

describe("findBytes", () => {
  it("finds a single-byte pattern at offset 0", () => {
    expect(findBytes(buf(0xaa, 0xbb, 0xcc), new Uint8Array([0xaa]), O(0))).toBe(0);
  });

  it("finds a single-byte pattern at a non-zero offset", () => {
    expect(findBytes(buf(0x00, 0xbb, 0xcc), new Uint8Array([0xbb]), O(0))).toBe(1);
  });

  it("finds a multi-byte pattern", () => {
    expect(findBytes(buf(0x00, 0x25, 0x50, 0x44, 0x46), new Uint8Array([0x25, 0x50, 0x44, 0x46]), O(0))).toBe(1);
  });

  it("finds a pattern at the very end of the buffer", () => {
    expect(findBytes(buf(0x00, 0x00, 0xff), new Uint8Array([0xff]), O(0))).toBe(2);
  });

  it("returns null when pattern is not present", () => {
    expect(findBytes(buf(0x01, 0x02, 0x03), new Uint8Array([0xff]), O(0))).toBeNull();
  });

  it("returns null when starting after the only match", () => {
    // Pattern [0xAA,0xBB] appears only at offset 0.
    // Starting at offset 1, maxSearchEnd = 1 + (4-2) = 3 → loop stays in bounds.
    expect(findBytes(buf(0xaa, 0xbb, 0xcc, 0xdd), new Uint8Array([0xaa, 0xbb]), O(1))).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(findBytes(zeroBuf(0), new Uint8Array([0x01]), O(0))).toBeNull();
  });

  it("finds pattern that matches at startOffset itself", () => {
    expect(findBytes(buf(0x00, 0xaa, 0xbb), new Uint8Array([0xaa, 0xbb]), O(1))).toBe(1);
  });

  it("returns first occurrence when pattern appears multiple times", () => {
    expect(findBytes(buf(0xaa, 0xbb, 0xaa, 0xbb), new Uint8Array([0xaa, 0xbb]), O(0))).toBe(0);
  });

  it("uses offset 0 by default (no startOffset argument)", () => {
    expect(findBytes(buf(0xde, 0xad), new Uint8Array([0xde]))).toBe(0);
  });

  it("pattern longer than buffer → returns null", () => {
    expect(findBytes(buf(0x01), new Uint8Array([0x01, 0x02]), O(0))).toBeNull();
  });

  it("throws OUT_OF_BOUNDS for startOffset beyond buffer", () => {
    expect(() => findBytes(buf(0x01), new Uint8Array([0x01]), O(5))).toThrowError(BufferError);
  });
});

// compareBytes

describe("compareBytes", () => {
  it("returns true when bytes at offset match the expected array", () => {
    expect(compareBytes(buf(0x25, 0x50, 0x44, 0x46), O(0), new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(true);
  });

  it("returns false when bytes do not match", () => {
    expect(compareBytes(buf(0x25, 0x50, 0x00, 0x46), O(0), new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });

  it("returns true for a single-byte match", () => {
    expect(compareBytes(buf(0xaa), O(0), new Uint8Array([0xaa]))).toBe(true);
  });

  it("returns false for a single-byte mismatch", () => {
    expect(compareBytes(buf(0xaa), O(0), new Uint8Array([0xbb]))).toBe(false);
  });

  it("returns true for empty expected array (vacuously true)", () => {
    expect(compareBytes(buf(0x01, 0x02), O(0), new Uint8Array([]))).toBe(true);
  });

  it("compares at a non-zero offset correctly", () => {
    expect(compareBytes(buf(0x00, 0xaa, 0xbb), O(1), new Uint8Array([0xaa, 0xbb]))).toBe(true);
  });

  it("returns false when expected extends beyond buffer", () => {
    expect(compareBytes(buf(0x01, 0x02), O(1), new Uint8Array([0x02, 0x03]))).toBe(false);
  });

  it("returns false when offset is at the end of buffer and expected is non-empty", () => {
    expect(compareBytes(buf(0x01), O(1), new Uint8Array([0x01]))).toBe(false);
  });

  it("matches the last byte of the buffer", () => {
    expect(compareBytes(buf(0x00, 0xff), O(1), new Uint8Array([0xff]))).toBe(true);
  });

  it("returns false on first byte mismatch even if rest matches", () => {
    expect(compareBytes(buf(0x00, 0xbb, 0xcc), O(0), new Uint8Array([0xaa, 0xbb, 0xcc]))).toBe(false);
  });
});

// swapEndian16

describe("swapEndian16", () => {
  it("swaps 0x0102 → 0x0201", () => {
    expect(swapEndian16(0x0102)).toBe(0x0201);
  });

  it("swaps 0xFF00 → 0x00FF", () => {
    expect(swapEndian16(0xff00)).toBe(0x00ff);
  });

  it("swaps 0x00FF → 0xFF00", () => {
    expect(swapEndian16(0x00ff)).toBe(0xff00);
  });

  it("0x0000 → 0x0000 (identity)", () => {
    expect(swapEndian16(0x0000)).toBe(0x0000);
  });

  it("0xFFFF → 0xFFFF (palindrome)", () => {
    expect(swapEndian16(0xffff)).toBe(0xffff);
  });

  it("0x0100 → 0x0001", () => {
    expect(swapEndian16(0x0100)).toBe(0x0001);
  });

  it("is its own inverse: swapping twice returns the original", () => {
    const values = [0x1234, 0xabcd, 0x00ff, 0xff00];
    for (const v of values) {
      expect(swapEndian16(swapEndian16(v))).toBe(v);
    }
  });

  it("result is always a 16-bit value (no bits above 0xFFFF)", () => {
    const result = swapEndian16(0xffff);
    expect(result & 0xffff).toBe(result);
  });
});

// swapEndian32

describe("swapEndian32", () => {
  it("swaps 0x01020304 → 0x04030201", () => {
    expect(swapEndian32(0x01020304)).toBe(0x04030201);
  });

  it("swaps 0xFF000000 → 0x000000FF", () => {
    expect(swapEndian32(0xff000000)).toBe(0x000000ff);
  });

  it("swaps 0x000000FF → 0xFF000000", () => {
    // 0xFF000000 in JS is -16777216 (signed 32-bit)
    expect(swapEndian32(0x000000ff)).toBe(0xff000000 | 0);
  });

  it("0x00000000 → 0x00000000", () => {
    expect(swapEndian32(0x00000000)).toBe(0x00000000);
  });

  it("0xFFFFFFFF → 0xFFFFFFFF (palindrome)", () => {
    expect(swapEndian32(0xffffffff)).toBe(0xffffffff | 0);
  });

  it("swaps 0xDEADBEEF → 0xEFBEADDE", () => {
    expect(swapEndian32(0xdeadbeef)).toBe(0xefbeadde | 0);
  });

  it("is its own inverse: swapping twice returns the original", () => {
    const values = [0x12345678, 0xaabbccdd, 0x00ff00ff];
    for (const v of values) {
      expect(swapEndian32(swapEndian32(v))).toBe(v | 0);
    }
  });
});

// isEmpty

describe("isEmpty", () => {
  it("returns true for a 0-byte buffer", () => {
    expect(isEmpty(zeroBuf(0))).toBe(true);
  });

  it("returns false for a 1-byte buffer", () => {
    expect(isEmpty(zeroBuf(1))).toBe(false);
  });

  it("returns false for a 256-byte buffer", () => {
    expect(isEmpty(zeroBuf(256))).toBe(false);
  });

  it("returns false after writing a single byte", () => {
    expect(isEmpty(buf(0x00))).toBe(false);
  });
});

// remainingBytes

describe("remainingBytes", () => {
  it("returns byteLength when fromOffset is 0", () => {
    expect(remainingBytes(zeroBuf(16), O(0))).toBe(16);
  });

  it("returns byteLength - offset for a mid-buffer offset", () => {
    expect(remainingBytes(zeroBuf(16), O(6))).toBe(10);
  });

  it("returns 1 for the last byte position", () => {
    expect(remainingBytes(zeroBuf(4), O(3))).toBe(1);
  });

  it("returns 0 when fromOffset equals byteLength", () => {
    expect(remainingBytes(zeroBuf(4), O(4))).toBe(0);
  });

  it("returns 0 when fromOffset exceeds byteLength", () => {
    expect(remainingBytes(zeroBuf(4), O(100))).toBe(0);
  });

  it("returns 0 for an empty buffer at offset 0", () => {
    expect(remainingBytes(zeroBuf(0), O(0))).toBe(0);
  });

  it("returns the full length for a 1-byte buffer at offset 0", () => {
    expect(remainingBytes(zeroBuf(1), O(0))).toBe(1);
  });
});

// assertInBounds (tested indirectly via every reader)

describe("assertInBounds (indirectly, via reader calls)", () => {
  it("thrown BufferError has code OUT_OF_BOUNDS", () => {
    try {
      readUint8(zeroBuf(0), O(0));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BufferError);
      expect((e as BufferError).code).toBe("OUT_OF_BOUNDS");
    }
  });

  it("error message contains the out-of-range offset and buffer length", () => {
    try {
      readUint32(buf(0x01, 0x02), O(0));
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as BufferError).message).toMatch(/0/); // offset
      expect((e as BufferError).message).toMatch(/2/); // byteLength
    }
  });

  it("reading exactly at byteLength - 1 with readUint8 does NOT throw", () => {
    expect(() => readUint8(buf(0xaa, 0xbb), O(1))).not.toThrow();
  });

  it("reading exactly at byteLength throws", () => {
    expect(() => readUint8(buf(0xaa, 0xbb), O(2))).toThrowError(BufferError);
  });
});

// Integration: mixed reads on a realistic binary structure

describe("Integration: reading a structured binary blob", () => {
  /**
   * Simulated binary structure (20 bytes):
   *   [0]     magic:    4 bytes  → 0x89 0x50 0x4E 0x47  (PNG-like)
   *   [4]     version:  uint8    → 0x01
   *   [5]     flags:    uint8    → 0x00
   *   [6]     count:    uint16le → 0x0005  (5)
   *   [8]     offset:   uint32le → 0x0000000C (12)
   *   [12]    size:     uint32be → 0x00000008
   *   [16]    checksum: uint32le → 0xDEADBEEF
   */
  const MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const structBuf = (): BinaryBuffer => {
    const ab = new ArrayBuffer(20);
    const v = new DataView(ab);
    new Uint8Array(ab).set(MAGIC, 0); // magic
    v.setUint8(4, 0x01); // version
    v.setUint8(5, 0x00); // flags
    v.setUint16(6, 5, true); // count LE
    v.setUint32(8, 12, true); // offset LE
    v.setUint32(12, 8, false); // size BE
    v.setUint32(16, 0xdeadbeef, true); // checksum LE
    return loadBuffer(ab);
  };

  it("magic bytes match via compareBytes", () => {
    expect(compareBytes(structBuf(), O(0), MAGIC)).toBe(true);
  });

  it("magic bytes are found via findBytes", () => {
    expect(findBytes(structBuf(), MAGIC, O(0))).toBe(0);
  });

  it("readMagic returns the first 4 bytes", () => {
    expect(Array.from(readMagic(structBuf(), B(4)))).toEqual(Array.from(MAGIC));
  });

  it("version (uint8 at offset 4) is 1", () => {
    expect(readUint8(structBuf(), O(4))).toBe(0x01);
  });

  it("flags (int8 at offset 5) is 0", () => {
    expect(readInt8(structBuf(), O(5))).toBe(0);
  });

  it("count (uint16le at offset 6) is 5", () => {
    expect(readUint16(structBuf(), O(6))).toBe(5);
  });

  it("offset field (uint32le at offset 8) is 12", () => {
    expect(readUint32(structBuf(), O(8))).toBe(12);
  });

  it("size field (uint32be at offset 12) is 8", () => {
    expect(readUint32(structBuf(), O(12), false)).toBe(8);
  });

  it("checksum (uint32le at offset 16) is 0xDEADBEEF", () => {
    expect(readUint32(structBuf(), O(16))).toBe(0xdeadbeef);
  });

  it("remainingBytes at offset 16 is 4 (checksum field)", () => {
    expect(remainingBytes(structBuf(), O(16))).toBe(4);
  });

  it("readBytes extracts the last 4 bytes (checksum) correctly", () => {
    const bytes = Array.from(readBytes(structBuf(), O(16), B(4)));
    expect(bytes).toEqual([0xef, 0xbe, 0xad, 0xde]); // LE layout of 0xDEADBEEF
  });

  it("swapEndian32 of checksum produces BE representation", () => {
    const checksum = readUint32(structBuf(), O(16)); // LE
    expect(swapEndian32(checksum)).toBe(0xefbeadde | 0);
  });

  it("isEmpty returns false for the struct buffer", () => {
    expect(isEmpty(structBuf())).toBe(false);
  });
});
