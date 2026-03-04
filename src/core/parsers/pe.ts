/**
 * @file src/core/parsers/pe.ts
 * PE (Portable Executable) parser: DOS header, PE header, Optional header, section table.
 * Supports PE32 and PE32+ (64-bit).
 */

import type { ParsedStructure, FormatMetadata, ByteCount, VirtualAddress } from "@app-types/index";
import { Offset, Bytes, Range, SectionBuilder } from "@app-types/index";
import type { BinaryBuffer } from "../buffer";
import { readUint8, readUint16, readUint32, readUint64, compareBytes } from "../buffer";

// Magic bytes

/** DOS MZ header signature. */
const DOS_MAGIC = new Uint8Array([0x4d, 0x5a]); // "MZ"
/** PE signature. */
const PE_SIG = new Uint8Array([0x50, 0x45, 0x00, 0x00]); // "PE\0\0"

// Constants

/**
 * Map of COFF machine type values to their human-readable names.
 */
const MACHINE_TYPES: Record<number, string> = {
  0x0000: "IMAGE_FILE_MACHINE_UNKNOWN",
  0x014c: "x86 (i386)",
  0x0166: "MIPS R3000",
  0x0169: "MIPS little-endian WCE v2",
  0x01a2: "Hitachi SH3",
  0x01c0: "ARM little-endian",
  0x01c2: "ARM Thumb / Thumb-2 (Windows CE)",
  0x01c4: "ARM Thumb-2",
  0x01f0: "PowerPC little-endian",
  0x0200: "IA-64 (Itanium)",
  0x0266: "MIPS16",
  0x0366: "MIPS with FPU",
  0x0466: "MIPS16 with FPU",
  0x5032: "RISC-V 32-bit",
  0x5064: "RISC-V 64-bit",
  0x8664: "x86-64 (AMD64)",
  0xaa64: "AArch64 (ARM64)",
};

/**
 * Map of Optional Header subsystem values to their human-readable names.
 */
const SUBSYSTEMS: Record<number, string> = {
  1: "Native",
  2: "Windows GUI",
  3: "Windows CUI (console)",
  5: "OS/2 CUI",
  7: "POSIX CUI",
  9: "Windows CE GUI",
  10: "EFI Application",
  11: "EFI Boot Service Driver",
  12: "EFI Runtime Driver",
  13: "EFI ROM image",
  14: "Xbox",
  16: "Windows Boot Application",
};

/**
 * Bit-flag table for the COFF File Header `Characteristics` field.
 * Each entry is a `[mask, name]` pair.
 */
const CHARACTERISTICS: Array<[number, string]> = [
  [0x0001, "RELOCS_STRIPPED"],
  [0x0002, "EXECUTABLE_IMAGE"],
  [0x0004, "LINE_NUMS_STRIPPED"],
  [0x0008, "LOCAL_SYMS_STRIPPED"],
  [0x0020, "LARGE_ADDRESS_AWARE"],
  [0x0100, "x32BIT_MACHINE"],
  [0x0200, "DEBUG_STRIPPED"],
  [0x1000, "SYSTEM"],
  [0x2000, "DLL"],
];

/**
 * Bit-flag table for the section header `Characteristics` field.
 * Each entry is a `[mask, name]` pair.
 */
const SECTION_CHARACTERISTICS: Array<[number, string]> = [
  [0x00000020, "CNT_CODE"],
  [0x00000040, "CNT_INITIALIZED_DATA"],
  [0x00000080, "CNT_UNINITIALIZED_DATA"],
  [0x02000000, "MEM_DISCARDABLE"],
  [0x10000000, "MEM_SHARED"],
  [0x20000000, "MEM_EXECUTE"],
  [0x40000000, "MEM_READ"],
  [0x80000000, "MEM_WRITE"],
];

// Helpers

/**
 * Reads a null-terminated ASCII string from `buf`, up to `maxLen` bytes.
 * Non-printable bytes (outside `0x20`–`0x7E`) are replaced with `'?'`.
 *
 * @param buf         - The binary buffer to read from.
 * @param startOffset - Zero-based byte offset at which reading begins.
 * @param maxLen      - Maximum number of bytes to read.
 * @returns The decoded string, stopping at the first null byte.
 */
function readAsciiStr(buf: BinaryBuffer, startOffset: number, maxLen: number): string {
  let out = "";
  for (let i = 0; i < maxLen && startOffset + i < buf.byteLength; i++) {
    const b = readUint8(buf, Offset.create(startOffset + i));
    if (b === 0) break; // null-terminated
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "?";
  }
  return out;
}

/**
 * Converts a numeric flags field into a human-readable string by joining the
 * names of all matching bit masks from `table`.
 *
 * @param value - The flags value to decode.
 * @param table - Array of `[mask, name]` pairs to test against.
 * @returns A `" | "`-separated string of matching flag names, or `"none"`.
 */
function flagsStr(value: number, table: Array<[number, string]>): string {
  return (
    table
      .filter(([mask]) => (value & mask) !== 0)
      .map(([, name]) => name)
      .join(" | ") || "none"
  );
}

// Detect

/**
 * Detects whether `buf` contains a PE (Portable Executable) image by verifying
 * the DOS `MZ` signature at offset 0 and the `PE\0\0` signature at the offset
 * indicated by `e_lfanew` (byte 0x3C).
 *
 * @param buf - The binary buffer to inspect.
 * @returns `true` if the buffer contains a valid PE image.
 */
export function detect(buf: BinaryBuffer): boolean {
  if (buf.byteLength < 64) return false;
  if (!compareBytes(buf, Offset.create(0), DOS_MAGIC)) return false;

  // e_lfanew (offset 0x3C): pointer to the PE signature
  const peOffset = readUint32(buf, Offset.create(0x3c), true);
  if (peOffset + 4 > buf.byteLength) return false;

  return compareBytes(buf, Offset.create(peOffset), PE_SIG);
}

// Parse

/**
 * Parses a PE (Portable Executable) image and returns its structured representation.
 *
 * Produces the following sections:
 * - **DOS Header** – MZ stub up to the PE signature offset.
 * - **PE Signature** – the four-byte `PE\0\0` marker.
 * - **COFF File Header** – machine type, section count, timestamp, and characteristics.
 * - **Optional Header** – entry point RVA, image base, subsystem (PE32 or PE32+).
 * - **Section Table** – one child entry per section header, plus a raw-data section
 *   added directly to the root for each section with non-zero raw content.
 *
 * Supports both PE32 (`magic 0x10B`) and PE32+ / 64-bit (`magic 0x20B`) formats.
 * Section table parsing is capped at **96 entries** as a safety limit.
 *
 * @param buf - Raw PE image bytes.
 * @returns A {@link ParsedStructure} with `format` set to `'PE'` and `entryPoint`
 *   set to the absolute virtual address of the image entry point, or `undefined`
 *   if the Optional Header is absent or truncated.
 */
export function parse(buf: BinaryBuffer): ParsedStructure {
  // DOS Header (64 bytes)
  const peOffset = readUint32(buf, Offset.create(0x3c), true);

  const rootBuilder = new SectionBuilder()
    .id("pe-root")
    .name("PE — Portable Executable")
    .type("container")
    .range(Range.create(Offset.create(0), Offset.create(buf.byteLength - 1)))
    .flags({ readable: true, writable: false, executable: false });

  rootBuilder.addChild(
    new SectionBuilder()
      .id("pe-dos-header")
      .name("DOS Header (MZ)")
      .type("metadata")
      .range(Range.create(Offset.create(0), Offset.create(Math.min(peOffset - 1, buf.byteLength - 1))))
      .flags({ readable: true, writable: false, executable: false })
      .meta("e_lfanew", `0x${peOffset.toString(16)}`)
      .build(),
  );

  // PE Signature (4 bytes: "PE\0\0")
  rootBuilder.addChild(
    new SectionBuilder()
      .id("pe-signature")
      .name('PE Signature ("PE\\0\\0")')
      .type("metadata")
      .range(Range.create(Offset.create(peOffset), Offset.create(Math.min(peOffset + 3, buf.byteLength - 1))))
      .flags({ readable: true, writable: false, executable: false })
      .build(),
  );

  // COFF File Header (20 bytes)
  const coffBase = peOffset + 4;

  if (coffBase + 20 > buf.byteLength) {
    // Buffer too short for the COFF header
    const formatMeta: FormatMetadata = { format: "PE", peType: "PE32" };
    return {
      format: "PE",
      formatMeta,
      root: rootBuilder.build(),
      totalSize: buf.byteLength as ByteCount,
      entryPoint: undefined,
    };
  }

  const machine = readUint16(buf, Offset.create(coffBase), true);
  const numSections = readUint16(buf, Offset.create(coffBase + 2), true);
  const timeDateStamp = readUint32(buf, Offset.create(coffBase + 4), true);
  const optHeaderSize = readUint16(buf, Offset.create(coffBase + 16), true);
  const characteristics = readUint16(buf, Offset.create(coffBase + 18), true);

  const machineName = MACHINE_TYPES[machine] ?? `machine(0x${machine.toString(16)})`;

  rootBuilder.addChild(
    new SectionBuilder()
      .id("pe-coff-header")
      .name("COFF File Header")
      .type("metadata")
      .range(Range.create(Offset.create(coffBase), Offset.create(Math.min(coffBase + 19, buf.byteLength - 1))))
      .flags({ readable: true, writable: false, executable: false })
      .meta("machine", machineName)
      .meta("sections", numSections)
      .meta("timeDateStamp", new Date(timeDateStamp * 1000).toISOString())
      .meta("characteristics", flagsStr(characteristics, CHARACTERISTICS))
      .build(),
  );

  // Optional Header
  const optBase = coffBase + 20;
  const optMagic = optBase + optHeaderSize <= buf.byteLength ? readUint16(buf, Offset.create(optBase), true) : 0;

  // 0x10b = PE32, 0x20b = PE32+ (64-bit)
  const isPE32Plus = optMagic === 0x20b;
  const peType = isPE32Plus ? ("PE32+" as const) : ("PE32" as const);

  let entryPoint: VirtualAddress | undefined = undefined;
  let imageBase: bigint = 0n;
  let subsystem = 0;

  if (optHeaderSize > 0 && optBase + optHeaderSize <= buf.byteLength) {
    // AddressOfEntryPoint: offset +16 from optBase (same for PE32 and PE32+)
    const entryRva = readUint32(buf, Offset.create(optBase + 16), true);
    // ImageBase: offset +28 (4 bytes, PE32) or +24 (8 bytes, PE32+)
    imageBase = isPE32Plus ? readUint64(buf, Offset.create(optBase + 24), true) : BigInt(readUint32(buf, Offset.create(optBase + 28), true));
    // Subsystem: +68 from optBase — same offset in both PE32 and PE32+
    subsystem = readUint16(buf, Offset.create(optBase + 68), true);

    entryPoint = (imageBase + BigInt(entryRva)) as VirtualAddress;

    rootBuilder.addChild(
      new SectionBuilder()
        .id("pe-optional-header")
        .name(`Optional Header (${peType})`)
        .type("metadata")
        .range(Range.create(Offset.create(optBase), Offset.create(optBase + optHeaderSize - 1)))
        .flags({ readable: true, writable: false, executable: false })
        .meta("magic", `0x${optMagic.toString(16)}`)
        .meta("type", peType)
        .meta("entryRVA", `0x${entryRva.toString(16)}`)
        .meta("imageBase", `0x${imageBase.toString(16)}`)
        .meta("subsystem", SUBSYSTEMS[subsystem] ?? `subsystem(${subsystem})`)
        .build(),
    );
  }

  // Section Table
  const sectionTableBase = optBase + optHeaderSize;

  if (numSections > 0 && sectionTableBase + numSections * 40 <= buf.byteLength) {
    const secTableEnd = sectionTableBase + numSections * 40 - 1;

    const secTableBuilder = new SectionBuilder()
      .id("pe-section-table")
      .name(`Section Table (${numSections} sections)`)
      .type("container")
      .range(Range.create(Offset.create(sectionTableBase), Offset.create(Math.min(secTableEnd, buf.byteLength - 1))))
      .flags({ readable: true, writable: false, executable: false })
      .meta("count", numSections);

    for (let i = 0; i < numSections && i < 96; i++) {
      const secBase = sectionTableBase + i * 40;
      if (secBase + 40 > buf.byteLength) break;

      // Name: 8 bytes, null-padded ASCII
      const secName = readAsciiStr(buf, secBase, 8);
      // VirtualSize (4), VirtualAddress (4), SizeOfRawData (4), PointerToRawData (4)
      const virtSize = readUint32(buf, Offset.create(secBase + 8), true);
      const virtAddr = readUint32(buf, Offset.create(secBase + 12), true);
      const rawSize = readUint32(buf, Offset.create(secBase + 16), true);
      const rawOffset = readUint32(buf, Offset.create(secBase + 20), true);
      const secChars = readUint32(buf, Offset.create(secBase + 36), true);

      const isExec = (secChars & 0x20000000) !== 0;
      const isWrite = (secChars & 0x80000000) !== 0;
      const isRead = (secChars & 0x40000000) !== 0;

      // Raw content range within the file
      const rawEnd = rawOffset + rawSize;
      const secType = isExec ? ("data" as const) : ("metadata" as const);

      // Section table entry
      secTableBuilder.addChild(
        new SectionBuilder()
          .id(`pe-sec-${i}`)
          .name(`${secName || `section[${i}]`} — RVA 0x${virtAddr.toString(16)}, ${virtSize} bytes`)
          .type(secType)
          .range(Range.create(Offset.create(secBase), Offset.create(Math.min(secBase + 39, buf.byteLength - 1))))
          .virtualAddr((imageBase + BigInt(virtAddr)) as VirtualAddress)
          .flags({ readable: isRead, writable: isWrite, executable: isExec })
          .meta("name", secName)
          .meta("virtualAddress", `0x${virtAddr.toString(16)}`)
          .meta("virtualSize", virtSize)
          .meta("rawOffset", `0x${rawOffset.toString(16)}`)
          .meta("rawSize", rawSize)
          .meta("characteristics", flagsStr(secChars, SECTION_CHARACTERISTICS))
          .build(),
      );

      if (rawSize > 0 && rawOffset > 0 && rawOffset < buf.byteLength) {
        rootBuilder.addChild(
          new SectionBuilder()
            .id(`pe-sec-data-${i}`)
            .name(`${secName || `section[${i}]`} raw data`)
            .type(secType)
            .range(Range.create(Offset.create(rawOffset), Offset.create(Math.min(rawEnd - 1, buf.byteLength - 1))))
            .virtualAddr((imageBase + BigInt(virtAddr)) as VirtualAddress)
            .flags({ readable: isRead, writable: isWrite, executable: isExec })
            .meta("name", secName)
            .meta("size", rawSize)
            .meta("rva", `0x${virtAddr.toString(16)}`)
            .build(),
        );
      }
    }

    rootBuilder.addChild(secTableBuilder.build());
  }

  const formatMeta: FormatMetadata = { format: "PE", peType };

  return {
    format: "PE",
    formatMeta,
    root: rootBuilder.meta("machine", machineName).meta("sections", numSections).meta("type", peType).build(),
    totalSize: buf.byteLength as ByteCount,
    entryPoint,
  };
}
