/**
 * @file src/core/parsers/zip.ts
 * ZIP parser: local file headers, central directory, EOCD.
 */

import type { ParsedStructure, FormatMetadata, ByteCount } from "@app-types/index";
import { Offset, Bytes, Range, SectionBuilder } from "@app-types/index";
import type { BinaryBuffer } from "@core/buffer";
import { readUint8, readUint16, readUint32, compareBytes } from "@core/buffer";

// Signatures (little-endian)

/** Local file entry signature: `PK\x03\x04`. */
const SIG_LOCAL = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
/** Central directory entry signature: `PK\x01\x02`. */
const SIG_CENTRAL = new Uint8Array([0x50, 0x4b, 0x01, 0x02]); // PK\x01\x02
/** End of Central Directory record signature: `PK\x05\x06`. */
const SIG_EOCD = new Uint8Array([0x50, 0x4b, 0x05, 0x06]); // PK\x05\x06
/** ZIP64 End of Central Directory record signature: `PK\x06\x06`. */
const SIG_EOCD64 = new Uint8Array([0x50, 0x4b, 0x06, 0x06]); // PK\x06\x06 (ZIP64)

// Compression methods

/**
 * Map of ZIP compression method IDs to their human-readable names.
 */
const COMPRESSION = new Map<number, string>([
  [0, "Stored"],
  [8, "Deflated"],
  [9, "Deflate64"],
  [12, "BZIP2"],
  [14, "LZMA"],
  [98, "PPMd"],
]);

// Helpers

/**
 * Reads bytes from `buf` as a printable ASCII string.
 * Bytes outside `0x20`–`0x7E` are replaced with `'?'`.
 *
 * @param buf         - The binary buffer to read from.
 * @param startOffset - Zero-based byte offset at which reading begins.
 * @param length      - Number of bytes to read.
 * @returns The decoded string, with non-printable bytes replaced by `'?'`.
 */
function readAsciiStr(buf: BinaryBuffer, startOffset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && startOffset + i < buf.byteLength; i++) {
    const b = readUint8(buf, Offset.create(startOffset + i));
    // Printable ASCII only; anything else → '?'
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "?";
  }
  return out;
}

// Detect

/**
 * Detects whether `buf` contains a ZIP archive by checking the `PK\x03\x04`
 * signature at offset 0. Also matches JAR, APK, DOCX, and other ZIP-based formats.
 *
 * @param buf - The binary buffer to inspect.
 * @returns `true` if the buffer starts with a valid ZIP signature.
 */
export function detect(buf: BinaryBuffer): boolean {
  // Also matches JARs, APKs, DOCX, etc. — all share the PK signature
  return buf.byteLength >= 4 && compareBytes(buf, Offset.create(0), SIG_LOCAL);
}

// Parse

/**
 * Parses a ZIP archive and returns its structured representation.
 *
 * Produces three kinds of sections:
 * - **Local file entries** – one per file, with child sections for the local header and data.
 * - **Central directory** – single metadata section covering all CD records.
 * - **EOCD** – end-of-central-directory record, including any optional comment.
 *
 * Parsing stops after 2 000 entries to avoid unbounded loops on crafted input.
 *
 * @param buf - Raw ZIP archive bytes.
 * @returns A {@link ParsedStructure} with `format` set to `'ZIP'`.
 */
export function parse(buf: BinaryBuffer): ParsedStructure {
  let entries = 0;
  let totalComp = 0;
  let totalUcomp = 0;

  const rootBuilder = new SectionBuilder()
    .id("zip-root")
    .name("ZIP Archive")
    .type("container")
    .range(Range.create(Offset.create(0), Offset.create(buf.byteLength - 1)))
    .flags({ readable: true, writable: false, executable: false });

  // 1. Local File Headers
  let offset = 0;

  while (offset + 30 <= buf.byteLength) {
    if (!compareBytes(buf, Offset.create(offset), SIG_LOCAL)) break;

    // Local file header fields (all little-endian)
    // offset+4: version needed (2)
    // offset+6: general purpose bit flag (2)
    const compression = readUint16(buf, Offset.create(offset + 8), true);
    // offset+10: last mod time (2), offset+12: last mod date (2)
    // offset+14: crc-32 (4)
    const compSize = readUint32(buf, Offset.create(offset + 18), true);
    const uncompSize = readUint32(buf, Offset.create(offset + 22), true);
    const filenameLen = readUint16(buf, Offset.create(offset + 26), true);
    const extraLen = readUint16(buf, Offset.create(offset + 28), true);

    const headerSize = 30 + filenameLen + extraLen;
    const filename = readAsciiStr(buf, offset + 30, filenameLen);
    const dataStart = offset + headerSize;
    const dataEnd = dataStart + compSize; // exclusive

    const comprName = COMPRESSION.get(compression) ?? `method(${compression})`;

    entries++;
    totalComp += compSize;
    totalUcomp += uncompSize;

    const entryEnd = Math.min(dataEnd - 1, buf.byteLength - 1);

    const entryBuilder = new SectionBuilder()
      .id(`zip-entry-${entries}`)
      .name(filename || `Entry ${entries}`)
      .type("container")
      .range(Range.create(Offset.create(offset), Offset.create(entryEnd < offset ? offset : entryEnd)))
      .flags({ readable: true, writable: false, executable: false })
      .meta("compression", comprName)
      .meta("compressedSize", compSize)
      .meta("uncompressedSize", uncompSize)
      .meta("filename", filename);

    // Sub-section: local header
    entryBuilder.addChild(
      new SectionBuilder()
        .id(`zip-lh-${entries}`)
        .name("Local File Header")
        .type("metadata")
        .range(Range.create(Offset.create(offset), Offset.create(Math.min(offset + headerSize - 1, buf.byteLength - 1))))
        .flags({ readable: true, writable: false, executable: false })
        .meta("filename", filename)
        .meta("compression", comprName)
        .build(),
    );

    // Sub-section: file data
    if (compSize > 0 && dataStart < buf.byteLength) {
      entryBuilder.addChild(
        new SectionBuilder()
          .id(`zip-data-${entries}`)
          .name(`File Data — ${comprName} (${compSize} bytes)`)
          .type("data")
          .range(Range.create(Offset.create(dataStart), Offset.create(Math.min(dataEnd - 1, buf.byteLength - 1))))
          .flags({ readable: true, writable: false, executable: false })
          .build(),
      );
    }

    rootBuilder.addChild(entryBuilder.build());

    offset = dataEnd;
    if (entries >= 2000) break; // safety limit
  }

  // 2. Central Directory
  const cdStart = offset;

  while (offset + 46 <= buf.byteLength) {
    if (!compareBytes(buf, Offset.create(offset), SIG_CENTRAL)) break;

    const filenameLen = readUint16(buf, Offset.create(offset + 28), true);
    const extraLen = readUint16(buf, Offset.create(offset + 30), true);
    const commentLen = readUint16(buf, Offset.create(offset + 32), true);

    offset += 46 + filenameLen + extraLen + commentLen;
  }

  if (offset > cdStart) {
    rootBuilder.addChild(
      new SectionBuilder()
        .id("zip-central-dir")
        .name(`Central Directory (${entries} entries)`)
        .type("metadata")
        .range(Range.create(Offset.create(cdStart), Offset.create(offset - 1)))
        .flags({ readable: true, writable: false, executable: false })
        .meta("entries", entries)
        .build(),
    );
  }

  // 3. EOCD — search backward from the end of the buffer (supports comment)
  // The EOCD may carry a comment of up to 65 535 bytes
  const searchStart = Math.max(0, buf.byteLength - 22 - 65535);

  for (let i = buf.byteLength - 22; i >= searchStart; i--) {
    if (compareBytes(buf, Offset.create(i), SIG_EOCD)) {
      const commentLen = readUint16(buf, Offset.create(i + 20), true);
      const eocdEnd = Math.min(i + 21 + commentLen, buf.byteLength - 1);

      rootBuilder.addChild(
        new SectionBuilder()
          .id("zip-eocd")
          .name("End of Central Directory Record")
          .type("metadata")
          .range(Range.create(Offset.create(i), Offset.create(eocdEnd)))
          .flags({ readable: true, writable: false, executable: false })
          .meta("totalEntries", entries)
          .meta("commentLength", commentLen)
          .build(),
      );
      break;
    }
  }

  const formatMeta: FormatMetadata = { format: "ZIP", entries };

  return {
    format: "ZIP",
    formatMeta,
    root: rootBuilder.meta("entries", entries).meta("totalCompressedSize", totalComp).meta("totalUncompressedSize", totalUcomp).build(),
    totalSize: buf.byteLength as ByteCount,
    entryPoint: undefined,
  };
}
