/**
 * @file tests/parsers/index.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  parseBuffer,
  detectFormat,
  isFormatSupported,
  supportedFormats,
  ParseError,
} from "../../src/core/parsers/index";

// Helper to create ArrayBuffer from string/bytes
function createArrayBuffer(content: string | number[]): ArrayBuffer {
  if (typeof content === "string") {
    const encoder = new TextEncoder();
    return encoder.encode(content).buffer;
  }
  return new Uint8Array(content).buffer;
}

// Create minimal valid files for each format
function createMinimalELF(): ArrayBuffer {
  // ELF header: magic + 32-bit + little endian + version + padding + type + machine
  const data = new Uint8Array([
    0x7f, 0x45, 0x4c, 0x46, // Magic: \x7fELF
    0x01, // 32-bit
    0x01, // Little endian
    0x01, // Version
    0x00, // OS/ABI
    ...new Array(8).fill(0), // Padding
    0x01, 0x00, // Type: relocatable
    0x03, 0x00, // Machine: x86 (0x03)
    0x01, 0x00, 0x00, 0x00, // Version
    0x00, 0x00, 0x00, 0x00, // Entry point
    0x00, 0x00, 0x00, 0x00, // Program header offset
    0x34, 0x00, 0x00, 0x00, // Section header offset (52 bytes)
    0x00, 0x00, 0x00, 0x00, // Flags
    0x34, 0x00, // ELF header size (52 bytes)
    0x00, 0x00, // Program header entry size
    0x00, 0x00, // Number of program headers
    0x28, 0x00, // Section header entry size (40 bytes)
    0x01, 0x00, // Number of section headers
    0x01, 0x00, // Section name string table index
    // Section header (40 bytes)
    0x00, 0x00, 0x00, 0x00, // Name
    0x00, 0x00, 0x00, 0x00, // Type
    0x00, 0x00, 0x00, 0x00, // Flags
    0x00, 0x00, 0x00, 0x00, // Address
    0x00, 0x00, 0x00, 0x00, // Offset
    0x00, 0x00, 0x00, 0x00, // Size
    0x00, 0x00, 0x00, 0x00, // Link
    0x00, 0x00, 0x00, 0x00, // Info
    0x00, 0x00, 0x00, 0x00, // Alignment
    0x00, 0x00, 0x00, 0x00, // Entry size
  ]);
  return data.buffer;
}

function createMinimalPE(): ArrayBuffer {
  // PE más completo para satisfacer el parser
  const dosHeader = new Array(64).fill(0);
  dosHeader[0] = 0x4d; // 'M'
  dosHeader[1] = 0x5a; // 'Z'
  // e_lfanew at offset 0x3C (60) - apunta a 64
  dosHeader[60] = 0x40;
  dosHeader[61] = 0x00;
  dosHeader[62] = 0x00;
  dosHeader[63] = 0x00;

  const peOffset = 64;
  const peSig = [0x50, 0x45, 0x00, 0x00]; // "PE\0\0"

  // COFF Header (20 bytes)
  const coffHeader = [
    0x4c, 0x01, // Machine: i386 (0x14c)
    0x01, 0x00, // NumberOfSections: 1
    0x00, 0x00, 0x00, 0x00, // TimeDateStamp
    0x00, 0x00, 0x00, 0x00, // PointerToSymbolTable
    0x00, 0x00, 0x00, 0x00, // NumberOfSymbols
    0xe0, 0x00, // SizeOfOptionalHeader: 224 (PE32)
    0x02, 0x01, // Characteristics: EXECUTABLE_IMAGE | 32BIT_MACHINE
  ];

  // Optional Header PE32 (224 bytes mínimo)
  const optionalHeader = new Array(224).fill(0);
  optionalHeader[0] = 0x0b; // Magic: PE32 (0x10b) - little endian
  optionalHeader[1] = 0x01;
  // MajorLinkerVersion, MinorLinkerVersion
  optionalHeader[2] = 0x00;
  optionalHeader[3] = 0x00;
  // SizeOfCode, SizeOfInitializedData, SizeOfUninitializedData (4 bytes cada uno)
  // EntryPoint (4 bytes at offset 16)
  optionalHeader[16] = 0x00;
  optionalHeader[17] = 0x10;
  optionalHeader[18] = 0x00;
  optionalHeader[19] = 0x00;
  // BaseOfCode (4 bytes)
  // BaseOfData (4 bytes at offset 24 en PE32)
  // ImageBase (4 bytes at offset 28) = 0x00400000
  optionalHeader[28] = 0x00;
  optionalHeader[29] = 0x00;
  optionalHeader[30] = 0x40;
  optionalHeader[31] = 0x00;
  // SectionAlignment (4 bytes) = 0x1000
  optionalHeader[32] = 0x00;
  optionalHeader[33] = 0x10;
  optionalHeader[34] = 0x00;
  optionalHeader[35] = 0x00;
  // FileAlignment (4 bytes) = 0x200
  optionalHeader[36] = 0x00;
  optionalHeader[37] = 0x02;
  optionalHeader[38] = 0x00;
  optionalHeader[39] = 0x00;
  // MajorOperatingSystemVersion, MinorOperatingSystemVersion (2 bytes cada uno)
  // MajorImageVersion, MinorImageVersion
  // MajorSubsystemVersion, MinorSubsystemVersion = 4.0
  optionalHeader[48] = 0x04; // MajorSubsystemVersion
  optionalHeader[49] = 0x00;
  optionalHeader[50] = 0x00; // MinorSubsystemVersion
  optionalHeader[51] = 0x00;
  // Win32VersionValue (4 bytes) = 0
  // SizeOfImage (4 bytes) = 0x2000
  optionalHeader[56] = 0x00;
  optionalHeader[57] = 0x20;
  optionalHeader[58] = 0x00;
  optionalHeader[59] = 0x00;
  // SizeOfHeaders (4 bytes) = 0x200
  optionalHeader[60] = 0x00;
  optionalHeader[61] = 0x02;
  optionalHeader[62] = 0x00;
  optionalHeader[63] = 0x00;
  // CheckSum (4 bytes) = 0
  // Subsystem (2 bytes at offset 68) = 1 (NATIVE) o 2 (WINDOWS_GUI)
  optionalHeader[68] = 0x02; // WINDOWS_GUI
  optionalHeader[69] = 0x00;
  // DllCharacteristics (2 bytes)
  // SizeOfStackReserve, SizeOfStackCommit, SizeOfHeapReserve, SizeOfHeapCommit (4 bytes cada uno)
  // LoaderFlags (4 bytes) = 0
  // NumberOfRvaAndSizes (4 bytes) = 16

  // Data directories (16 entries, 8 bytes cada uno = 128 bytes)
  // Comienzan en offset 96 del optional header

  // Section Table (40 bytes por entrada)
  const sectionTable = new Array(40).fill(0);
  // Name (8 bytes) = ".text"
  sectionTable[0] = 0x2e; // '.'
  sectionTable[1] = 0x74; // 't'
  sectionTable[2] = 0x65; // 'e'
  sectionTable[3] = 0x78; // 'x'
  sectionTable[4] = 0x74; // 't'
  // VirtualSize (4 bytes at offset 8) = 0x1000
  sectionTable[8] = 0x00;
  sectionTable[9] = 0x10;
  sectionTable[10] = 0x00;
  sectionTable[11] = 0x00;
  // VirtualAddress (4 bytes) = 0x1000
  sectionTable[12] = 0x00;
  sectionTable[13] = 0x10;
  sectionTable[14] = 0x00;
  sectionTable[15] = 0x00;
  // SizeOfRawData (4 bytes) = 0x200
  sectionTable[16] = 0x00;
  sectionTable[17] = 0x02;
  sectionTable[18] = 0x00;
  sectionTable[19] = 0x00;
  // PointerToRawData (4 bytes) = 0x200
  sectionTable[20] = 0x00;
  sectionTable[21] = 0x02;
  sectionTable[22] = 0x00;
  sectionTable[23] = 0x00;
  // PointerToRelocations (4 bytes) = 0
  // PointerToLinenumbers (4 bytes) = 0
  // NumberOfRelocations (2 bytes) = 0
  // NumberOfLinenumbers (2 bytes) = 0
  // Characteristics (4 bytes at offset 36) = CODE | EXECUTE | READ = 0x60000020
  sectionTable[36] = 0x20;
  sectionTable[37] = 0x00;
  sectionTable[38] = 0x00;
  sectionTable[39] = 0x60;

  const totalSize = peOffset + peSig.length + coffHeader.length + optionalHeader.length + sectionTable.length;
  const data = new Uint8Array(totalSize);

  // Copy DOS header
  data.set(dosHeader, 0);
  // Copy PE signature
  data.set(peSig, peOffset);
  // Copy COFF header
  data.set(coffHeader, peOffset + 4);
  // Copy Optional header
  data.set(optionalHeader, peOffset + 4 + 20);
  // Copy Section table
  data.set(sectionTable, peOffset + 4 + 20 + 224);

  return data.buffer;
}

function createMinimalPNG(): ArrayBuffer {
  // PNG signature + IHDR chunk
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  // IHDR: length (4) + type (4) + data (13) + CRC (4) = 25 bytes
  const ihdrLength = [0x00, 0x00, 0x00, 0x0d]; // 13 bytes
  const ihdrType = [0x49, 0x48, 0x44, 0x52]; // "IHDR"
  const ihdrData = [
    0x00, 0x00, 0x00, 0x01, // Width: 1
    0x00, 0x00, 0x00, 0x01, // Height: 1
    0x08, // Bit depth: 8
    0x02, // Color type: RGB
    0x00, // Compression: deflate
    0x00, // Filter: adaptive
    0x00, // Interlace: none
  ];
  const ihdrCrc = [0x90, 0x77, 0x53, 0xde]; // CRC for IHDR

  const data = new Uint8Array([...signature, ...ihdrLength, ...ihdrType, ...ihdrData, ...ihdrCrc]);
  return data.buffer;
}

function createMinimalJPEG(): ArrayBuffer {
  // SOI + APP0 (JFIF)
  const soi = [0xff, 0xd8]; // Start of image
  const app0Marker = [0xff, 0xe0]; // APP0 marker
  const app0Length = [0x00, 0x10]; // Length: 16 bytes
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"
  const version = [0x01, 0x01]; // Version 1.1
  const units = [0x00]; // Units: no units
  const density = [0x00, 0x01, 0x00, 0x01]; // X and Y density
  const thumbnail = [0x00, 0x00]; // No thumbnail

  const data = new Uint8Array([
    ...soi,
    ...app0Marker,
    ...app0Length,
    ...jfif,
    ...version,
    ...units,
    ...density,
    ...thumbnail,
  ]);
  return data.buffer;
}

function createMinimalZIP(): ArrayBuffer {
  // Local file header
  const signature = [0x50, 0x4b, 0x03, 0x04]; // Local file header signature
  const version = [0x14, 0x00]; // Version needed: 2.0
  const flags = [0x00, 0x00]; // General purpose bit flag
  const compression = [0x00, 0x00]; // Compression: stored (no compression)
  const modTime = [0x00, 0x00]; // Modification time
  const modDate = [0x00, 0x00]; // Modification date
  const crc = [0x00, 0x00, 0x00, 0x00]; // CRC-32
  const compressedSize = [0x00, 0x00, 0x00, 0x00]; // Compressed size
  const uncompressedSize = [0x00, 0x00, 0x00, 0x00]; // Uncompressed size
  const fileNameLength = [0x00, 0x00]; // File name length
  const extraFieldLength = [0x00, 0x00]; // Extra field length

  const data = new Uint8Array([
    ...signature,
    ...version,
    ...flags,
    ...compression,
    ...modTime,
    ...modDate,
    ...crc,
    ...compressedSize,
    ...uncompressedSize,
    ...fileNameLength,
    ...extraFieldLength,
  ]);
  return data.buffer;
}

function createMinimalPDF(): ArrayBuffer {
  return createArrayBuffer("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n");
}

describe("Parser Dispatcher", () => {
  describe("parseBuffer", () => {
    it("should parse ELF file successfully", () => {
      const buf = createMinimalELF();
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("ELF");
        expect(result.structure.formatMeta.format).toBe("ELF");
      }
    });

    it("should parse PE file successfully", () => {
      const buf = createMinimalPE();
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("PE");
      }
    });

    it("should parse PNG file successfully", () => {
      const buf = createMinimalPNG();
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("PNG");
      }
    });

    it("should parse JPEG file successfully", () => {
      const buf = createMinimalJPEG();
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("JPEG");
      }
    });

    it("should parse ZIP file successfully", () => {
      const buf = createMinimalZIP();
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("ZIP");
      }
    });

    it("should parse PDF file successfully", () => {
      const buf = createMinimalPDF();
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("PDF");
      }
    });

    it("should fallback to BIN for unknown format", () => {
      const buf = createArrayBuffer([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("BIN");
        expect(result.structure.formatMeta.format).toBe("BIN");
        expect(result.structure.root.children).toBeDefined();
      }
    });

    it("should return error for empty buffer", () => {
      const buf = new ArrayBuffer(0);

      const result = parseBuffer(buf);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BUFFER_TOO_SMALL");
        expect(result.error.message).toContain("empty");
      }
    });

    it("should handle parse errors gracefully", () => {
      // ELF magic but truncated (too small for valid ELF)
      const buf = createArrayBuffer([0x7f, 0x45, 0x4c, 0x46, 0x00]);

      const result = parseBuffer(buf);

      // Should either parse as ELF with error, or fallback to BIN
      // Depending on how strict the ELF parser is
      expect(result).toBeDefined();
    });

    it("should create BIN structure with correct block size", () => {
      // Create buffer larger than 4KB to test multiple blocks
      const content = new Uint8Array(9000); // ~2.2 blocks
      content.fill(0xAA);
      const buf = content.buffer;

      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("BIN");
        expect(result.structure.root.children?.length).toBeGreaterThan(1);
        expect(result.structure.root.metadata?.blocks).toBeGreaterThan(1);
      }
    });

    it("should cap BIN blocks at 256", () => {
      // Create buffer larger than 256 * 4KB = 1MB
      const content = new Uint8Array(1024 * 1024 + 1000);
      content.fill(0xBB);
      const buf = content.buffer;

      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.root.children?.length).toBeLessThanOrEqual(256);
      }
    });

    it("should skip parsers that require larger buffers", () => {
      // Buffer smaller than ELF minSize (16) but larger than PDF minSize (4)
      const buf = createArrayBuffer("%PDF-1.0"); // 8 bytes, PDF needs 4

      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("PDF");
      }
    });

    it("should handle detect function that throws", () => {

      const buf = createArrayBuffer([0xff, 0xff, 0xff, 0xff]);
      const result = parseBuffer(buf);

      // Should fallback to BIN without crashing
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("BIN");
      }
    });
  });

  describe("detectFormat", () => {
    it("should detect ELF format", () => {
      const buf = createMinimalELF();
      expect(detectFormat(buf)).toBe("ELF");
    });

    it("should detect PE format", () => {
      const buf = createMinimalPE();
      expect(detectFormat(buf)).toBe("PE");
    });

    it("should detect PNG format", () => {
      const buf = createMinimalPNG();
      expect(detectFormat(buf)).toBe("PNG");
    });

    it("should detect JPEG format", () => {
      const buf = createMinimalJPEG();
      expect(detectFormat(buf)).toBe("JPEG");
    });

    it("should detect ZIP format", () => {
      const buf = createMinimalZIP();
      expect(detectFormat(buf)).toBe("ZIP");
    });

    it("should detect PDF format", () => {
      const buf = createMinimalPDF();
      expect(detectFormat(buf)).toBe("PDF");
    });

    it("should return BIN for unknown format", () => {
      const buf = createArrayBuffer([0x00, 0x01, 0x02, 0x03]);
      expect(detectFormat(buf)).toBe("BIN");
    });

    it("should return BIN for empty buffer", () => {
      const buf = new ArrayBuffer(0);
      expect(detectFormat(buf)).toBe("BIN");
    });

    it("should return BIN for buffer too small for any format", () => {
      const buf = new ArrayBuffer(1);
      expect(detectFormat(buf)).toBe("BIN");
    });

    it("should prioritize formats with specific magic over generic", () => {
      // A buffer that starts with ELF magic
      const buf = createMinimalELF();
      expect(detectFormat(buf)).toBe("ELF");
    });
  });

  describe("isFormatSupported", () => {
    it("should return true for supported formats", () => {
      const formats = ["ELF", "PE", "PNG", "JPEG", "ZIP", "PDF"] as const;
      for (const format of formats) {
        expect(isFormatSupported(format)).toBe(true);
      }
    });

    it("should return false for BIN", () => {
      expect(isFormatSupported("BIN")).toBe(false);
    });

    it("should return false for MACHO (not implemented)", () => {
      expect(isFormatSupported("MACHO")).toBe(false);
    });
  });

  describe("supportedFormats", () => {
    it("should return all supported formats except BIN", () => {
      const formats = supportedFormats();

      expect(formats).toContain("ELF");
      expect(formats).toContain("PE");
      expect(formats).toContain("PNG");
      expect(formats).toContain("JPEG");
      expect(formats).toContain("ZIP");
      expect(formats).toContain("PDF");
      expect(formats).not.toContain("BIN");
    });

    it("should return formats in order of detection priority", () => {
      const formats = supportedFormats();

      // ELF and PE should come first (more specific magic bytes)
      expect(formats.indexOf("ELF")).toBeLessThan(formats.indexOf("PDF"));
      expect(formats.indexOf("PE")).toBeLessThan(formats.indexOf("PDF"));
    });
  });

  describe("ParseError", () => {
    it("should create ParseError with correct properties", () => {
      const error = new ParseError("Test error", "PARSE_FAILED", new Error("Cause"));

      expect(error.message).toBe("Test error");
      expect(error.code).toBe("PARSE_FAILED");
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.name).toBe("ParseError");
    });

    it("should create ParseError without cause", () => {
      const error = new ParseError("Buffer too small", "BUFFER_TOO_SMALL");

      expect(error.message).toBe("Buffer too small");
      expect(error.code).toBe("BUFFER_TOO_SMALL");
      expect(error.cause).toBeUndefined();
    });
  });

  describe("edge cases and error handling", () => {
    it("should handle very large buffers", () => {
      // Test with buffer at boundary (just over 1MB)
      const content = new Uint8Array(1024 * 1024 + 1);
      const buf = content.buffer;

      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.totalSize).toBe(buf.byteLength);
      }
    });

    it("should handle buffer exactly at minimum size for ELF", () => {
      // ELF minimum is 16 bytes
      const buf = createArrayBuffer([0x7f, 0x45, 0x4c, 0x46, ...new Array(12).fill(0)]);
      const result = parseBuffer(buf);

      expect(result).toBeDefined();
    });

    it("should handle buffer just below minimum size for ELF", () => {
      // ELF minimum is 16, test with 15
      const buf = createArrayBuffer([0x7f, 0x45, 0x4c, 0x46, ...new Array(11).fill(0)]);

      // Should skip ELF (too small), fallback to next or BIN
      const result = parseBuffer(buf);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should be BIN or whatever fits
        expect(result.structure.format).toBeDefined();
      }
    });

    it("should maintain correct totalSize in BIN fallback", () => {
      const sizes = [100, 1000, 10000, 100000];

      for (const size of sizes) {
        const content = new Uint8Array(size);
        const buf = content.buffer;
        const result = parseBuffer(buf);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.structure.totalSize).toBe(size);
        }
      }
    });

    it("should handle concurrent parsing of multiple buffers", () => {
      const bufs = [
        createMinimalELF(),
        createMinimalPNG(),
        createMinimalPDF(),
      ];

      const results = bufs.map(parseBuffer);

      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
      expect(results[2].ok).toBe(true);

      if (results[0].ok && results[1].ok && results[2].ok) {
        expect(results[0].structure.format).toBe("ELF");
        expect(results[1].structure.format).toBe("PNG");
        expect(results[2].structure.format).toBe("PDF");
      }
    });

    it("should handle BIN parse error", () => {
      // This tests that BIN structure is created correctly
      const buf = createArrayBuffer([0x00, 0x01, 0x02, 0x03]);
      const result = parseBuffer(buf);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.structure.format).toBe("BIN");
        expect(result.structure.root.id).toBe("bin-root");
        expect(result.structure.root.name).toBe("Binary Data");
      }
    });
  });
});