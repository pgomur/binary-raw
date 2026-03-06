/**
 * @file tests/parsers/pdf.test.ts
 */

import { describe, it, expect } from "vitest";
import type { BinaryBuffer } from "../../src/core/buffer";
import { detect, parse } from "../../src/core/parsers/pdf";

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

// Helper to write string to Uint8Array (safe)
function writeString(buf: Uint8Array, offset: number, str: string) {
  const bytes = new TextEncoder().encode(str);
  const available = buf.length - offset;
  if (available <= 0) return;
  buf.set(bytes.slice(0, available), offset);
}

// Create a minimal valid PDF buffer
function createPDFBuffer(
  options: {
    version?: string;
    withBinaryHint?: boolean;
    numObjects?: number;
    withXref?: boolean;
    withTrailer?: boolean;
    truncateAt?: number;
    corruptHeader?: boolean;
    missingEof?: boolean;
    xrefBeforeObjects?: boolean;
  } = {},
): Uint8Array {
  const { version = "1.4", withBinaryHint = false, numObjects = 1, withXref = true, withTrailer = true, truncateAt, corruptHeader = false, missingEof = false, xrefBeforeObjects = false } = options;

  // Calculate sizes
  const headerSize = corruptHeader ? 4 : 8 + version.length; // %PDF-X.Y\n
  const binaryHintSize = withBinaryHint ? 7 : 0; // %âãÏÓ\n
  let contentSize = 0;

  // Objects
  const objects: string[] = [];
  for (let i = 1; i <= numObjects; i++) {
    objects.push(`${i} 0 obj\n<< /Type /Test >>\nendobj\n`);
  }
  const objectsStr = objects.join("");
  contentSize += objectsStr.length;

  // XRef
  let xrefStr = "";
  if (withXref) {
    xrefStr = `\nxref\n0 ${numObjects + 1}\n0000000000 65535 f \n`;
    for (let i = 0; i < numObjects; i++) {
      const objOffset = headerSize + binaryHintSize + objects.slice(0, i).join("").length;
      xrefStr += `${objOffset.toString().padStart(10, "0")} 00000 n \n`;
    }
    xrefStr += `trailer\n<< /Size ${numObjects + 1} /Root 1 0 R >>\n`;
    contentSize += xrefStr.length;
  }

  // Trailer
  let trailerStr = "";
  if (withTrailer && withXref) {
    const startxrefOffset = headerSize + binaryHintSize + (xrefBeforeObjects ? xrefStr.length : objectsStr.length);
    trailerStr = `startxref\n${startxrefOffset}\n`;
    if (!missingEof) {
      trailerStr += "%%EOF\n";
    }
    contentSize += trailerStr.length;
  }

  const totalSize = truncateAt || headerSize + binaryHintSize + contentSize;
  const buf = new Uint8Array(totalSize);

  let offset = 0;

  // Header
  if (corruptHeader) {
    if (offset + 4 <= buf.length) {
      buf.set([0x25, 0x50, 0x44, 0x00], offset); // %PD\x00
    }
    offset += 4;
  } else {
    const header = `%PDF-${version}\n`;
    writeString(buf, offset, header);
    offset += header.length;
  }

  // Binary hint
  if (withBinaryHint && !corruptHeader) {
    writeString(buf, offset, "%âãÏÓ\n");
    offset += 7;
  }

  // Content order depends on xrefBeforeObjects
  if (xrefBeforeObjects && withXref) {
    writeString(buf, offset, xrefStr);
    offset += xrefStr.length;
    if (offset < totalSize) {
      writeString(buf, offset, objectsStr);
      offset += objectsStr.length;
    }
  } else {
    if (offset < totalSize) {
      writeString(buf, offset, objectsStr);
      offset += objectsStr.length;
    }
    if (withXref && offset < totalSize) {
      writeString(buf, offset, xrefStr);
      offset += xrefStr.length;
    }
  }

  // Trailer
  if (withTrailer && withXref && offset < totalSize) {
    writeString(buf, offset, trailerStr);
  }

  return buf;
}

describe("PDF Parser", () => {
  describe("detect", () => {
    it("should detect valid PDF file", () => {
      const data = createPDFBuffer();
      const buf = createMockBuffer(data);
      expect(detect(buf)).toBe(true);
    });

    it("should return false for buffer shorter than 4 bytes", () => {
      const buf = createMockBuffer(new Uint8Array([0x25, 0x50, 0x44]));
      expect(detect(buf)).toBe(false);
    });

    it("should return false for invalid PDF signature", () => {
      const data = createPDFBuffer({ corruptHeader: true });
      const buf = createMockBuffer(data);
      expect(detect(buf)).toBe(false);
    });

    it("should return false for empty buffer", () => {
      const buf = createMockBuffer(new Uint8Array(0));
      expect(detect(buf)).toBe(false);
    });

    it("should detect PDF with different versions", () => {
      const versions = ["1.0", "1.3", "1.4", "1.7", "2.0"];
      for (const version of versions) {
        const data = createPDFBuffer({ version });
        const buf = createMockBuffer(data);
        expect(detect(buf)).toBe(true);
      }
    });
  });

  describe("parse", () => {
    it("should parse minimal valid PDF", () => {
      const data = createPDFBuffer();
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      expect(result.formatMeta.format).toBe("PDF");
      expect(result.formatMeta.version).toBe("1.4");
      expect(result.entryPoint).toBeUndefined();
      expect(result.totalSize).toBe(data.length);
    });

    it("should parse PDF with binary hint", () => {
      const data = createPDFBuffer({ withBinaryHint: true });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      const header = result.root.children?.find((c: { id: string }) => c.id === "pdf-header");
      expect(header).toBeDefined();
    });

    it("should parse PDF with multiple objects", () => {
      const data = createPDFBuffer({ numObjects: 5 });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.children?.length).toBeGreaterThan(1);
      const objects = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("pdf-obj-"));
      expect(objects?.length).toBe(5);
    });

    it("should cap objects at 100 for tree nodes", () => {
      const data = createPDFBuffer({ numObjects: 150 });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const objects = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("pdf-obj-"));
      expect(objects?.length).toBe(100);

      // But metadata should show actual count
      expect(result.root.metadata?.objectCount).toBe(150);
    });

    it("should cap scanning at 200 objects total", () => {
      const data = createPDFBuffer({ numObjects: 250 });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.metadata?.objectCount).toBe(200);
    });

    it("should parse xref table correctly", () => {
      const data = createPDFBuffer({ withXref: true, numObjects: 3 });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const xref = result.root.children?.find((c: { id: string }) => c.id === "pdf-xref");
      expect(xref).toBeDefined();
      expect(xref?.type).toBe("metadata");
      expect(result.root.metadata?.hasXref).toBe(true);
    });

    it("should parse trailer correctly", () => {
      const data = createPDFBuffer({ withTrailer: true });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const trailer = result.root.children?.find((c: { id: string }) => c.id === "pdf-trailer");
      expect(trailer).toBeDefined();
      expect(trailer?.name).toContain("startxref");
    });

    it("should handle PDF without xref", () => {
      const data = createPDFBuffer({ withXref: false });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const xref = result.root.children?.find((c: { id: string }) => c.id === "pdf-xref");
      expect(xref).toBeUndefined();
      expect(result.root.metadata?.hasXref).toBe(false);
    });

    it("should handle PDF without trailer", () => {
      const data = createPDFBuffer({ withTrailer: false, withXref: true });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const trailer = result.root.children?.find((c: { id: string }) => c.id === "pdf-trailer");
      expect(trailer).toBeUndefined();
    });

    it("should handle PDF without EOF", () => {
      const data = createPDFBuffer({ missingEof: true });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const trailer = result.root.children?.find((c: { id: string }) => c.id === "pdf-trailer");
      expect(trailer).toBeDefined();
    });

    it("should extract correct version from header", () => {
      const versions = ["1.0", "1.3", "1.4", "1.7", "2.0"];
      for (const version of versions) {
        const data = createPDFBuffer({ version });
        const buf = createMockBuffer(data);
        const result = parse(buf);
        expect(result.formatMeta.version).toBe(version);
        expect(result.root.name).toContain(version);
      }
    });

    it("should handle unknown version format", () => {
      const data = new Uint8Array(100);
      writeString(data, 0, "%PDF-XYZ\n");
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.formatMeta.version).toBe("unknown");
    });

    it("should set correct ranges for all sections", () => {
      const data = createPDFBuffer({ numObjects: 2 });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.range).toBeDefined();
      result.root.children?.forEach((child: { range: any }) => {
        expect(child.range).toBeDefined();
      });
    });

    it("should set correct flags on root", () => {
      const data = createPDFBuffer();
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.root.flags?.readable).toBe(true);
      expect(result.root.flags?.writable).toBe(false);
      expect(result.root.flags?.executable).toBe(false);
    });

    it("should handle truncated PDF at header", () => {
      const data = new Uint8Array(10);
      writeString(data, 0, "%PDF-1.4");

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      expect(result.root.children?.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle truncated PDF in objects", () => {
      const data = createPDFBuffer({ numObjects: 5, truncateAt: 80 });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      // Should have header + whatever objects fit
      expect(result.root.children?.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle objects with generation numbers", () => {
      const data = new Uint8Array(200);
      writeString(data, 0, "%PDF-1.4\n");
      writeString(data, 9, "1 0 obj\n<< /Type /Catalog >>\nendobj\n");
      writeString(data, 45, "2 5 obj\n<< /Type /Page >>\nendobj\n");

      const buf = createMockBuffer(data);
      const result = parse(buf);

      const objects = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("pdf-obj-"));
      expect(objects?.length).toBe(2);
    });

    it("should skip false positives for obj keyword", () => {
      const data = new Uint8Array(200);
      writeString(data, 0, "%PDF-1.4\n");
      // This looks like an object but has no generation number
      writeString(data, 9, "X obj\n<< /Type /Test >>\nendobj\n");

      const buf = createMockBuffer(data);
      const result = parse(buf);

      const objects = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("pdf-obj-"));
      expect(objects?.length).toBe(0);
    });

    it("should handle xref before objects (linearized PDF)", () => {
      const data = createPDFBuffer({ xrefBeforeObjects: true, numObjects: 2 });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      const xref = result.root.children?.find((c: { id: string }) => c.id === "pdf-xref");
      expect(xref).toBeDefined();
    });

    it("should handle empty PDF with just header", () => {
      const data = new Uint8Array(9);
      writeString(data, 0, "%PDF-1.4\n");

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      expect(result.root.children?.length).toBe(1); // Only header
    });

    it("should handle PDF with very long lines", () => {
      const data = new Uint8Array(500);
      writeString(data, 0, "%PDF-1.4\n");
      // Object with very long content line
      const longContent = "1 0 obj\n" + "A".repeat(300) + "\nendobj\n";
      writeString(data, 9, longContent);

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      const obj = result.root.children?.find((c: { id: string }) => c.id === "pdf-obj-1");
      expect(obj).toBeDefined();
    });

    it("should handle concurrent parsing of multiple PDFs", () => {
      const pdf1 = createMockBuffer(createPDFBuffer({ version: "1.3" }));
      const pdf2 = createMockBuffer(createPDFBuffer({ version: "1.7" }));

      const result1 = parse(pdf1);
      const result2 = parse(pdf2);

      expect(result1.formatMeta.version).toBe("1.3");
      expect(result2.formatMeta.version).toBe("1.7");
    });
  });

  describe("edge cases and error handling", () => {
    it("should handle PDF with no objects", () => {
      const data = createPDFBuffer({ numObjects: 0, withXref: false });
      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      expect(result.root.metadata?.objectCount).toBe(0);
    });

    it("should handle PDF with malformed object (no endobj)", () => {
      const data = new Uint8Array(100);
      writeString(data, 0, "%PDF-1.4\n");
      writeString(data, 9, "1 0 obj\n<< /Type /Test >>\n"); // Missing endobj

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      // Should not create object node without endobj
      const objects = result.root.children?.filter((c: { id: string }) => c.id?.startsWith("pdf-obj-"));
      expect(objects?.length).toBe(0);
    });

    it("should handle xref without startxref", () => {
      const data = new Uint8Array(200);
      writeString(data, 0, "%PDF-1.4\n");
      writeString(data, 9, "xref\n0 1\n0000000000 65535 f \n");
      // Missing startxref

      const buf = createMockBuffer(data);
      const result = parse(buf);

      const xref = result.root.children?.find((c: { id: string }) => c.id === "pdf-xref");
      expect(xref).toBeUndefined(); // No startxref, no xref section
    });

    it("should handle startxref before xref", () => {
      const data = new Uint8Array(200);
      writeString(data, 0, "%PDF-1.4\n");
      writeString(data, 9, "startxref\n0\n%%EOF\n");
      writeString(data, 25, "xref\n0 1\n0000000000 65535 f \n");

      const buf = createMockBuffer(data);
      const result = parse(buf);

      // xrefStart > startxrefPos, so xref should not be added
      const xref = result.root.children?.find((c: { id: string }) => c.id === "pdf-xref");
      expect(xref).toBeUndefined();
    });

    it("should handle object at buffer boundary", () => {
      const data = new Uint8Array(30);
      writeString(data, 0, "%PDF-1.4\n");
      writeString(data, 9, "1 0 obj\n"); // Truncated object

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      // No complete object, so only header
      expect(result.root.children?.length).toBe(1);
    });

    it("should handle very large generation numbers", () => {
      const data = new Uint8Array(100);
      writeString(data, 0, "%PDF-1.4\n");
      writeString(data, 9, "1 99999 obj\n<< /Type /Test >>\nendobj\n");

      const buf = createMockBuffer(data);
      const result = parse(buf);

      const obj = result.root.children?.find((c: { id: string }) => c.id === "pdf-obj-1");
      expect(obj).toBeDefined();
    });

    it("should handle PDF with comments in header", () => {
      const data = new Uint8Array(100);
      writeString(data, 0, "%PDF-1.4\n%This is a comment\n1 0 obj\n<< >>\nendobj\n");

      const buf = createMockBuffer(data);
      const result = parse(buf);

      expect(result.format).toBe("PDF");
      expect(result.formatMeta.version).toBe("1.4");
    });

    it("should handle multiple xref sections (uses last one)", () => {
      const header = "%PDF-1.4\n";
      const firstXref = "xref\n0 1\n0000000000 65535 f \n";
      const obj1 = "1 0 obj\n<< /Type /Test >>\nendobj\n";
      const secondXref = "xref\n0 2\n0000000000 65535 f \n0000000040 00000 n \n";

      const data = new Uint8Array(500);
      let offset = 0;

      writeString(data, offset, header);
      offset += header.length;
      writeString(data, offset, firstXref);
      offset += firstXref.length;
      writeString(data, offset, obj1);
      offset += obj1.length;
      const secondXrefOffset = offset;
      writeString(data, offset, secondXref);
      offset += secondXref.length;
      const trailer = `trailer\n<< /Size 2 >>\nstartxref\n${secondXrefOffset}\n%%EOF\n`;
      writeString(data, offset, trailer);

      const buf = createMockBuffer(data);
      const result = parse(buf);

      const xref = result.root.children?.find((c: { id: string }) => c.id === "pdf-xref");
      expect(xref).toBeDefined();
      expect(xref?.range).toBeDefined();
      expect(typeof xref?.range?.start).toBe("number");
      expect(xref?.range?.start).toBeGreaterThanOrEqual(secondXrefOffset);
    });

    it("should handle object with nested content", () => {
      const data = new Uint8Array(300);
      writeString(data, 0, "%PDF-1.4\n");
      const objContent = `1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
  /Names << /EmbeddedFiles << /Names [ (file) 3 0 R ] >> >>
>>
endobj`;
      writeString(data, 9, objContent);

      const buf = createMockBuffer(data);
      const result = parse(buf);

      const obj = result.root.children?.find((c: { id: string }) => c.id === "pdf-obj-1");
      expect(obj).toBeDefined();
    });

    it("should handle PDF with stream objects", () => {
      const data = new Uint8Array(200);
      writeString(data, 0, "%PDF-1.4\n");
      const streamObj = `1 0 obj
<< /Length 10 >>
stream
1234567890
endstream
endobj`;
      writeString(data, 9, streamObj);

      const buf = createMockBuffer(data);
      const result = parse(buf);

      const obj = result.root.children?.find((c: { id: string }) => c.id === "pdf-obj-1");
      expect(obj).toBeDefined();
    });
  });
});
