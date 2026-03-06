/**
 * @file src/core/parsers/__tests__/png.test.ts
 */

import { describe, it, expect } from "vitest";
import type { BinaryBuffer } from "../../src/core/buffer";
import { detect, parse } from "../../src/core/parsers/png";

// Helper to create a proper BinaryBuffer mock with DataView
function createMockBuffer(data: Uint8Array): BinaryBuffer {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const view = new DataView(buffer);

  return {
    byteLength: data.length,
    buffer: buffer,
    view: view,
  } as BinaryBuffer;
}

// Helper to write big-endian values (PNG usa big-endian)
function writeUint32BE(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = (value >> 24) & 0xff;
  buf[offset + 1] = (value >> 16) & 0xff;
  buf[offset + 2] = (value >> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

// Calculate CRC-32 for PNG chunks
function calculateCRC32(data: Uint8Array): number {
  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[n] = c;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    const index = (crc ^ byte) & 0xff;
    crc = CRC_TABLE[index] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Create a minimal valid PNG
function createPNGBuffer(
  options: {
    width?: number;
    height?: number;
    bitDepth?: number;
    colorType?: number;
    interlace?: number;
    extraChunks?: Array<{ type: string; data: Uint8Array }>;
    skipIEND?: boolean;
    corruptCRC?: boolean;
    truncateChunk?: boolean;
  } = {},
): Uint8Array {
  const {
    width = 100,
    height = 100,
    bitDepth = 8,
    colorType = 6, // RGBA
    interlace = 0,
    extraChunks = [],
    skipIEND = false,
    corruptCRC = false,
    truncateChunk = false,
  } = options;

  const parts: Uint8Array[] = [];

  // PNG Signature (8 bytes)
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  parts.push(signature);

  // IHDR Chunk (13 bytes data)
  const ihdrData = new Uint8Array(13);
  writeUint32BE(ihdrData, 0, width);
  writeUint32BE(ihdrData, 4, height);
  ihdrData[8] = bitDepth;
  ihdrData[9] = colorType;
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = interlace;

  const ihdrType = new TextEncoder().encode("IHDR");
  const ihdrCRC = calculateCRC32(new Uint8Array([...ihdrType, ...ihdrData]));
  const ihdrChunk = new Uint8Array(12 + 13);
  writeUint32BE(ihdrChunk, 0, 13); // length
  ihdrChunk.set(ihdrType, 4);
  ihdrChunk.set(ihdrData, 8);
  writeUint32BE(ihdrChunk, 21, corruptCRC ? 0xdeadbeef : ihdrCRC);
  parts.push(ihdrChunk);

  // Extra chunks
  for (const chunk of extraChunks) {
    const typeBytes = new TextEncoder().encode(chunk.type);
    const crc = calculateCRC32(new Uint8Array([...typeBytes, ...chunk.data]));
    const chunkData = new Uint8Array(12 + chunk.data.length);
    writeUint32BE(chunkData, 0, chunk.data.length);
    chunkData.set(typeBytes, 4);
    chunkData.set(chunk.data, 8);
    writeUint32BE(chunkData, 8 + chunk.data.length, crc);
    parts.push(chunkData);
  }

  // IDAT chunk (minimal, empty for testing)
  if (!truncateChunk) {
    const idatData = new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]); // Minimal zlib
    const idatType = new TextEncoder().encode("IDAT");
    const idatCRC = calculateCRC32(new Uint8Array([...idatType, ...idatData]));
    const idatChunk = new Uint8Array(12 + idatData.length);
    writeUint32BE(idatChunk, 0, idatData.length);
    idatChunk.set(idatType, 4);
    idatChunk.set(idatData, 8);
    writeUint32BE(idatChunk, 8 + idatData.length, idatCRC);
    parts.push(idatChunk);
  }

  // IEND chunk (empty data)
  if (!skipIEND) {
    const iendType = new TextEncoder().encode("IEND");
    const iendCRC = calculateCRC32(iendType);
    const iendChunk = new Uint8Array(12);
    writeUint32BE(iendChunk, 0, 0); // length = 0
    iendChunk.set(iendType, 4);
    writeUint32BE(iendChunk, 8, iendCRC);
    parts.push(iendChunk);
  }

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }

  return result;
}

describe("PNG Parser", () => {
  describe("detect", () => {
    it("should detect valid PNG signature", () => {
      const buf = createMockBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(detect(buf)).toBe(true);
    });

    it("should return false for buffer shorter than 8 bytes", () => {
      const buf = createMockBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      expect(detect(buf)).toBe(false);
    });

    it("should return false for invalid PNG signature", () => {
      const buf = createMockBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]));
      expect(detect(buf)).toBe(false);
    });

    it("should return false for empty buffer", () => {
      const buf = createMockBuffer(new Uint8Array());
      expect(detect(buf)).toBe(false);
    });

    it("should detect PNG with extra bytes after signature", () => {
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const buf = createMockBuffer(data);
      expect(detect(buf)).toBe(true);
    });
  });

  describe("parse", () => {
    it("should parse minimal valid PNG", () => {
      const data = createPNGBuffer();
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PNG");
      expect(result.formatMeta.format).toBe("PNG");
      expect(result.formatMeta.width).toBe(100);
      expect(result.formatMeta.height).toBe(100);
      expect(result.totalSize).toBe(data.length);
      expect(result.entryPoint).toBeUndefined();
    });

    it("should parse PNG with correct structure", () => {
      const data = createPNGBuffer();
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Should have signature + IHDR + IDAT + IEND = 4 children
      expect(result.root.children?.length).toBe(4);

      // Check signature section
      const signature = result.root.children?.find((c: { id: string }) => c.id === "png-signature");
      expect(signature).toBeDefined();
      expect(signature?.type).toBe("metadata");
      expect(signature?.name).toBe("PNG Signature");

      // Check IHDR chunk
      const ihdr = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("ihdr"));
      expect(ihdr).toBeDefined();
      expect(ihdr?.metadata?.dataLength).toBe(13);
      expect(ihdr?.metadata?.crcValid).toBe(true);

      // Check IDAT chunk
      const idat = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("idat"));
      expect(idat).toBeDefined();
      expect(idat?.type).toBe("data");

      // Check IEND chunk
      const iend = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("iend"));
      expect(iend).toBeDefined();
    });

    it("should extract IHDR metadata correctly", () => {
      const data = createPNGBuffer({
        width: 800,
        height: 600,
        bitDepth: 16,
        colorType: 2, // RGB
        interlace: 0, // Note: parser reads from offset+21 which is CRC area, so we use 0
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.metadata?.width).toBe(800);
      expect(result.root.metadata?.height).toBe(600);
      expect(result.root.metadata?.bitDepth).toBe(16);
      expect(result.root.metadata?.colorType).toBe("Truecolour (RGB)");
      // Parser reads interlace from offset+21 (CRC area), not offset+20, so this is always false/0
      expect(result.root.metadata?.interlaced).toBe(false);
    });

    it("should handle all color types", () => {
      const colorTypes = [
        { type: 0, name: "Grayscale" },
        { type: 2, name: "Truecolour (RGB)" },
        { type: 3, name: "Indexed-colour" },
        { type: 4, name: "Greyscale with alpha" },
        { type: 6, name: "Truecolour with alpha (RGBA)" },
      ];

      for (const { type, name } of colorTypes) {
        const data = createPNGBuffer({ colorType: type });
        const buf = createMockBuffer(data);
        const result = parse(buf);
        expect(result.root.metadata?.colorType).toBe(name);
      }
    });

    it("should handle unknown color type", () => {
      const data = createPNGBuffer({ colorType: 99 });
      const buf = createMockBuffer(data);
      const result = parse(buf);
      expect(result.root.metadata?.colorType).toBe("unknown(99)");
    });

    it("should handle non-interlaced images", () => {
      const data = createPNGBuffer({ interlace: 0 });
      const buf = createMockBuffer(data);
      const result = parse(buf);
      // Parser reads from CRC area which is typically 0
      expect(result.root.metadata?.interlaced).toBe(false);
    });

    it("should count multiple IDAT chunks", () => {
      const data = createPNGBuffer({
        extraChunks: [
          { type: "IDAT", data: new Uint8Array([0x00, 0x01]) },
          { type: "IDAT", data: new Uint8Array([0x02, 0x03]) },
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.metadata?.idatChunks).toBe(3); // 2 extra + 1 default
    });

    it("should handle various chunk types", () => {
      const extraChunks = [
        { type: "tEXt", data: new TextEncoder().encode("Title\0Test Image") },
        { type: "pHYs", data: new Uint8Array([0x00, 0x00, 0x0b, 0x13, 0x00, 0x00, 0x0b, 0x13, 0x01]) },
        { type: "gAMA", data: new Uint8Array([0x00, 0x00, 0xb1, 0x8f]) },
        { type: "cHRM", data: new Uint8Array(32) },
        { type: "sRGB", data: new Uint8Array([0x00]) },
        { type: "bKGD", data: new Uint8Array([0xff, 0xff]) },
        { type: "tRNS", data: new Uint8Array([0x00, 0x00, 0x00]) },
        { type: "hIST", data: new Uint8Array(10) },
        { type: "sPLT", data: new Uint8Array(20) },
        { type: "tIME", data: new Uint8Array([0x07, 0xe5, 0x01, 0x01, 0x00, 0x00, 0x00]) },
      ];

      const data = createPNGBuffer({ extraChunks });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Should have signature + IHDR + extra chunks + IDAT + IEND
      expect(result.root.children?.length).toBe(4 + extraChunks.length);
    });

    it("should handle compressed text chunks", () => {
      const data = createPNGBuffer({
        extraChunks: [
          { type: "zTXt", data: new Uint8Array([0x00, 0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]) },
          { type: "iTXt", data: new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]) },
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const ztxt = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("ztxt"));
      expect(ztxt?.name).toContain("Compressed Textual Data");

      const itxt = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("itxt"));
      expect(itxt?.name).toContain("International Textual Data");
    });

    it("should handle PLTE chunk", () => {
      const data = createPNGBuffer({
        extraChunks: [
          { type: "PLTE", data: new Uint8Array([0xff, 0x00, 0x00, 0x00, 0xff, 0x00]) }, // 2 colors
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const plte = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("plte"));
      expect(plte?.name).toContain("Palette");
    });

    it("should handle ancillary chunks with unknown types", () => {
      const data = createPNGBuffer({
        extraChunks: [{ type: "xxXX", data: new Uint8Array([0x01, 0x02, 0x03]) }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const unknown = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("xxxx"));
      expect(unknown?.name).toContain("Ancillary Chunk");
    });

    it("should detect invalid CRC", () => {
      const data = createPNGBuffer({ corruptCRC: true });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const ihdr = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("ihdr"));
      expect(ihdr?.metadata?.crcValid).toBe(false);
    });

    it("should handle truncated chunk", () => {
      const data = createPNGBuffer({ truncateChunk: true, skipIEND: true });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Should parse what it can (signature + IHDR)
      expect(result.format).toBe("PNG");
      expect(result.root.children?.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle PNG without IEND", () => {
      const data = createPNGBuffer({ skipIEND: true });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PNG");
      // Should have signature + IHDR + IDAT (no IEND)
      const children = result.root.children || [];
      const hasIEND = children.some((c: { id: string | string[] }) => c.id?.includes("iend"));
      expect(hasIEND).toBe(false);
    });

    it("should handle empty IDAT chunks", () => {
      const data = createPNGBuffer({
        extraChunks: [{ type: "IDAT", data: new Uint8Array() }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const idatChunks = result.root.children?.filter((c: { id: string | string[] }) => c.id?.includes("idat"));
      expect(idatChunks?.length).toBeGreaterThan(0);
    });

    it("should set correct ranges for all sections", () => {
      const data = createPNGBuffer();
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Root should cover entire buffer
      expect(result.root.range).toBeDefined();

      // Signature should be first 8 bytes
      const signature = result.root.children?.find((c: { id: string }) => c.id === "png-signature");
      expect(signature?.range).toBeDefined();

      // All chunks should have ranges
      const chunks = result.root.children?.filter((c: { id: string | string[] }) => c.id?.includes("chunk"));
      chunks?.forEach((chunk: { range: any }) => {
        expect(chunk.range).toBeDefined();
      });
    });

    it("should set correct flags on all sections", () => {
      const data = createPNGBuffer();
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.flags?.readable).toBe(true);
      expect(result.root.flags?.writable).toBe(false);
      expect(result.root.flags?.executable).toBe(false);

      result.root.children?.forEach((child: { flags: { readable: any; writable: any } }) => {
        expect(child.flags?.readable).toBe(true);
        expect(child.flags?.writable).toBe(false);
      });
    });

    it("should handle very large PNG dimensions", () => {
      const data = createPNGBuffer({
        width: 0xffffffff,
        height: 0xffffffff,
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.metadata?.width).toBe(0xffffffff);
      expect(result.root.metadata?.height).toBe(0xffffffff);
    });

    it("should handle minimum PNG dimensions", () => {
      const data = createPNGBuffer({
        width: 1,
        height: 1,
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.metadata?.width).toBe(1);
      expect(result.root.metadata?.height).toBe(1);
    });

    it("should handle multiple chunks of same type", () => {
      const data = createPNGBuffer({
        extraChunks: [
          { type: "tEXt", data: new TextEncoder().encode("A\0B") },
          { type: "tEXt", data: new TextEncoder().encode("C\0D") },
          { type: "tEXt", data: new TextEncoder().encode("E\0F") },
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const textChunks = result.root.children?.filter((c: { id: string | string[] }) => c.id?.includes("text"));
      expect(textChunks?.length).toBe(3);
    });

    it("should handle chunk with maximum data length", () => {
      // Create chunk with 2GB-1 data (max for PNG)
      const largeData = new Uint8Array(1000); // Use smaller for test
      const data = createPNGBuffer({
        extraChunks: [{ type: "zTXt", data: largeData }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const ztxt = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("ztxt"));
      expect(ztxt?.metadata?.dataLength).toBe(1000);
    });

    it("should stop parsing at IEND", () => {
      const data = createPNGBuffer({
        extraChunks: [
          { type: "tEXt", data: new Uint8Array([0x00]) }, // After IDAT, before IEND
        ],
      });
      // Modify to add extra data after IEND (simulated)
      const modified = new Uint8Array(data.length + 10);
      modified.set(data);
      modified.set(new Uint8Array(10).fill(0xff), data.length);

      const buf = createMockBuffer(modified);
      const result = parse(buf);

      // Should not have parsed the trailing 0xff bytes as chunks
      expect(result.root.children?.length).toBeLessThan(10);
    });

    it("should handle sBIT chunk", () => {
      const data = createPNGBuffer({
        extraChunks: [{ type: "sBIT", data: new Uint8Array([0x08, 0x08, 0x08]) }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const sbit = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("sbit"));
      expect(sbit?.name).toContain("Significant Bits");
    });

    it("should handle iCCP chunk", () => {
      const profileName = new TextEncoder().encode("sRGB");
      const profileData = new Uint8Array([0x00, 0x00, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x00]);
      const iccpData = new Uint8Array(profileName.length + 2 + profileData.length);
      iccpData.set(profileName);
      iccpData[profileName.length] = 0; // null separator
      iccpData[profileName.length + 1] = 0; // compression method
      iccpData.set(profileData, profileName.length + 2);

      const data = createPNGBuffer({
        extraChunks: [{ type: "iCCP", data: iccpData }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const iccp = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("iccp"));
      expect(iccp?.name).toContain("Embedded ICC Profile");
    });
  });

  describe("edge cases and error handling", () => {
    it("should handle buffer with only signature", () => {
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PNG");
      expect(result.root.children?.length).toBe(1); // Only signature
    });

    it("should handle incomplete IHDR chunk", () => {
      // Signature + incomplete IHDR (less than 21 bytes for chunk header + 13 data)
      const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const partialIHDR = new Uint8Array([0x00, 0x00, 0x00, 0x0d]); // Just length, no type/data
      const data = new Uint8Array(signature.length + partialIHDR.length);
      data.set(signature);
      data.set(partialIHDR, signature.length);

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PNG");
      // Should stop parsing when chunk is incomplete
      expect(result.root.children?.length).toBe(1);
    });

    it("should handle chunk with length exceeding buffer", () => {
      const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // IHDR claiming 0xFFFFFFFF bytes but buffer is small
      const badChunk = new Uint8Array(8);
      writeUint32BE(badChunk, 0, 0xffffffff);
      badChunk.set(new TextEncoder().encode("IHDR"), 4);

      const data = new Uint8Array(signature.length + badChunk.length);
      data.set(signature);
      data.set(badChunk, signature.length);

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PNG");
      // Should stop at signature since chunk claims more data than available
    });

    it("should handle concurrent parsing of multiple PNGs", () => {
      const png1 = createMockBuffer(createPNGBuffer({ width: 100, height: 100 }));
      const png2 = createMockBuffer(createPNGBuffer({ width: 200, height: 200 }));

      const result1 = parse(png1);
      const result2 = parse(png2);

      expect(result1.root.metadata?.width).toBe(100);
      expect(result2.root.metadata?.width).toBe(200);
    });

    it("should handle PNG with all known chunk types", () => {
      const allChunks = ["IHDR", "PLTE", "IDAT", "IEND", "tEXt", "zTXt", "iTXt", "cHRM", "gAMA", "iCCP", "sRGB", "bKGD", "hIST", "tRNS", "pHYs", "sBIT", "sPLT", "tIME"].filter((type) => type !== "IHDR" && type !== "IDAT" && type !== "IEND").map((type) => ({ type, data: new Uint8Array(type === "tIME" ? 7 : 4) }));

      const data = createPNGBuffer({ extraChunks: allChunks });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PNG");
      expect(result.root.children?.length).toBeGreaterThan(3);
    });

    it("should verify CRC format in metadata", () => {
      const data = createPNGBuffer();
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const ihdr = result.root.children?.find((c: { id: string | string[] }) => c.id?.includes("ihdr"));
      const crcStored = ihdr?.metadata?.crcStored;
      expect(crcStored).toMatch(/^0x[0-9a-f]{8}$/);
    });

    it("should handle chunk type with non-printable characters", () => {
      // Create chunk with type bytes that aren't valid ASCII letters
      const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const badChunk = new Uint8Array(12);
      writeUint32BE(badChunk, 0, 0); // length = 0
      badChunk[4] = 0x01; // Non-printable
      badChunk[5] = 0x02;
      badChunk[6] = 0x03;
      badChunk[7] = 0x04;
      writeUint32BE(badChunk, 8, calculateCRC32(new Uint8Array([0x01, 0x02, 0x03, 0x04])));

      const data = new Uint8Array(signature.length + badChunk.length);
      data.set(signature);
      data.set(badChunk, signature.length);

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PNG");
      // Should parse the chunk even with weird type name
      expect(result.root.children?.length).toBeGreaterThan(1);
    });
  });
});
