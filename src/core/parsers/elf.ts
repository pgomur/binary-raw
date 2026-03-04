/**
 * @file src/core/parsers/elf.ts
 * ELF32/ELF64 parser: ELF header, program headers, section headers.
 * Supports both little-endian and big-endian encodings.
 */

import type { ParsedStructure, FormatMetadata, ByteCount, VirtualAddress } from "@app-types/index";
import { Offset, Bytes, Range, SectionBuilder } from "@app-types/index";
import type { BinaryBuffer } from "../buffer";
import { readUint8, readUint16, readUint32, readUint64, compareBytes } from "../buffer";

// Magic

/** ELF magic number: `0x7F 'E' 'L' 'F'`. */
const ELF_MAGIC = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);

// Constant tables

/** Map of `EI_CLASS` values to their human-readable class names. */
const ELF_CLASS: Record<number, string> = { 1: "ELF32", 2: "ELF64" };

/** Map of `EI_DATA` values to their human-readable endianness names. */
const ELF_DATA: Record<number, string> = {
  1: "Little Endian (LSB)",
  2: "Big Endian (MSB)",
};

/** Map of `e_type` values to their human-readable object file type names. */
const ELF_TYPE: Record<number, string> = {
  0: "ET_NONE",
  1: "ET_REL — Relocatable",
  2: "ET_EXEC — Executable",
  3: "ET_DYN — Shared object",
  4: "ET_CORE — Core dump",
};

/** Map of `e_machine` values to their human-readable architecture names. */
const ELF_MACHINE: Record<number, string> = {
  0x00: "No machine",
  0x02: "SPARC",
  0x03: "x86 (i386)",
  0x08: "MIPS",
  0x14: "PowerPC",
  0x16: "PowerPC64",
  0x28: "ARM (32-bit)",
  0x32: "IA-64",
  0x3e: "x86-64 (AMD64)",
  0xb7: "AArch64 (ARM64)",
  0xf3: "RISC-V",
};

/** Map of `sh_type` values to their standard `SHT_*` names. */
const SHT_NAMES: Record<number, string> = {
  0: "SHT_NULL",
  1: "SHT_PROGBITS",
  2: "SHT_SYMTAB",
  3: "SHT_STRTAB",
  4: "SHT_RELA",
  5: "SHT_HASH",
  6: "SHT_DYNAMIC",
  7: "SHT_NOTE",
  8: "SHT_NOBITS",
  9: "SHT_REL",
  10: "SHT_SHLIB",
  11: "SHT_DYNSYM",
  14: "SHT_INIT_ARRAY",
  15: "SHT_FINI_ARRAY",
  19: "SHT_GNU_HASH",
  26: "SHT_GNU_VERSYM",
  27: "SHT_GNU_VERNEED",
};

/** Map of `p_type` values to their standard `PT_*` names. */
const PT_NAMES: Record<number, string> = {
  0: "PT_NULL",
  1: "PT_LOAD",
  2: "PT_DYNAMIC",
  3: "PT_INTERP",
  4: "PT_NOTE",
  5: "PT_SHLIB",
  6: "PT_PHDR",
  7: "PT_TLS",
  0x6474e550: "PT_GNU_EH_FRAME",
  0x6474e551: "PT_GNU_STACK",
  0x6474e552: "PT_GNU_RELRO",
};

// Detect

/**
 * Detects whether `buf` contains an ELF image by verifying the
 * `0x7F 'E' 'L' 'F'` magic bytes at offset 0.
 *
 * @param buf - The binary buffer to inspect.
 * @returns `true` if the buffer starts with a valid ELF magic number.
 */
export function detect(buf: BinaryBuffer): boolean {
  return buf.byteLength >= 16 && compareBytes(buf, Offset.create(0), ELF_MAGIC);
}

// Class/endian-aware reader helpers

/**
 * Pre-computed field offsets and address-width-aware read helpers for a given
 * ELF class (32/64-bit) and data encoding (little/big-endian).
 */
interface ElfReader {
  readonly is64: boolean;
  readonly le: boolean;
  /** Reads 4 or 8 bytes depending on class; returns as `number` (truncates for 64-bit values > 2^53). */
  addr: (buf: BinaryBuffer, offset: number) => number;
  /** Reads 4 or 8 bytes depending on class; returns as `bigint` (full precision). */
  addr64: (buf: BinaryBuffer, offset: number) => bigint;
  /** Byte offset of `e_phoff` in the ELF header. */
  phOffset: number;
  /** Byte offset of `e_shoff` in the ELF header. */
  shOffset: number;
  /** Byte offset of `e_phentsize` in the ELF header. */
  phEntSzAt: number;
  /** Byte offset of `e_phnum` in the ELF header. */
  phNumAt: number;
  /** Byte offset of `e_shentsize` in the ELF header. */
  shEntSzAt: number;
  /** Byte offset of `e_shnum` in the ELF header. */
  shNumAt: number;
  /** Byte offset of `e_shstrndx` in the ELF header. */
  shStrndxAt: number;
  /** Total size of the ELF header in bytes (52 for ELF32, 64 for ELF64). */
  headerSize: number;
}

/**
 * Builds an {@link ElfReader} for the given ELF class and data encoding.
 *
 * Field offsets follow the ELF specification:
 * - ELF32: `e_phoff`@28, `e_shoff`@32, `e_phentsize`@42, `e_phnum`@44,
 *   `e_shentsize`@46, `e_shnum`@48, `e_shstrndx`@50
 * - ELF64: `e_phoff`@32, `e_shoff`@40, `e_phentsize`@54, `e_phnum`@56,
 *   `e_shentsize`@58, `e_shnum`@60, `e_shstrndx`@62
 *
 * @param is64 - `true` for ELF64, `false` for ELF32.
 * @param le   - `true` for little-endian, `false` for big-endian.
 * @returns A configured {@link ElfReader} instance.
 */
function makeReader(is64: boolean, le: boolean): ElfReader {
  return {
    is64,
    le,
    addr: (buf: BinaryBuffer, off: number): number => {
      if (is64) return Number(readUint64(buf, Offset.create(off), le));
      return readUint32(buf, Offset.create(off), le);
    },
    addr64: (buf: BinaryBuffer, off: number): bigint => {
      if (is64) return readUint64(buf, Offset.create(off), le);
      return BigInt(readUint32(buf, Offset.create(off), le));
    },
    phOffset: is64 ? 32 : 28,
    shOffset: is64 ? 40 : 32,
    phEntSzAt: is64 ? 54 : 42,
    phNumAt: is64 ? 56 : 44,
    shEntSzAt: is64 ? 58 : 46,
    shNumAt: is64 ? 60 : 48,
    shStrndxAt: is64 ? 62 : 50,
    headerSize: is64 ? 64 : 52,
  };
}

// Parse

/**
 * Parses an ELF image and returns its structured representation.
 *
 * Produces the following sections:
 * - **ELF Header** – identification fields, type, machine, and entry point.
 * - **Program Header Table** – one child entry per program header (capped at 128).
 * - **Section Header Table** – one child entry per section header (capped at 256).
 *
 * Both ELF32 and ELF64 formats are supported, as well as little-endian and
 * big-endian data encodings. Field offsets are resolved at parse time via
 * {@link makeReader}.
 *
 * @param buf - Raw ELF image bytes.
 * @returns A {@link ParsedStructure} with `format` set to `'ELF'` and
 *   `entryPoint` set to the absolute virtual entry address, or `undefined`
 *   if `e_entry` is zero.
 */
export function parse(buf: BinaryBuffer): ParsedStructure {
  // EI_CLASS (offset 4): 1 = 32-bit, 2 = 64-bit
  const elfClass = readUint8(buf, Offset.create(4));
  // EI_DATA  (offset 5): 1 = LE, 2 = BE
  const elfData = readUint8(buf, Offset.create(5));

  const is64 = elfClass === 2;
  const le = elfData === 1;
  const r = makeReader(is64, le);

  // ELF header fields
  const elfType = readUint16(buf, Offset.create(16), le);
  const machine = readUint16(buf, Offset.create(18), le);
  const entry64 = r.addr64(buf, 24); // e_entry

  const phOff = r.addr(buf, r.phOffset);
  const shOff = r.addr(buf, r.shOffset);
  const phEntSz = readUint16(buf, Offset.create(r.phEntSzAt), le);
  const phNum = readUint16(buf, Offset.create(r.phNumAt), le);
  const shEntSz = readUint16(buf, Offset.create(r.shEntSzAt), le);
  const shNum = readUint16(buf, Offset.create(r.shNumAt), le);

  const className = ELF_CLASS[elfClass] ?? `class(${elfClass})`;
  const dataName = ELF_DATA[elfData] ?? `data(${elfData})`;
  const typeName = ELF_TYPE[elfType] ?? `type(0x${elfType.toString(16)})`;
  const machineName = ELF_MACHINE[machine] ?? `machine(0x${machine.toString(16)})`;
  const entryHex = `0x${entry64.toString(16)}`;

  const rootBuilder = new SectionBuilder()
    .id("elf-root")
    .name(`${className} — ${machineName}`)
    .type("container")
    .range(Range.create(Offset.create(0), Offset.create(buf.byteLength - 1)))
    .flags({ readable: true, writable: false, executable: false })
    .meta("class", className)
    .meta("encoding", dataName)
    .meta("type", typeName)
    .meta("machine", machineName)
    .meta("entryPoint", entryHex);

  // ELF Header
  rootBuilder.addChild(
    new SectionBuilder()
      .id("elf-header")
      .name(`ELF Header (${r.headerSize} bytes)`)
      .type("metadata")
      .range(Range.create(Offset.create(0), Offset.create(r.headerSize - 1)))
      .flags({ readable: true, writable: false, executable: false })
      .meta("class", className)
      .meta("encoding", dataName)
      .meta("type", typeName)
      .meta("machine", machineName)
      .meta("entryPoint", entryHex)
      .meta("phNum", phNum)
      .meta("shNum", shNum)
      .build(),
  );

  // Program Headers
  if (phOff > 0 && phNum > 0 && phEntSz > 0 && phOff + phNum * phEntSz <= buf.byteLength) {
    const phGroupEnd = phOff + phNum * phEntSz - 1;

    const phGroup = new SectionBuilder()
      .id("elf-ph-table")
      .name(`Program Header Table (${phNum} entries)`)
      .type("container")
      .range(Range.create(Offset.create(phOff), Offset.create(Math.min(phGroupEnd, buf.byteLength - 1))))
      .flags({ readable: true, writable: false, executable: false })
      .meta("entries", phNum)
      .meta("entrySize", phEntSz);

    for (let i = 0; i < phNum && i < 128; i++) {
      const base = phOff + i * phEntSz;
      if (base + phEntSz > buf.byteLength) break;

      const pType = readUint32(buf, Offset.create(base), le);

      // p_offset and p_filesz positions differ between ELF32 and ELF64
      const pFileOff = is64 ? r.addr(buf, base + 8) : readUint32(buf, Offset.create(base + 4), le);
      const pFileSz = is64 ? r.addr(buf, base + 32) : readUint32(buf, Offset.create(base + 16), le);
      // p_flags: offset 4 in ELF64, offset 24 in ELF32
      const pFlags = is64 ? readUint32(buf, Offset.create(base + 4), le) : readUint32(buf, Offset.create(base + 24), le);
      // p_vaddr: offset 16 in ELF64, offset 8 in ELF32
      const pVAddr = is64 ? r.addr64(buf, base + 16) : BigInt(readUint32(buf, Offset.create(base + 8), le));

      const ptName = PT_NAMES[pType] ?? `PT(0x${pType.toString(16)})`;
      const flagStr = [pFlags & 0x4 ? "R" : "-", pFlags & 0x2 ? "W" : "-", pFlags & 0x1 ? "X" : "-"].join("");

      phGroup.addChild(
        new SectionBuilder()
          .id(`elf-ph-${i}`)
          .name(`PH[${i}] — ${ptName} [${flagStr}]`)
          .type("metadata")
          .range(Range.create(Offset.create(base), Offset.create(Math.min(base + phEntSz - 1, buf.byteLength - 1))))
          .virtualAddr(pVAddr > 0n ? (pVAddr as VirtualAddress) : undefined)
          .flags({
            readable: (pFlags & 0x4) !== 0,
            writable: (pFlags & 0x2) !== 0,
            executable: (pFlags & 0x1) !== 0,
          })
          .meta("type", ptName)
          .meta("fileOffset", `0x${pFileOff.toString(16)}`)
          .meta("fileSize", pFileSz)
          .meta("flags", flagStr)
          .build(),
      );
    }

    rootBuilder.addChild(phGroup.build());
  }

  // Section Headers
  if (shOff > 0 && shNum > 0 && shEntSz > 0 && shOff + shNum * shEntSz <= buf.byteLength) {
    const shGroupEnd = shOff + shNum * shEntSz - 1;

    const shGroup = new SectionBuilder()
      .id("elf-sh-table")
      .name(`Section Header Table (${shNum} entries)`)
      .type("container")
      .range(Range.create(Offset.create(shOff), Offset.create(Math.min(shGroupEnd, buf.byteLength - 1))))
      .flags({ readable: true, writable: false, executable: false })
      .meta("entries", shNum)
      .meta("entrySize", shEntSz);

    for (let i = 0; i < shNum && i < 256; i++) {
      const base = shOff + i * shEntSz;
      if (base + shEntSz > buf.byteLength) break;

      const shType = readUint32(buf, Offset.create(base + 4), le);
      // sh_flags: offset 8 (4 bytes in ELF32, 8 bytes in ELF64)
      const shFlags = is64 ? Number(readUint64(buf, Offset.create(base + 8), le)) : readUint32(buf, Offset.create(base + 8), le);
      // sh_offset and sh_size
      const shFileOff = is64 ? r.addr(buf, base + 24) : readUint32(buf, Offset.create(base + 16), le);
      const shSize = is64 ? r.addr(buf, base + 32) : readUint32(buf, Offset.create(base + 20), le);
      const shAddr = is64 ? r.addr64(buf, base + 16) : BigInt(readUint32(buf, Offset.create(base + 12), le));

      const shtName = SHT_NAMES[shType] ?? `SHT(0x${shType.toString(16)})`;
      const isExec = (shFlags & 0x4) !== 0;
      const isWrite = (shFlags & 0x1) !== 0;
      const isAlloc = (shFlags & 0x2) !== 0;

      const secType = shType === 1 || shType === 11 || shType === 2 ? ("data" as const) : ("metadata" as const);

      shGroup.addChild(
        new SectionBuilder()
          .id(`elf-sh-${i}`)
          .name(`SH[${i}] — ${shtName}`)
          .type(secType)
          .range(Range.create(Offset.create(base), Offset.create(Math.min(base + shEntSz - 1, buf.byteLength - 1))))
          .virtualAddr(shAddr > 0n ? (shAddr as VirtualAddress) : undefined)
          .flags({ readable: true, writable: isWrite, executable: isExec })
          .meta("type", shtName)
          .meta("fileOffset", `0x${shFileOff.toString(16)}`)
          .meta("size", shSize)
          .meta("alloc", isAlloc)
          .build(),
      );
    }

    rootBuilder.addChild(shGroup.build());
  }

  const formatMeta: FormatMetadata = {
    format: "ELF",
    class: is64 ? 64 : 32,
    endian: le ? "le" : "be",
  };

  return {
    format: "ELF",
    formatMeta,
    root: rootBuilder.build(),
    totalSize: buf.byteLength as ByteCount,
    entryPoint: entry64 > 0n ? (entry64 as VirtualAddress) : undefined,
  };
}
