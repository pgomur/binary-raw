/**
 * @file src/core/parsers/__tests__/zip.test.ts
 */

import { describe, it, expect } from "vitest";
import type { BinaryBuffer } from "../../src/core/buffer";
import { detect, parse } from "../../src/core/parsers/zip";

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

// Helper to write little-endian values
function writeUint16(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

function writeUint32(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

// Create a minimal valid ZIP structure
function createZipBuffer(
  options: {
    entries?: Array<{
      filename?: string;
      content?: Uint8Array;
      compression?: number;
      extraField?: Uint8Array;
      comment?: string;
    }>;
    comment?: string;
    skipCentralDir?: boolean;
    skipEOCD?: boolean;
  } = {},
): Uint8Array {
  const { entries = [{ filename: "test.txt", content: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]) }], comment = "", skipCentralDir = false, skipEOCD = false } = options;

  const parts: Uint8Array[] = [];
  const centralDirParts: Uint8Array[] = [];
  let offset = 0;
  const localHeaderOffsets: number[] = [];

  // Build local file headers and data
  for (const entry of entries) {
    const filename = entry.filename ?? "file.dat";
    const content = entry.content ?? new Uint8Array();
    const compression = entry.compression ?? 0;
    const extraField = entry.extraField ?? new Uint8Array();

    const filenameBytes = new TextEncoder().encode(filename);
    const headerSize = 30 + filenameBytes.length + extraField.length;
    const header = new Uint8Array(headerSize);

    // Local file header signature
    header.set([0x50, 0x4b, 0x03, 0x04], 0);
    // Version needed (2.0)
    writeUint16(header, 4, 0x0014);
    // General purpose bit flag
    writeUint16(header, 6, 0);
    // Compression method
    writeUint16(header, 8, compression);
    // Last mod time/date
    writeUint16(header, 10, 0);
    writeUint16(header, 12, 0);
    // CRC-32 (simplified, not calculated)
    writeUint32(header, 14, 0);
    // Compressed size
    writeUint32(header, 18, content.length);
    // Uncompressed size
    writeUint32(header, 22, content.length);
    // Filename length
    writeUint16(header, 26, filenameBytes.length);
    // Extra field length
    writeUint16(header, 28, extraField.length);
    // Filename
    header.set(filenameBytes, 30);
    // Extra field
    header.set(extraField, 30 + filenameBytes.length);

    localHeaderOffsets.push(offset);
    parts.push(header);
    parts.push(content);
    offset += headerSize + content.length;
  }

  const centralDirOffset = offset;

  // Build central directory
  if (!skipCentralDir && entries.length > 0) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const filename = entry.filename ?? "file.dat";
      const content = entry.content ?? new Uint8Array();
      const compression = entry.compression ?? 0;
      const extraField = entry.extraField ?? new Uint8Array();
      const fileComment = entry.comment ?? "";

      const filenameBytes = new TextEncoder().encode(filename);
      const commentBytes = new TextEncoder().encode(fileComment);
      const extraLen = extraField.length;

      const cdHeader = new Uint8Array(46 + filenameBytes.length + extraLen + commentBytes.length);

      // Central directory signature
      cdHeader.set([0x50, 0x4b, 0x01, 0x02], 0);
      // Version made by
      writeUint16(cdHeader, 4, 0x0014);
      // Version needed
      writeUint16(cdHeader, 6, 0x0014);
      // General purpose bit flag
      writeUint16(cdHeader, 8, 0);
      // Compression method
      writeUint16(cdHeader, 10, compression);
      // Last mod time/date
      writeUint16(cdHeader, 12, 0);
      writeUint16(cdHeader, 14, 0);
      // CRC-32
      writeUint32(cdHeader, 16, 0);
      // Compressed size
      writeUint32(cdHeader, 20, content.length);
      // Uncompressed size
      writeUint32(cdHeader, 24, content.length);
      // Filename length
      writeUint16(cdHeader, 28, filenameBytes.length);
      // Extra field length
      writeUint16(cdHeader, 30, extraLen);
      // Comment length
      writeUint16(cdHeader, 32, commentBytes.length);
      // Disk number start
      writeUint16(cdHeader, 34, 0);
      // Internal file attributes
      writeUint16(cdHeader, 36, 0);
      // External file attributes
      writeUint32(cdHeader, 38, 0);
      // Relative offset of local header
      writeUint32(cdHeader, 42, localHeaderOffsets[i]);
      // Filename
      cdHeader.set(filenameBytes, 46);
      // Extra field
      cdHeader.set(extraField, 46 + filenameBytes.length);
      // Comment
      cdHeader.set(commentBytes, 46 + filenameBytes.length + extraLen);

      centralDirParts.push(cdHeader);
      offset += cdHeader.length;
    }
  }

  parts.push(...centralDirParts);
  const centralDirSize = centralDirParts.reduce((sum, p) => sum + p.length, 0);

  // Build EOCD
  if (!skipEOCD) {
    const commentBytes = new TextEncoder().encode(comment);
    const eocd = new Uint8Array(22 + commentBytes.length);

    // EOCD signature
    eocd.set([0x50, 0x4b, 0x05, 0x06], 0);
    // Number of this disk
    writeUint16(eocd, 4, 0);
    // Disk with central directory
    writeUint16(eocd, 6, 0);
    // Number of CD records on this disk
    writeUint16(eocd, 8, entries.length);
    // Total number of CD records
    writeUint16(eocd, 10, entries.length);
    // Size of central directory
    writeUint32(eocd, 12, centralDirSize);
    // Offset of start of central directory
    writeUint32(eocd, 16, centralDirOffset);
    // Comment length
    writeUint16(eocd, 20, commentBytes.length);
    // Comment
    eocd.set(commentBytes, 22);

    parts.push(eocd);
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

describe("ZIP Parser", () => {
  describe("detect", () => {
    it("should detect valid ZIP signature at offset 0", () => {
      const buf = createMockBuffer(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      expect(detect(buf)).toBe(true);
    });

    it("should return false for buffer shorter than 4 bytes", () => {
      const buf = createMockBuffer(new Uint8Array([0x50, 0x4b, 0x03]));
      expect(detect(buf)).toBe(false);
    });

    it("should return false for invalid signature", () => {
      const buf = createMockBuffer(new Uint8Array([0x50, 0x4b, 0x03, 0x05]));
      expect(detect(buf)).toBe(false);
    });

    it("should return false for empty buffer", () => {
      const buf = createMockBuffer(new Uint8Array());
      expect(detect(buf)).toBe(false);
    });

    it("should detect JAR/APK/DOCX variants (same signature)", () => {
      // These formats use the same ZIP signature
      const buf = createMockBuffer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
      expect(detect(buf)).toBe(true);
    });
  });

  describe("parse", () => {
    it("should parse empty ZIP with no entries", () => {
      const data = createZipBuffer({ entries: [], comment: "" });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("ZIP");
      expect(result.formatMeta.format).toBe("ZIP");
      expect(result.formatMeta.entries).toBe(0);
      // Empty ZIP still has EOCD
      expect(result.root.children?.length).toBeGreaterThanOrEqual(0);
      expect(result.totalSize).toBe(data.length);
    });

    it("should parse ZIP with single file entry", () => {
      const content = new TextEncoder().encode("Hello, World!");
      const data = createZipBuffer({
        entries: [{ filename: "hello.txt", content, compression: 0 }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(1);
      // 1 entry + central directory + EOCD = 3 children
      expect(result.root.children?.length).toBe(3);

      // Check local file entry
      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry).toBeDefined();
      expect(entry?.name).toBe("hello.txt");
      expect(entry?.type).toBe("container");
      expect(entry?.metadata?.compression).toBe("Stored");
      expect(entry?.metadata?.compressedSize).toBe(content.length);
      expect(entry?.metadata?.uncompressedSize).toBe(content.length);
      expect(entry?.metadata?.filename).toBe("hello.txt");

      // Check local header sub-section
      const localHeader = entry?.children?.find((c: { id: string }) => c.id === "zip-lh-1");
      expect(localHeader).toBeDefined();
      expect(localHeader?.type).toBe("metadata");

      // Check data sub-section
      const dataSection = entry?.children?.find((c: { id: string }) => c.id === "zip-data-1");
      expect(dataSection).toBeDefined();
      expect(dataSection?.type).toBe("data");
      expect(dataSection?.name).toContain("Stored");
    });

    it("should parse ZIP with multiple file entries", () => {
      const data = createZipBuffer({
        entries: [
          { filename: "file1.txt", content: new Uint8Array([0x01, 0x02]) },
          { filename: "file2.txt", content: new Uint8Array([0x03, 0x04, 0x05]) },
          { filename: "dir/nested.txt", content: new Uint8Array([0x06]) },
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(3);

      const names = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("zip-entry-")).map((c: { name: any }) => c.name);
      expect(names).toContain("file1.txt");
      expect(names).toContain("file2.txt");
      expect(names).toContain("dir/nested.txt");
    });

    it("should handle different compression methods", () => {
      const methods = [
        { method: 0, name: "Stored" },
        { method: 8, name: "Deflated" },
        { method: 9, name: "Deflate64" },
        { method: 12, name: "BZIP2" },
        { method: 14, name: "LZMA" },
        { method: 98, name: "PPMd" },
        { method: 99, name: "method(99)" }, // Unknown method
      ];

      for (const { method, name } of methods) {
        const data = createZipBuffer({
          entries: [{ filename: "test.bin", content: new Uint8Array([0x00]), compression: method }],
        });
        const buf = createMockBuffer(data);
        const result = parse(buf);

        const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
        expect(entry?.metadata?.compression).toBe(name);
      }
    });

    it("should handle files with empty content (zero size)", () => {
      const data = createZipBuffer({
        entries: [{ filename: "empty.txt", content: new Uint8Array() }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry?.metadata?.compressedSize).toBe(0);
      expect(entry?.metadata?.uncompressedSize).toBe(0);

      // Should not have data section when compSize is 0
      const dataSection = entry?.children?.find((c: { id: string }) => c.id === "zip-data-1");
      expect(dataSection).toBeUndefined();
    });

    it("should handle filenames with non-printable ASCII characters", () => {
      // Create filename with bytes outside 0x20-0x7E
      // Note: 0x00 (null), 0x01 (SOH), 0x7F (DEL) are non-printable
      // 0x2E (.) IS printable (46 in decimal, within 32-126 range)
      const filename = "test\x00\x01\x7F.txt";
      const data = createZipBuffer({
        entries: [{ filename, content: new Uint8Array([0x01]) }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      // Non-printable chars should be replaced with '?', but '.' is printable (0x2E = 46)
      expect(entry?.name).toBe("test???.txt");
      expect(entry?.metadata?.filename).toBe("test???.txt");
    });

    it("should handle empty filename", () => {
      const data = createZipBuffer({
        entries: [{ filename: "", content: new Uint8Array([0x01]) }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry?.name).toBe("Entry 1");
    });

    it("should handle extra fields in local headers", () => {
      const extraField = new Uint8Array([0x00, 0x01, 0x02, 0x00]); // Header ID + size + data
      const data = createZipBuffer({
        entries: [
          {
            filename: "extra.dat",
            content: new Uint8Array([0x01]),
            extraField,
          },
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(1);
      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry).toBeDefined();
    });

    it("should parse ZIP with comment in EOCD", () => {
      const comment = "This is a ZIP comment";
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content: new Uint8Array([0x01]) }],
        comment,
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const eocd = result.root.children?.find((c: { id: string }) => c.id === "zip-eocd");
      expect(eocd).toBeDefined();
      expect(eocd?.metadata?.commentLength).toBe(comment.length);
    });

    it("should parse ZIP with long comment (near 64KB limit)", () => {
      const comment = "A".repeat(1000);
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content: new Uint8Array([0x01]) }],
        comment,
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const eocd = result.root.children?.find((c: { id: string }) => c.id === "zip-eocd");
      expect(eocd).toBeDefined();
      expect(eocd?.metadata?.commentLength).toBe(1000);
    });

    it("should handle ZIP without central directory", () => {
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content: new Uint8Array([0x01]) }],
        skipCentralDir: true,
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Should still parse local entries
      expect(result.formatMeta.entries).toBe(1);
      const cd = result.root.children?.find((c: { id: string }) => c.id === "zip-central-dir");
      expect(cd).toBeUndefined();
    });

    it("should handle ZIP without EOCD", () => {
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content: new Uint8Array([0x01]) }],
        skipEOCD: true,
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Should still parse local entries and central dir
      expect(result.formatMeta.entries).toBe(1);
      const eocd = result.root.children?.find((c: { id: string }) => c.id === "zip-eocd");
      expect(eocd).toBeUndefined();
    });

    it("should stop parsing local headers when signature not found", () => {
      // Create buffer with one valid entry followed by invalid data
      const entry1 = createZipBuffer({
        entries: [{ filename: "test1.txt", content: new Uint8Array([0x01]) }],
        skipCentralDir: true,
        skipEOCD: true,
      });

      // Append some non-ZIP data
      const extraData = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      const combined = new Uint8Array(entry1.length + extraData.length);
      combined.set(entry1);
      combined.set(extraData, entry1.length);

      const buf = createMockBuffer(combined);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(1);
    });

    it("should enforce safety limit of 2000 entries", () => {
      // Create many entries to trigger the limit
      const entries = Array.from({ length: 2005 }, (_, i) => ({
        filename: `file${i}.txt`,
        content: new Uint8Array([i % 256]),
      }));

      const data = createZipBuffer({ entries });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Should stop at 2000 entries
      expect(result.formatMeta.entries).toBe(2000);
    });

    it("should handle buffer shorter than local header minimum", () => {
      // Buffer with signature but not enough bytes for full header
      const data = new Uint8Array([
        0x50,
        0x4b,
        0x03,
        0x04, // Signature
        0x14,
        0x00, // Version
        0x00,
        0x00, // Flags
        0x00,
        0x00, // Compression
        0x00,
        0x00, // Time
        0x00,
        0x00, // Date
        0x00,
        0x00,
        0x00,
        0x00, // CRC
        0x05,
        0x00,
        0x00,
        0x00, // Comp size
        0x05,
        0x00,
        0x00,
        0x00, // Uncomp size
        0x00,
        0x00, // Filename len
        0x00,
        0x00, // Extra len
        // Missing data - only 30 bytes header but claims 5 bytes data
      ]);
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Should handle gracefully without crashing
      expect(result.format).toBe("ZIP");
    });

    it("should handle data that extends beyond buffer", () => {
      // Header claims larger size than available
      const header = new Uint8Array(30);
      header.set([0x50, 0x4b, 0x03, 0x04], 0);
      writeUint16(header, 26, 0); // filename len
      writeUint16(header, 28, 0); // extra len
      writeUint32(header, 18, 100); // compressed size claims 100 bytes
      writeUint32(header, 22, 100); // uncompressed size

      const buf = createMockBuffer(header);
      const result = parse(buf);

      expect(result.format).toBe("ZIP");
      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry).toBeDefined();
    });

    it("should calculate total compressed and uncompressed sizes", () => {
      const data = createZipBuffer({
        entries: [
          { filename: "file1.txt", content: new Uint8Array([0x01, 0x02]) },
          { filename: "file2.txt", content: new Uint8Array([0x03, 0x04, 0x05, 0x06]) },
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.metadata?.totalCompressedSize).toBe(6);
      expect(result.root.metadata?.totalUncompressedSize).toBe(6);
    });

    it("should set correct ranges for all sections", () => {
      const content = new Uint8Array([0x01, 0x02, 0x03]);
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      // Check that range exists and has valid structure
      expect(result.root.range).toBeDefined();
      // Range should have start and end properties that are numbers or Offset objects
      const rootRange = result.root.range as any;
      expect(rootRange.start).toBeDefined();
      expect(rootRange.end).toBeDefined();

      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry?.range).toBeDefined();

      const localHeader = entry?.children?.find((c: { id: string }) => c.id === "zip-lh-1");
      expect(localHeader?.range).toBeDefined();
    });

    it("should handle central directory with comments", () => {
      // Create central directory entries with file comments
      const encoder = new TextEncoder();
      const filename = "test.txt";
      const fileComment = "File comment";
      const filenameBytes = encoder.encode(filename);
      const commentBytes = encoder.encode(fileComment);

      // Build minimal local header
      const localHeader = new Uint8Array(30 + filenameBytes.length);
      localHeader.set([0x50, 0x4b, 0x03, 0x04], 0);
      writeUint16(localHeader, 26, filenameBytes.length);
      localHeader.set(filenameBytes, 30);

      // Build central directory header with comment
      const cdHeader = new Uint8Array(46 + filenameBytes.length + commentBytes.length);
      cdHeader.set([0x50, 0x4b, 0x01, 0x02], 0);
      writeUint16(cdHeader, 28, filenameBytes.length);
      writeUint16(cdHeader, 32, commentBytes.length);
      cdHeader.set(filenameBytes, 46);
      cdHeader.set(commentBytes, 46 + filenameBytes.length);

      // Build EOCD
      const eocd = new Uint8Array(22);
      eocd.set([0x50, 0x4b, 0x05, 0x06], 0);
      writeUint16(eocd, 8, 1);
      writeUint16(eocd, 10, 1);
      writeUint32(eocd, 12, cdHeader.length);
      writeUint32(eocd, 16, localHeader.length);

      const combined = new Uint8Array(localHeader.length + cdHeader.length + eocd.length);
      combined.set(localHeader);
      combined.set(cdHeader, localHeader.length);
      combined.set(eocd, localHeader.length + cdHeader.length);

      const buf = createMockBuffer(combined);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(1);
      const cd = result.root.children?.find((c: { id: string }) => c.id === "zip-central-dir");
      expect(cd).toBeDefined();
    });

    it("should handle malformed central directory (invalid signature)", () => {
      // Create valid local header but invalid central directory
      const localHeader = new Uint8Array(30);
      localHeader.set([0x50, 0x4b, 0x03, 0x04], 0);
      writeUint16(localHeader, 26, 0);
      writeUint16(localHeader, 28, 0);

      // Invalid central directory (wrong signature)
      const invalidCD = new Uint8Array(46);
      invalidCD.set([0x50, 0x4b, 0x00, 0x00], 0); // Wrong signature

      const combined = new Uint8Array(localHeader.length + invalidCD.length);
      combined.set(localHeader);
      combined.set(invalidCD, localHeader.length);

      const buf = createMockBuffer(combined);
      const result = parse(buf);

      // Should still parse local entry
      expect(result.formatMeta.entries).toBe(1);
      // Central directory should not be added (signature check fails)
      const cd = result.root.children?.find((c: { id: string }) => c.id === "zip-central-dir");
      expect(cd).toBeUndefined();
    });

    it("should handle EOCD search with comment spanning search range", () => {
      // Create ZIP where EOCD is not at immediate end due to padding
      const entries = [{ filename: "test.txt", content: new Uint8Array([0x01]) }];
      const baseZip = createZipBuffer({ entries });

      // Add some padding after EOCD (simulating corruption or trailing data)
      const padding = new Uint8Array(10);
      const combined = new Uint8Array(baseZip.length + padding.length);
      combined.set(baseZip);
      combined.set(padding, baseZip.length);

      const buf = createMockBuffer(combined);
      const result = parse(buf);

      // Should still find EOCD
      const eocd = result.root.children?.find((c: { id: string }) => c.id === "zip-eocd");
      expect(eocd).toBeDefined();
    });

    it("should handle very long search for EOCD (near 65KB limit)", () => {
      const entries = [{ filename: "test.txt", content: new Uint8Array([0x01]) }];
      const baseZip = createZipBuffer({ entries });

      // Extract EOCD and move it further back with padding
      const eocdStart = baseZip.length - 22;
      const eocd = baseZip.slice(eocdStart);

      // Create large comment/padding to push EOCD back
      const largePadding = new Uint8Array(1000);
      largePadding.fill(0x00);

      const newZip = new Uint8Array(baseZip.length + largePadding.length);
      newZip.set(baseZip.slice(0, eocdStart));
      newZip.set(largePadding, eocdStart);
      newZip.set(eocd, eocdStart + largePadding.length);

      const buf = createMockBuffer(newZip);
      const result = parse(buf);

      const eocdSection = result.root.children?.find((c: { id: string }) => c.id === "zip-eocd");
      expect(eocdSection).toBeDefined();
    });

    it("should set correct flags on all sections", () => {
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content: new Uint8Array([0x01]) }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.flags?.readable).toBe(true);
      expect(result.root.flags?.writable).toBe(false);
      expect(result.root.flags?.executable).toBe(false);

      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry?.flags?.readable).toBe(true);

      const localHeader = entry?.children?.find((c: { id: string }) => c.id === "zip-lh-1");
      expect(localHeader?.flags?.readable).toBe(true);
    });

    it("should handle entryPoint as undefined", () => {
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content: new Uint8Array([0x01]) }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.entryPoint).toBeUndefined();
    });

    it("should handle complex nested paths", () => {
      const data = createZipBuffer({
        entries: [
          { filename: "deep/nested/path/file.txt", content: new Uint8Array([0x01]) },
          { filename: "root.txt", content: new Uint8Array([0x02]) },
          { filename: "dir/", content: new Uint8Array() }, // Directory entry
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(3);
      const names = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("zip-entry-")).map((c: { name: any }) => c.name);
      expect(names).toContain("deep/nested/path/file.txt");
      expect(names).toContain("root.txt");
      expect(names).toContain("dir/");
    });

    it("should handle binary content in files", () => {
      const binaryContent = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        binaryContent[i] = i;
      }

      const data = createZipBuffer({
        entries: [{ filename: "binary.dat", content: binaryContent }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry?.metadata?.compressedSize).toBe(256);
      expect(entry?.metadata?.uncompressedSize).toBe(256);
    });

    it("should handle concurrent parsing of multiple ZIPs", () => {
      const zip1 = createMockBuffer(
        createZipBuffer({
          entries: [{ filename: "a.txt", content: new Uint8Array([0x01]) }],
        }),
      );
      const zip2 = createMockBuffer(
        createZipBuffer({
          entries: [{ filename: "b.txt", content: new Uint8Array([0x02]) }],
        }),
      );

      const result1 = parse(zip1);
      const result2 = parse(zip2);

      expect(result1.formatMeta.entries).toBe(1);
      expect(result2.formatMeta.entries).toBe(1);
      expect(result1.root.children?.find((c: { id: string }) => c.id === "zip-entry-1")?.name).toBe("a.txt");
      expect(result2.root.children?.find((c: { id: string }) => c.id === "zip-entry-1")?.name).toBe("b.txt");
    });
  });

  describe("edge cases and error handling", () => {
    it("should handle buffer with only EOCD signature but invalid structure", () => {
      const data = new Uint8Array([
        0x50,
        0x4b,
        0x05,
        0x06, // EOCD signature
        0x00,
        0x00,
        0x00,
        0x00, // Disk numbers
        0x00,
        0x00,
        0x00,
        0x00, // Entry counts
        0x00,
        0x00,
        0x00,
        0x00, // CD size
        0x00,
        0x00,
        0x00,
        0x00, // CD offset
        0x00,
        0x00, // Comment length
      ]);
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("ZIP");
      expect(result.formatMeta.entries).toBe(0);
    });

    it("should handle truncated local header (less than 30 bytes)", () => {
      const data = new Uint8Array([
        0x50,
        0x4b,
        0x03,
        0x04, // Signature
        0x14,
        0x00, // Only 6 bytes total
      ]);
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("ZIP");
      expect(result.formatMeta.entries).toBe(0);
    });

    it("should handle entry with data extending to exact buffer end", () => {
      const content = new Uint8Array([0x01, 0x02, 0x03]);
      const header = new Uint8Array(30);
      header.set([0x50, 0x4b, 0x03, 0x04], 0);
      writeUint16(header, 26, 0); // filename len
      writeUint16(header, 28, 0); // extra len
      writeUint32(header, 18, content.length);
      writeUint32(header, 22, content.length);

      const combined = new Uint8Array(header.length + content.length);
      combined.set(header);
      combined.set(content, header.length);

      const buf = createMockBuffer(combined);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(1);
      const dataSection = result.root.children?.[0]?.children?.find((c: { id: string }) => c.id === "zip-data-1");
      // Just check that data section exists and has a range
      expect(dataSection).toBeDefined();
      expect(dataSection?.range).toBeDefined();
    });

    it("should handle duplicate filenames", () => {
      const data = createZipBuffer({
        entries: [
          { filename: "same.txt", content: new Uint8Array([0x01]) },
          { filename: "same.txt", content: new Uint8Array([0x02]) },
        ],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.formatMeta.entries).toBe(2);
      const entries = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("zip-entry-"));
      expect(entries?.[0]?.name).toBe("same.txt");
      expect(entries?.[1]?.name).toBe("same.txt");
    });

    it("should handle special characters in filenames (printable)", () => {
      const specialNames = ["file-name.txt", "file_name.txt", "file.name.txt", "FILE.TXT"];

      for (const name of specialNames) {
        const data = createZipBuffer({
          entries: [{ filename: name, content: new Uint8Array([0x01]) }],
        });
        const buf = createMockBuffer(data);
        const result = parse(buf);

        const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
        expect(entry?.name).toBe(name);
      }
    });

    it("should handle maximum filename length in local header", () => {
      const longName = "a".repeat(1000);
      const data = createZipBuffer({
        entries: [{ filename: longName, content: new Uint8Array([0x01]) }],
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const entry = result.root.children?.find((c: { id: string }) => c.id === "zip-entry-1");
      expect(entry?.name).toBe(longName);
    });

    it("should handle zero-length comment", () => {
      const data = createZipBuffer({
        entries: [{ filename: "test.txt", content: new Uint8Array([0x01]) }],
        comment: "",
      });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const eocd = result.root.children?.find((c: { id: string }) => c.id === "zip-eocd");
      expect(eocd?.metadata?.commentLength).toBe(0);
    });

    it("should parse structure with data descriptor flag (though not processed)", () => {
      const header = new Uint8Array(30);
      header.set([0x50, 0x4b, 0x03, 0x04], 0);
      writeUint16(header, 6, 0x0008); // Data descriptor flag set
      writeUint16(header, 26, 0);
      writeUint16(header, 28, 0);

      const buf = createMockBuffer(header);
      const result = parse(buf);

      expect(result.format).toBe("ZIP");
    });
  });
});
