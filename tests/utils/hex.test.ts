/**
 * @file Comprehensive Vitest tests for hex conversion and formatting utilities.
 * Covers every exported function with boundary cases, happy paths, and edge cases.
 */

import { describe, it, expect } from "vitest";
import { formatOffset, formatOffsetHex, byteToHex, byteToDec, formatByteStatus, parseHex, sliceRows, totalRows, bytesToHexString, hexStringToBytes, interpretBytes, formatSize } from "../../src/utils/hex";

// Helpers

const u8 = (...bytes: number[]) => new Uint8Array(bytes);

// formatOffset

describe("formatOffset", () => {
  it("formats 0 as '00000000'", () => {
    expect(formatOffset(0)).toBe("00000000");
  });

  it("formats 16 (0x10) as '00000010'", () => {
    expect(formatOffset(16)).toBe("00000010");
  });

  it("formats 255 (0xFF) as '000000FF'", () => {
    expect(formatOffset(255)).toBe("000000FF");
  });

  it("formats 0xDEADBEEF correctly", () => {
    expect(formatOffset(0xdeadbeef)).toBe("DEADBEEF");
  });

  it("always returns exactly 8 characters", () => {
    [0, 1, 255, 256, 0xffff, 0xffffff, 0xffffffff].forEach((n) => {
      expect(formatOffset(n)).toHaveLength(8);
    });
  });

  it("always returns uppercase hex", () => {
    expect(formatOffset(0xabcdef12)).toBe("ABCDEF12");
  });

  it("pads small values with leading zeros", () => {
    expect(formatOffset(1)).toBe("00000001");
    expect(formatOffset(0xf)).toBe("0000000F");
  });

  it("formats 0x00001000 correctly", () => {
    expect(formatOffset(0x1000)).toBe("00001000");
  });
});

// formatOffsetHex
describe("formatOffsetHex", () => {
  it("formats 16 (0x10) as '0x000010'", () => {
    expect(formatOffsetHex(16)).toBe("0x000010");
  });

  it("formats 0 as '0x000000'", () => {
    expect(formatOffsetHex(0)).toBe("0x000000");
  });

  it("formats 0xFFFFFF as '0xFFFFFF'", () => {
    expect(formatOffsetHex(0xffffff)).toBe("0xFFFFFF");
  });

  it("always starts with '0x'", () => {
    [0, 1, 255, 0xabcd].forEach((n) => expect(formatOffsetHex(n)).toMatch(/^0x/));
  });

  it("always returns exactly 8 characters total (0x + 6 hex digits)", () => {
    [0, 1, 0xff, 0x1000, 0xffffff].forEach((n) => {
      expect(formatOffsetHex(n)).toHaveLength(8);
    });
  });

  it("hex portion is always uppercase", () => {
    expect(formatOffsetHex(0xabcdef)).toBe("0xABCDEF");
  });

  it("pads small values with leading zeros after 0x", () => {
    expect(formatOffsetHex(1)).toBe("0x000001");
    expect(formatOffsetHex(0xff)).toBe("0x0000FF");
  });
});

// byteToHex
describe("byteToHex", () => {
  it("converts 0 to '00'", () => {
    expect(byteToHex(0)).toBe("00");
  });

  it("converts 255 to 'FF'", () => {
    expect(byteToHex(255)).toBe("FF");
  });

  it("converts 16 to '10'", () => {
    expect(byteToHex(16)).toBe("10");
  });

  it("converts 15 to '0F'", () => {
    expect(byteToHex(15)).toBe("0F");
  });

  it("always returns exactly 2 characters", () => {
    for (let i = 0; i <= 255; i++) {
      expect(byteToHex(i)).toHaveLength(2);
    }
  });

  it("always returns uppercase", () => {
    expect(byteToHex(0xab)).toBe("AB");
    expect(byteToHex(0xcd)).toBe("CD");
  });

  it("applies 0xFF mask: byteToHex(256) → '00'", () => {
    expect(byteToHex(256)).toBe("00");
  });

  it("applies 0xFF mask: byteToHex(-1) → 'FF'", () => {
    expect(byteToHex(-1)).toBe("FF");
  });

  it("applies 0xFF mask: byteToHex(-256) → '00'", () => {
    expect(byteToHex(-256)).toBe("00");
  });

  it("applies 0xFF mask: byteToHex(511) → 'FF' (511 & 0xFF = 255)", () => {
    expect(byteToHex(511)).toBe("FF");
  });

  it("maps all 256 in-range values correctly (spot checks)", () => {
    expect(byteToHex(0x41)).toBe("41");
    expect(byteToHex(0x7f)).toBe("7F");
    expect(byteToHex(0x80)).toBe("80");
  });
});

// byteToDec
describe("byteToDec", () => {
  it("converts 255 to '255'", () => {
    expect(byteToDec(255)).toBe("255");
  });

  it("converts 0 to '0'", () => {
    expect(byteToDec(0)).toBe("0");
  });

  it("converts 128 to '128'", () => {
    expect(byteToDec(128)).toBe("128");
  });

  it("applies 0xFF mask: byteToDec(256) → '0'", () => {
    expect(byteToDec(256)).toBe("0");
  });

  it("applies 0xFF mask: byteToDec(-1) → '255'", () => {
    expect(byteToDec(-1)).toBe("255");
  });

  it("applies 0xFF mask: byteToDec(511) → '255'", () => {
    expect(byteToDec(511)).toBe("255");
  });

  it("returns a decimal string (no hex chars)", () => {
    for (let i = 0; i <= 255; i++) {
      expect(byteToDec(i)).toMatch(/^\d+$/);
    }
  });

  it("result is always in range '0'–'255' as numeric string", () => {
    for (let i = 0; i <= 255; i++) {
      const n = Number(byteToDec(i));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(255);
    }
  });
});

// formatByteStatus
describe("formatByteStatus", () => {
  it("formats 0xFF as '0xFF · 255'", () => {
    expect(formatByteStatus(0xff)).toBe("0xFF · 255");
  });

  it("formats 0x00 as '0x00 · 0'", () => {
    expect(formatByteStatus(0x00)).toBe("0x00 · 0");
  });

  it("formats 0x41 ('A') as '0x41 · 65'", () => {
    expect(formatByteStatus(0x41)).toBe("0x41 · 65");
  });

  it("formats 0x10 as '0x10 · 16'", () => {
    expect(formatByteStatus(0x10)).toBe("0x10 · 16");
  });

  it("hex part is always uppercase", () => {
    expect(formatByteStatus(0xab)).toContain("0xAB");
  });

  it("applies mask for out-of-range input (256 → same as 0)", () => {
    expect(formatByteStatus(256)).toBe("0x00 · 0");
  });

  it("always contains the separator ' · '", () => {
    [0, 127, 255].forEach((b) => expect(formatByteStatus(b)).toContain(" · "));
  });

  it("hex and decimal parts are consistent with byteToHex/byteToDec", () => {
    for (let b = 0; b <= 255; b += 17) {
      const expected = `0x${byteToHex(b)} · ${byteToDec(b)}`;
      expect(formatByteStatus(b)).toBe(expected);
    }
  });
});

// parseHex
describe("parseHex", () => {
  it("parses 'FF' → 255", () => {
    expect(parseHex("FF")).toBe(255);
  });

  it("parses '0x1F4' → 500", () => {
    expect(parseHex("0x1F4")).toBe(500);
  });

  it("parses '0' → 0", () => {
    expect(parseHex("0")).toBe(0);
  });

  it("parses lowercase 'ff' → 255", () => {
    expect(parseHex("ff")).toBe(255);
  });

  it("parses mixed case '0xFF' → 255", () => {
    expect(parseHex("0xFF")).toBe(255);
  });

  it("parses '0x0' → 0", () => {
    expect(parseHex("0x0")).toBe(0);
  });

  it("parses 'DEADBEEF' → correct number", () => {
    expect(parseHex("DEADBEEF")).toBe(0xdeadbeef);
  });

  it("strips surrounding whitespace: '  FF  ' → 255", () => {
    expect(parseHex("  FF  ")).toBe(255);
  });

  it("strips 0X prefix (uppercase X)", () => {
    expect(parseHex("0X1F")).toBe(31);
  });

  it("returns null for empty string ''", () => {
    expect(parseHex("")).toBeNull();
  });

  it("returns null for whitespace-only '   '", () => {
    expect(parseHex("   ")).toBeNull();
  });

  it("returns null for 'ZZ' (non-hex chars)", () => {
    expect(parseHex("ZZ")).toBeNull();
  });

  it("returns null for 'GG'", () => {
    expect(parseHex("GG")).toBeNull();
  });

  it("returns null for '12GH' (partial invalid)", () => {
    expect(parseHex("12GH")).toBeNull();
  });

  it("returns null for '0xZZ'", () => {
    expect(parseHex("0xZZ")).toBeNull();
  });

  it("returns null for '0x' alone (no hex digits after prefix)", () => {
    expect(parseHex("0x")).toBeNull();
  });

  it("returns a number (not null) for single digit '1'", () => {
    expect(parseHex("1")).toBe(1);
  });

  it("parses 'A' → 10", () => {
    expect(parseHex("A")).toBe(10);
  });

  it("never returns NaN", () => {
    const inputs = ["FF", "0x1F", "", "ZZ", "0x"];
    for (const inp of inputs) {
      const result = parseHex(inp);
      if (result !== null) expect(Number.isNaN(result)).toBe(false);
    }
  });
});

// sliceRows
describe("sliceRows", () => {
  const buf16 = new Uint8Array(Array.from({ length: 16 }, (_, i) => i)); // 0x00–0x0F

  it("returns empty array when startRow >= totalRows", () => {
    expect(sliceRows(buf16, 16, 1, 2)).toEqual([]); // only 1 row total
  });

  it("returns empty array when startRow >= endRow", () => {
    expect(sliceRows(buf16, 16, 0, 0)).toEqual([]);
  });

  it("returns empty array for empty buffer", () => {
    expect(sliceRows(new Uint8Array(0), 16, 0, 1)).toEqual([]);
  });

  it("returns correct single row for a 16-byte buffer with cols=16", () => {
    const rows = sliceRows(buf16, 16, 0, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.offset).toBe(0);
    expect(rows[0]!.bytes).toBeInstanceOf(Uint8Array);
    expect(rows[0]!.bytes.length).toBe(16);
  });

  it("row offset = rowIndex * cols", () => {
    const buf = new Uint8Array(64);
    const rows = sliceRows(buf, 16, 0, 4);
    expect(rows[0]!.offset).toBe(0);
    expect(rows[1]!.offset).toBe(16);
    expect(rows[2]!.offset).toBe(32);
    expect(rows[3]!.offset).toBe(48);
  });

  it("clamps endRow to totalRows (no out-of-bounds rows)", () => {
    const buf = new Uint8Array(32);
    // totalRows = 2 with cols=16; endRow=100 should be clamped to 2
    const rows = sliceRows(buf, 16, 0, 100);
    expect(rows).toHaveLength(2);
  });

  it("last row has correct partial length when buffer is not divisible by cols", () => {
    const buf = new Uint8Array(20); // 1 full row of 16 + 4-byte tail
    const rows = sliceRows(buf, 16, 0, 2);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.bytes.length).toBe(4);
    expect(rows[1]!.offset).toBe(16);
  });

  it("subarray shares the same underlying buffer (zero-copy)", () => {
    const buf = new Uint8Array(32).fill(0xab);
    const rows = sliceRows(buf, 16, 0, 1);
    // Modifying the original buffer reflects in the row's bytes (subarray is a view)
    buf[0] = 0xff;
    expect(rows[0]!.bytes[0]).toBe(0xff);
  });

  it("generates only the requested window [startRow, endRow)", () => {
    const buf = new Uint8Array(64);
    const rows = sliceRows(buf, 16, 1, 3); // rows at index 1 and 2
    expect(rows).toHaveLength(2);
    expect(rows[0]!.offset).toBe(16);
    expect(rows[1]!.offset).toBe(32);
  });

  it("works with cols=8", () => {
    const buf = new Uint8Array(16);
    const rows = sliceRows(buf, 8, 0, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.bytes.length).toBe(8);
    expect(rows[1]!.bytes.length).toBe(8);
  });

  it("works with cols=32", () => {
    const buf = new Uint8Array(64);
    const rows = sliceRows(buf, 32, 0, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.offset).toBe(0);
    expect(rows[1]!.offset).toBe(32);
  });

  it("each row bytes contains the correct byte values", () => {
    const buf = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const rows = sliceRows(buf, 2, 0, 2);
    expect(Array.from(rows[0]!.bytes)).toEqual([0xaa, 0xbb]);
    expect(Array.from(rows[1]!.bytes)).toEqual([0xcc, 0xdd]);
  });
});

// totalRows
describe("totalRows", () => {
  it("0 bytes → 0 rows", () => {
    expect(totalRows(0, 16)).toBe(0);
  });

  it("exactly divisible: 256 bytes / 16 cols = 16 rows", () => {
    expect(totalRows(256, 16)).toBe(16);
  });

  it("not divisible: 17 bytes / 16 cols = 2 rows", () => {
    expect(totalRows(17, 16)).toBe(2);
  });

  it("1 byte → 1 row", () => {
    expect(totalRows(1, 16)).toBe(1);
  });

  it("16 bytes / 16 cols = 1 row", () => {
    expect(totalRows(16, 16)).toBe(1);
  });

  it("1024 bytes / 32 cols = 32 rows", () => {
    expect(totalRows(1024, 32)).toBe(32);
  });

  it("1 byte / 1 col = 1 row", () => {
    expect(totalRows(1, 1)).toBe(1);
  });

  it("15 bytes / 16 cols = 1 row (partial last row)", () => {
    expect(totalRows(15, 16)).toBe(1);
  });

  it("cols=8: 24 bytes → 3 rows", () => {
    expect(totalRows(24, 8)).toBe(3);
  });
});

// bytesToHexString
describe("bytesToHexString", () => {
  it("converts [0x25, 0x50, 0x44] → '25 50 44'", () => {
    expect(bytesToHexString(u8(0x25, 0x50, 0x44))).toBe("25 50 44");
  });

  it("converts empty array → ''", () => {
    expect(bytesToHexString(u8())).toBe("");
  });

  it("single byte [0x00] → '00'", () => {
    expect(bytesToHexString(u8(0x00))).toBe("00");
  });

  it("single byte [0xFF] → 'FF'", () => {
    expect(bytesToHexString(u8(0xff))).toBe("FF");
  });

  it("bytes are separated by single spaces", () => {
    const result = bytesToHexString(u8(0x01, 0x02, 0x03));
    expect(result.split(" ")).toHaveLength(3);
  });

  it("all hex digits are uppercase", () => {
    expect(bytesToHexString(u8(0xab, 0xcd, 0xef))).toBe("AB CD EF");
  });

  it("accepts a plain number array as well as Uint8Array", () => {
    expect(bytesToHexString([0x41, 0x42])).toBe("41 42");
  });

  it("round-trips with hexStringToBytes", () => {
    const original = u8(0xde, 0xad, 0xbe, 0xef);
    const hexStr = bytesToHexString(original);
    const recovered = hexStringToBytes(hexStr);
    expect(recovered).not.toBeNull();
    expect(Array.from(recovered!)).toEqual(Array.from(original));
  });
});

// hexStringToBytes
describe("hexStringToBytes", () => {
  it("converts '25 50 44' → Uint8Array([37, 80, 68])", () => {
    const result = hexStringToBytes("25 50 44");
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0x25, 0x50, 0x44]);
  });

  it("returns null for empty string", () => {
    expect(hexStringToBytes("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(hexStringToBytes("   ")).toBeNull();
  });

  it("returns null for non-hex token ('ZZ 00')", () => {
    expect(hexStringToBytes("ZZ 00")).toBeNull();
  });

  it("returns null for token with more than 2 hex chars ('ABC')", () => {
    expect(hexStringToBytes("ABC")).toBeNull();
  });

  it("handles single byte '41' → Uint8Array([0x41])", () => {
    const result = hexStringToBytes("41");
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0x41]);
  });

  it("handles lowercase hex 'ff 00 ab'", () => {
    const result = hexStringToBytes("ff 00 ab");
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0xff, 0x00, 0xab]);
  });

  it("handles mixed case 'fF 0A'", () => {
    const result = hexStringToBytes("fF 0A");
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0xff, 0x0a]);
  });

  it("handles extra spaces between tokens '  FF   00  '", () => {
    const result = hexStringToBytes("  FF   00  ");
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0xff, 0x00]);
  });

  it("handles single-character token 'F' (valid 1-hex-char token)", () => {
    const result = hexStringToBytes("F");
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0x0f]);
  });

  it("returns null for token with invalid character mid-string ('1G')", () => {
    expect(hexStringToBytes("1G")).toBeNull();
  });

  it("returns Uint8Array instance (not plain Array)", () => {
    const result = hexStringToBytes("41 42");
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("round-trips with bytesToHexString for all-256-byte buffer", () => {
    const original = new Uint8Array(256).map((_, i) => i);
    const hexStr = bytesToHexString(original);
    const recovered = hexStringToBytes(hexStr);
    expect(recovered).not.toBeNull();
    expect(Array.from(recovered!)).toEqual(Array.from(original));
  });
});

// interpretBytes
describe("interpretBytes", () => {
  // Empty / insufficient bytes

  describe("empty array → all fields null", () => {
    const r = interpretBytes(u8());

    it("uint8 is null", () => expect(r.uint8).toBeNull());
    it("int8 is null", () => expect(r.int8).toBeNull());
    it("uint16le is null", () => expect(r.uint16le).toBeNull());
    it("uint32le is null", () => expect(r.uint32le).toBeNull());
    it("float64le is null", () => expect(r.float64le).toBeNull());
    it("uint64le is null", () => expect(r.uint64le).toBeNull());
  });

  describe("1-byte array → only uint8/int8 non-null", () => {
    const r = interpretBytes(u8(0xff));

    it("uint8 is 255", () => expect(r.uint8).toBe(255));
    it("int8 is -1", () => expect(r.int8).toBe(-1));
    it("uint16le is null", () => expect(r.uint16le).toBeNull());
    it("uint32le is null", () => expect(r.uint32le).toBeNull());
    it("float32le is null", () => expect(r.float32le).toBeNull());
    it("uint64le is null", () => expect(r.uint64le).toBeNull());
  });

  describe("2-byte array → 16-bit fields non-null, 32/64-bit null", () => {
    const r = interpretBytes(u8(0x01, 0x00));

    it("uint16le = 1 (little-endian 0x0001)", () => expect(r.uint16le).toBe(1));
    it("uint16be = 256 (big-endian 0x0100)", () => expect(r.uint16be).toBe(256));
    it("int16le = 1", () => expect(r.int16le).toBe(1));
    it("int16be = 256", () => expect(r.int16be).toBe(256));
    it("uint32le is null", () => expect(r.uint32le).toBeNull());
    it("uint64le is null", () => expect(r.uint64le).toBeNull());
  });

  // uint8 / int8

  describe("uint8 / int8", () => {
    it("uint8: 0x00 → 0", () => {
      expect(interpretBytes(u8(0x00)).uint8).toBe(0);
    });

    it("uint8: 0xFF → 255", () => {
      expect(interpretBytes(u8(0xff)).uint8).toBe(255);
    });

    it("int8: 0x7F → 127 (max positive)", () => {
      expect(interpretBytes(u8(0x7f)).int8).toBe(127);
    });

    it("int8: 0x80 → -128 (min negative)", () => {
      expect(interpretBytes(u8(0x80)).int8).toBe(-128);
    });

    it("int8: 0xFF → -1", () => {
      expect(interpretBytes(u8(0xff)).int8).toBe(-1);
    });
  });

  // uint16 / int16

  describe("uint16le / uint16be / int16", () => {
    it("uint16le: [0xFF, 0x00] → 255", () => {
      expect(interpretBytes(u8(0xff, 0x00)).uint16le).toBe(255);
    });

    it("uint16be: [0x00, 0xFF] → 255", () => {
      expect(interpretBytes(u8(0x00, 0xff)).uint16be).toBe(255);
    });

    it("uint16le: [0xFF, 0xFF] → 65535", () => {
      expect(interpretBytes(u8(0xff, 0xff)).uint16le).toBe(65535);
    });

    it("int16le: [0xFF, 0xFF] → -1", () => {
      expect(interpretBytes(u8(0xff, 0xff)).int16le).toBe(-1);
    });

    it("int16be: [0x80, 0x00] → -32768 (min int16)", () => {
      expect(interpretBytes(u8(0x80, 0x00)).int16be).toBe(-32768);
    });

    it("int16le: [0x00, 0x80] → -32768", () => {
      expect(interpretBytes(u8(0x00, 0x80)).int16le).toBe(-32768);
    });

    it("byte order differs: LE vs BE give different results for [0x01, 0x02]", () => {
      const r = interpretBytes(u8(0x01, 0x02));
      expect(r.uint16le).toBe(0x0201); // 513
      expect(r.uint16be).toBe(0x0102); // 258
    });
  });

  // uint32 / int32

  describe("uint32 / int32", () => {
    it("uint32le: [0x01,0x00,0x00,0x00] → 1", () => {
      expect(interpretBytes(u8(0x01, 0x00, 0x00, 0x00)).uint32le).toBe(1);
    });

    it("uint32be: [0x00,0x00,0x00,0x01] → 1", () => {
      expect(interpretBytes(u8(0x00, 0x00, 0x00, 0x01)).uint32be).toBe(1);
    });

    it("uint32le: [0xFF,0xFF,0xFF,0xFF] → 4294967295", () => {
      expect(interpretBytes(u8(0xff, 0xff, 0xff, 0xff)).uint32le).toBe(4294967295);
    });

    it("int32le: [0xFF,0xFF,0xFF,0xFF] → -1", () => {
      expect(interpretBytes(u8(0xff, 0xff, 0xff, 0xff)).int32le).toBe(-1);
    });

    it("int32be: [0x80,0x00,0x00,0x00] → -2147483648 (min int32)", () => {
      expect(interpretBytes(u8(0x80, 0x00, 0x00, 0x00)).int32be).toBe(-2147483648);
    });

    it("int32le: [0x00,0x00,0x00,0x80] → -2147483648", () => {
      expect(interpretBytes(u8(0x00, 0x00, 0x00, 0x80)).int32le).toBe(-2147483648);
    });
  });

  // float32

  describe("float32le / float32be", () => {
    it("float32le: [0x00,0x00,0x80,0x3F] → 1.0", () => {
      expect(interpretBytes(u8(0x00, 0x00, 0x80, 0x3f)).float32le).toBeCloseTo(1.0, 5);
    });

    it("float32be: [0x3F,0x80,0x00,0x00] → 1.0", () => {
      expect(interpretBytes(u8(0x3f, 0x80, 0x00, 0x00)).float32be).toBeCloseTo(1.0, 5);
    });

    it("float32le: [0x00,0x00,0x00,0x00] → 0.0", () => {
      expect(interpretBytes(u8(0x00, 0x00, 0x00, 0x00)).float32le).toBe(0.0);
    });

    it("float32le: [0x00,0x00,0x80,0xBF] → -1.0", () => {
      expect(interpretBytes(u8(0x00, 0x00, 0x80, 0xbf)).float32le).toBeCloseTo(-1.0, 5);
    });

    it("float32le: IEEE NaN bytes → NaN", () => {
      // 0x7FC00000 = canonical float32 NaN
      const result = interpretBytes(u8(0x00, 0x00, 0xc0, 0x7f)).float32le;
      expect(result).not.toBeNull();
      expect(Number.isNaN(result!)).toBe(true);
    });

    it("float32le: Infinity bytes [0x00,0x00,0x80,0x7F]", () => {
      const result = interpretBytes(u8(0x00, 0x00, 0x80, 0x7f)).float32le;
      expect(result).toBe(Infinity);
    });
  });

  // float64

  describe("float64le / float64be", () => {
    it("float64le: 8-byte IEEE 1.0 LE → 1.0", () => {
      // IEEE 754 double 1.0 = 3FF0000000000000 in BE → LE bytes reversed
      const bytes = u8(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f);
      expect(interpretBytes(bytes).float64le).toBeCloseTo(1.0, 10);
    });

    it("float64be: 8-byte IEEE 1.0 BE → 1.0", () => {
      const bytes = u8(0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
      expect(interpretBytes(bytes).float64be).toBeCloseTo(1.0, 10);
    });

    it("float64le: all-zeros → 0.0", () => {
      expect(interpretBytes(new Uint8Array(8)).float64le).toBe(0.0);
    });

    it("float64 is null for 7-byte array", () => {
      expect(interpretBytes(new Uint8Array(7)).float64le).toBeNull();
    });
  });

  // uint64 / int64 (BigInt)

  describe("uint64le / uint64be / int64", () => {
    it("uint64le: [0x01,0x00,…,0x00] → 1n", () => {
      const buf = new Uint8Array(8);
      buf[0] = 0x01;
      expect(interpretBytes(buf).uint64le).toBe(1n);
    });

    it("uint64be: [0x00,…,0x00,0x01] → 1n", () => {
      const buf = new Uint8Array(8);
      buf[7] = 0x01;
      expect(interpretBytes(buf).uint64be).toBe(1n);
    });

    it("uint64le: all-0xFF → 18446744073709551615n (max uint64)", () => {
      expect(interpretBytes(new Uint8Array(8).fill(0xff)).uint64le).toBe(18446744073709551615n);
    });

    it("int64le: all-0xFF → -1n", () => {
      expect(interpretBytes(new Uint8Array(8).fill(0xff)).int64le).toBe(-1n);
    });

    it("int64be: [0x80,0x00,…,0x00] → min int64", () => {
      const buf = new Uint8Array(8);
      buf[0] = 0x80;
      expect(interpretBytes(buf).int64be).toBe(-9223372036854775808n);
    });

    it("uint64 fields return bigint type", () => {
      const buf = new Uint8Array(8).fill(0x01);
      const r = interpretBytes(buf);
      expect(typeof r.uint64le).toBe("bigint");
      expect(typeof r.uint64be).toBe("bigint");
      expect(typeof r.int64le).toBe("bigint");
      expect(typeof r.int64be).toBe("bigint");
    });

    it("uint64 is null for 7-byte array", () => {
      expect(interpretBytes(new Uint8Array(7)).uint64le).toBeNull();
    });
  });

  // Independence of bytes.slice()

  it("uses a copy of the bytes (mutating input after call does not affect result)", () => {
    const bytes = u8(0x01, 0x00, 0x00, 0x00);
    const result = interpretBytes(bytes);
    bytes[0] = 0xff; // mutate original
    // result was based on a copy, so uint32le should still be 1
    expect(result.uint32le).toBe(1);
  });
});

// formatSize
describe("formatSize", () => {
  it("0 → '0 B'", () => {
    expect(formatSize(0)).toBe("0 B");
  });

  it("1 → '1 B'", () => {
    expect(formatSize(1)).toBe("1 B");
  });

  it("500 → '500 B'", () => {
    expect(formatSize(500)).toBe("500 B");
  });

  it("1023 → '1023 B' (just below KB threshold)", () => {
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("1024 → '1.0 KB'", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
  });

  it("42318 → '41.3 KB'", () => {
    expect(formatSize(42318)).toBe("41.3 KB");
  });

  it("1024 * 1024 - 1 → still KB", () => {
    expect(formatSize(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it("1048576 (1 MB) → '1.0 MB'", () => {
    expect(formatSize(1048576)).toBe("1.0 MB");
  });

  it("1536 * 1024 → '1.5 MB'", () => {
    expect(formatSize(1536 * 1024)).toBe("1.5 MB");
  });

  it("1024 ** 3 - 1 → still MB", () => {
    expect(formatSize(1024 ** 3 - 1)).toMatch(/MB$/);
  });

  it("1024 ** 3 → '1.00 GB'", () => {
    expect(formatSize(1024 ** 3)).toBe("1.00 GB");
  });

  it("1.5 GB", () => {
    expect(formatSize(Math.round(1.5 * 1024 ** 3))).toBe("1.50 GB");
  });

  it("throws RangeError for negative input", () => {
    expect(() => formatSize(-1)).toThrow(RangeError);
    expect(() => formatSize(-1024)).toThrow(RangeError);
  });

  it("KB values have exactly 1 decimal place", () => {
    expect(formatSize(2048)).toMatch(/^\d+\.\d KB$/);
  });

  it("MB values have exactly 1 decimal place", () => {
    expect(formatSize(2 * 1024 * 1024)).toMatch(/^\d+\.\d MB$/);
  });

  it("GB values have exactly 2 decimal places", () => {
    expect(formatSize(2 * 1024 ** 3)).toMatch(/^\d+\.\d{2} GB$/);
  });

  it("boundary: exactly 1024 ** 2 bytes → MB (not KB)", () => {
    expect(formatSize(1024 ** 2)).toMatch(/MB$/);
  });

  it("boundary: exactly 1024 ** 3 bytes → GB (not MB)", () => {
    expect(formatSize(1024 ** 3)).toMatch(/GB$/);
  });
});
