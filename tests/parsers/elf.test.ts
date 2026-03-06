/**
 * @file Comprehensive Vitest tests for the ELF32/ELF64 parser.
 */

import { describe, it, expect, vi } from "vitest";

// Mock @app-types/index

vi.mock("@app-types/index", () => {
  const Offset = {
    create: (n: number) => n,
    add: (a: number, b: number) => a + b,
    diff: (a: number, b: number) => a - b,
  };
  const Bytes = { create: (n: number) => n };
  const Range = { create: (start: number, end: number) => ({ start, end }) };

  class SectionBuilder {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private d: any = { meta: {}, children: [] };
    id(v: string) {
      this.d.id = v;
      return this;
    }
    name(v: string) {
      this.d.name = v;
      return this;
    }
    type(v: string) {
      this.d.type = v;
      return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    range(v: any) {
      this.d.range = v;
      return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flags(v: any) {
      this.d.flags = v;
      return this;
    }
    meta(k: string, v: unknown) {
      this.d.meta[k] = v;
      return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    virtualAddr(v: any) {
      this.d.virtualAddr = v;
      return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addChild(child: any) {
      this.d.children.push(child);
      return this;
    }
    build() {
      return {
        id: this.d.id,
        name: this.d.name,
        type: this.d.type,
        range: this.d.range,
        flags: this.d.flags,
        meta: { ...this.d.meta },
        virtualAddr: this.d.virtualAddr,
        children: [...this.d.children],
      };
    }
  }

  return { Offset, Bytes, Range, SectionBuilder };
});

// Modules under test

import { detect, parse } from "../../src/core/parsers/elf";
import { loadBuffer } from "../../src/core/buffer";
import type { BinaryBuffer } from "../../src/core/buffer";

// Binary-builder helpers

/**
 * Write ELF magic + EI_CLASS + EI_DATA into `bytes` at offsets 0–5.
 * Does NOT allocate; caller owns the Uint8Array.
 */
function writeMagicIdent(bytes: Uint8Array, cls: 1 | 2, data: 1 | 2): void {
  bytes[0] = 0x7f;
  bytes[1] = 0x45;
  bytes[2] = 0x4c;
  bytes[3] = 0x46;
  bytes[4] = cls;
  bytes[5] = data;
  bytes[6] = 1; // EI_VERSION
}

// ELF32 header (52 bytes)

interface E32Opts {
  data?: 1 | 2; // EI_DATA: 1=LE, 2=BE
  type?: number; // e_type
  machine?: number; // e_machine
  entry?: number; // e_entry
  phOff?: number;
  phEntSz?: number;
  phNum?: number;
  shOff?: number;
  shEntSz?: number;
  shNum?: number;
  pad?: number; // extra bytes appended after header
}

function elf32(opts: E32Opts = {}): BinaryBuffer {
  const le = (opts.data ?? 1) === 1;
  const bytes = new Uint8Array(52 + (opts.pad ?? 0));
  const v = new DataView(bytes.buffer);
  writeMagicIdent(bytes, 1, opts.data ?? 1);
  const w16 = (o: number, n: number) => v.setUint16(o, n, le);
  const w32 = (o: number, n: number) => v.setUint32(o, n, le);
  w16(16, opts.type ?? 2); // e_type  = ET_EXEC
  w16(18, opts.machine ?? 0x3e); // e_machine = x86-64
  w32(20, 1); // e_version
  w32(24, opts.entry ?? 0); // e_entry
  w32(28, opts.phOff ?? 0); // e_phoff
  w32(32, opts.shOff ?? 0); // e_shoff
  w16(42, opts.phEntSz ?? 0); // e_phentsize
  w16(44, opts.phNum ?? 0); // e_phnum
  w16(46, opts.shEntSz ?? 0); // e_shentsize
  w16(48, opts.shNum ?? 0); // e_shnum
  return loadBuffer(bytes.buffer);
}

// ELF64 header (64 bytes)

interface E64Opts {
  data?: 1 | 2;
  type?: number;
  machine?: number;
  entry?: bigint;
  phOff?: bigint;
  phEntSz?: number;
  phNum?: number;
  shOff?: bigint;
  shEntSz?: number;
  shNum?: number;
  pad?: number;
}

function elf64(opts: E64Opts = {}): BinaryBuffer {
  const le = (opts.data ?? 1) === 1;
  const bytes = new Uint8Array(64 + (opts.pad ?? 0));
  const v = new DataView(bytes.buffer);
  writeMagicIdent(bytes, 2, opts.data ?? 1);
  const w16 = (o: number, n: number) => v.setUint16(o, n, le);
  const w32 = (o: number, n: number) => v.setUint32(o, n, le);
  const w64 = (o: number, n: bigint) => v.setBigUint64(o, n, le);
  w16(16, opts.type ?? 2);
  w16(18, opts.machine ?? 0x3e);
  w32(20, 1);
  w64(24, opts.entry ?? 0n); // e_entry  (8 bytes, offset 24)
  w64(32, opts.phOff ?? 0n); // e_phoff  (8 bytes, offset 32)
  w64(40, opts.shOff ?? 0n); // e_shoff  (8 bytes, offset 40)
  w16(54, opts.phEntSz ?? 0); // e_phentsize (offset 54)
  w16(56, opts.phNum ?? 0); // e_phnum     (offset 56)
  w16(58, opts.shEntSz ?? 0); // e_shentsize (offset 58)
  w16(60, opts.shNum ?? 0); // e_shnum     (offset 60)
  return loadBuffer(bytes.buffer);
}

// ELF32 LE with program headers (32 bytes each)

interface PH32Entry {
  pType?: number;
  pOffset?: number;
  pVAddr?: number;
  pPAddr?: number;
  pFileSz?: number;
  pMemSz?: number;
  pFlags?: number;
  pAlign?: number;
}

function elf32WithPH(entries: PH32Entry[]): BinaryBuffer {
  const PH_SZ = 32;
  const PH_OFF = 52;
  const total = PH_OFF + entries.length * PH_SZ;
  const bytes = new Uint8Array(total);
  const v = new DataView(bytes.buffer);
  writeMagicIdent(bytes, 1, 1);
  v.setUint16(16, 2, true); // ET_EXEC
  v.setUint16(18, 0x3e, true); // x86-64
  v.setUint32(20, 1, true); // version
  v.setUint32(24, 0x1000, true); // entry
  v.setUint32(28, PH_OFF, true); // phoff
  v.setUint16(42, PH_SZ, true); // phentsize
  v.setUint16(44, entries.length, true); // phnum
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const base = PH_OFF + i * PH_SZ;
    v.setUint32(base + 0, e.pType ?? 1, true); // PT_LOAD
    v.setUint32(base + 4, e.pOffset ?? 0, true);
    v.setUint32(base + 8, e.pVAddr ?? 0x1000, true);
    v.setUint32(base + 12, e.pPAddr ?? 0x1000, true);
    v.setUint32(base + 16, e.pFileSz ?? 0x100, true);
    v.setUint32(base + 20, e.pMemSz ?? 0x100, true);
    v.setUint32(base + 24, e.pFlags ?? 5, true); // R+X
    v.setUint32(base + 28, e.pAlign ?? 0x1000, true);
  }
  return loadBuffer(bytes.buffer);
}

// ELF32 LE with section headers (40 bytes each)

interface SH32Entry {
  shName?: number;
  shType?: number;
  shFlags?: number;
  shAddr?: number;
  shOffset?: number;
  shSize?: number;
}

function elf32WithSH(entries: SH32Entry[]): BinaryBuffer {
  const SH_SZ = 40;
  const SH_OFF = 52;
  const total = SH_OFF + entries.length * SH_SZ;
  const bytes = new Uint8Array(total);
  const v = new DataView(bytes.buffer);
  writeMagicIdent(bytes, 1, 1);
  v.setUint16(16, 2, true);
  v.setUint16(18, 0x3e, true);
  v.setUint32(20, 1, true);
  v.setUint32(32, SH_OFF, true); // shoff
  v.setUint16(46, SH_SZ, true); // shentsize
  v.setUint16(48, entries.length, true); // shnum
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const base = SH_OFF + i * SH_SZ;
    v.setUint32(base + 0, e.shName ?? 0, true);
    v.setUint32(base + 4, e.shType ?? 0, true);
    v.setUint32(base + 8, e.shFlags ?? 0, true);
    v.setUint32(base + 12, e.shAddr ?? 0, true);
    v.setUint32(base + 16, e.shOffset ?? 0, true);
    v.setUint32(base + 20, e.shSize ?? 0, true);
  }
  return loadBuffer(bytes.buffer);
}

/** Shorthand: get the parsed root as a plain object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const root = (buf: BinaryBuffer): any => (parse(buf) as any).root;

// detect

describe("detect", () => {
  it("returns true for a minimal ELF32 LE buffer (≥16 bytes with correct magic)", () => {
    expect(detect(elf32())).toBe(true);
  });

  it("returns true for a minimal ELF64 LE buffer", () => {
    expect(detect(elf64())).toBe(true);
  });

  it("returns true for an ELF32 BE buffer", () => {
    expect(detect(elf32({ data: 2 }))).toBe(true);
  });

  it("returns true for a buffer of exactly 16 bytes with valid magic", () => {
    const bytes = new Uint8Array(16);
    writeMagicIdent(bytes, 1, 1);
    expect(detect(loadBuffer(bytes.buffer))).toBe(true);
  });

  it("returns false for a buffer of 15 bytes (below 16-byte minimum)", () => {
    const bytes = new Uint8Array(15);
    writeMagicIdent(bytes, 1, 1);
    expect(detect(loadBuffer(bytes.buffer))).toBe(false);
  });

  it("returns false for an empty buffer", () => {
    expect(detect(loadBuffer(new ArrayBuffer(0)))).toBe(false);
  });

  it("returns false when first magic byte is wrong (0x00 instead of 0x7F)", () => {
    const bytes = new Uint8Array(52);
    writeMagicIdent(bytes, 1, 1);
    bytes[0] = 0x00;
    expect(detect(loadBuffer(bytes.buffer))).toBe(false);
  });

  it("returns false when second magic byte is wrong ('e' instead of 'E')", () => {
    const bytes = new Uint8Array(52);
    writeMagicIdent(bytes, 1, 1);
    bytes[1] = 0x65; // 'e' instead of 'E'
    expect(detect(loadBuffer(bytes.buffer))).toBe(false);
  });

  it("returns false when third magic byte is wrong", () => {
    const bytes = new Uint8Array(52);
    writeMagicIdent(bytes, 1, 1);
    bytes[2] = 0x00;
    expect(detect(loadBuffer(bytes.buffer))).toBe(false);
  });

  it("returns false for an all-zero buffer of 64 bytes", () => {
    expect(detect(loadBuffer(new ArrayBuffer(64)))).toBe(false);
  });

  it("returns false when magic starts at offset 1 instead of 0", () => {
    const bytes = new Uint8Array(64);
    bytes[1] = 0x7f;
    bytes[2] = 0x45;
    bytes[3] = 0x4c;
    bytes[4] = 0x46;
    expect(detect(loadBuffer(bytes.buffer))).toBe(false);
  });
});

// parse — return shape

describe("parse — return shape", () => {
  it("format is 'ELF'", () => {
    expect(parse(elf32()).format).toBe("ELF");
  });

  it("formatMeta.format is 'ELF'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(elf32()) as any).formatMeta.format).toBe("ELF");
  });

  it("root is defined", () => {
    expect(root(elf32())).toBeDefined();
  });

  it("totalSize equals buf.byteLength", () => {
    const buf = elf32({ pad: 100 });
    expect(parse(buf).totalSize).toBe(buf.byteLength);
  });

  it("totalSize is a number", () => {
    expect(typeof parse(elf32()).totalSize).toBe("number");
  });
});

// parse — formatMeta class & endianness

describe("parse — formatMeta.class and endian", () => {
  it("ELF32 LE → formatMeta.class = 32", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(elf32()) as any).formatMeta.class).toBe(32);
  });

  it("ELF64 LE → formatMeta.class = 64", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(elf64()) as any).formatMeta.class).toBe(64);
  });

  it("ELF32 LE → formatMeta.endian = 'le'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(elf32({ data: 1 })) as any).formatMeta.endian).toBe("le");
  });

  it("ELF32 BE → formatMeta.endian = 'be'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(elf32({ data: 2 })) as any).formatMeta.endian).toBe("be");
  });

  it("ELF64 BE → formatMeta.endian = 'be'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(elf64({ data: 2 })) as any).formatMeta.endian).toBe("be");
  });

  it("ELF64 LE → formatMeta.endian = 'le'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(elf64({ data: 1 })) as any).formatMeta.endian).toBe("le");
  });
});

// parse — entryPoint

describe("parse — entryPoint", () => {
  it("entryPoint is undefined when e_entry = 0 (ELF32)", () => {
    expect(parse(elf32({ entry: 0 })).entryPoint).toBeUndefined();
  });

  it("entryPoint is undefined when e_entry = 0 (ELF64)", () => {
    expect(parse(elf64({ entry: 0n })).entryPoint).toBeUndefined();
  });

  it("entryPoint is defined when e_entry = 0x1000 (ELF32)", () => {
    expect(parse(elf32({ entry: 0x1000 })).entryPoint).toBeDefined();
  });

  it("entryPoint equals 0x1000n for ELF32 with e_entry = 0x1000", () => {
    expect(parse(elf32({ entry: 0x1000 })).entryPoint).toBe(0x1000n);
  });

  it("entryPoint equals 0xDEAD0000n for ELF64 with e_entry = 0xDEAD0000n", () => {
    expect(parse(elf64({ entry: 0xdead0000n })).entryPoint).toBe(0xdead0000n);
  });

  it("root meta.entryPoint is '0x0' when entry = 0", () => {
    expect(root(elf32({ entry: 0 })).meta.entryPoint).toBe("0x0");
  });

  it("root meta.entryPoint is '0x1000' when entry = 0x1000", () => {
    expect(root(elf32({ entry: 0x1000 })).meta.entryPoint).toBe("0x1000");
  });

  it("root meta.entryPoint uses lowercase hex", () => {
    expect(root(elf32({ entry: 0xabcd })).meta.entryPoint).toBe("0xabcd");
  });
});

// parse — root section

describe("parse — root section", () => {
  it("root.id is 'elf-root'", () => {
    expect(root(elf32()).id).toBe("elf-root");
  });

  it("root.type is 'container'", () => {
    expect(root(elf32()).type).toBe("container");
  });

  it("root.flags.readable is true", () => {
    expect(root(elf32()).flags.readable).toBe(true);
  });

  it("root.flags.writable is false", () => {
    expect(root(elf32()).flags.writable).toBe(false);
  });

  it("root.flags.executable is false", () => {
    expect(root(elf32()).flags.executable).toBe(false);
  });

  it("root.meta.class is 'ELF32' for a 32-bit ELF", () => {
    expect(root(elf32()).meta.class).toBe("ELF32");
  });

  it("root.meta.class is 'ELF64' for a 64-bit ELF", () => {
    expect(root(elf64()).meta.class).toBe("ELF64");
  });

  it("root.meta.encoding is 'Little Endian (LSB)' for LE", () => {
    expect(root(elf32({ data: 1 })).meta.encoding).toBe("Little Endian (LSB)");
  });

  it("root.meta.encoding is 'Big Endian (MSB)' for BE", () => {
    expect(root(elf32({ data: 2 })).meta.encoding).toBe("Big Endian (MSB)");
  });

  it("root.name includes the ELF class", () => {
    expect(root(elf32()).name).toContain("ELF32");
  });

  it("root.name includes the machine name", () => {
    expect(root(elf32({ machine: 0x3e })).name).toContain("x86-64 (AMD64)");
  });

  it("root.range.start is 0", () => {
    expect(root(elf32()).range.start).toBe(0);
  });

  it("root.range.end is buf.byteLength - 1", () => {
    const buf = elf32({ pad: 20 });
    expect(root(buf).range.end).toBe(buf.byteLength - 1);
  });
});

// parse — ELF header child (children[0])

describe("parse — ELF header child", () => {
  it("root.children[0].id is 'elf-header'", () => {
    expect(root(elf32()).children[0].id).toBe("elf-header");
  });

  it("root.children[0].type is 'metadata'", () => {
    expect(root(elf32()).children[0].type).toBe("metadata");
  });

  it("ELF32 header range ends at offset 51 (52 bytes)", () => {
    expect(root(elf32()).children[0].range.end).toBe(51);
  });

  it("ELF64 header range ends at offset 63 (64 bytes)", () => {
    expect(root(elf64()).children[0].range.end).toBe(63);
  });

  it("ELF32 header name contains '52 bytes'", () => {
    expect(root(elf32()).children[0].name).toContain("52 bytes");
  });

  it("ELF64 header name contains '64 bytes'", () => {
    expect(root(elf64()).children[0].name).toContain("64 bytes");
  });

  it("header child meta.class matches the ELF class", () => {
    expect(root(elf64()).children[0].meta.class).toBe("ELF64");
  });

  it("header child meta.phNum reflects e_phnum", () => {
    const buf = elf32WithPH([{}, {}]);
    expect(root(buf).children[0].meta.phNum).toBe(2);
  });

  it("header child meta.shNum reflects e_shnum", () => {
    const buf = elf32WithSH([{}, {}]);
    expect(root(buf).children[0].meta.shNum).toBe(2);
  });

  it("header child meta.machine matches the machine name", () => {
    expect(root(elf32({ machine: 0xb7 })).children[0].meta.machine).toBe("AArch64 (ARM64)");
  });
});

// parse — e_type names

describe("parse — e_type names", () => {
  it.each([
    [0, "ET_NONE"],
    [1, "ET_REL — Relocatable"],
    [2, "ET_EXEC — Executable"],
    [3, "ET_DYN — Shared object"],
    [4, "ET_CORE — Core dump"],
  ] as const)("type %i → '%s' in root.meta.type", (type, name) => {
    expect(root(elf32({ type })).meta.type).toBe(name);
  });

  it("unknown type 0xFF → 'type(0xff)' in root.meta.type", () => {
    expect(root(elf32({ type: 0xff })).meta.type).toBe("type(0xff)");
  });

  it("unknown type 0x05 → 'type(0x5)'", () => {
    expect(root(elf32({ type: 5 })).meta.type).toBe("type(0x5)");
  });
});

// parse — e_machine names

describe("parse — e_machine names", () => {
  it.each([
    [0x00, "No machine"],
    [0x02, "SPARC"],
    [0x03, "x86 (i386)"],
    [0x08, "MIPS"],
    [0x14, "PowerPC"],
    [0x28, "ARM (32-bit)"],
    [0x3e, "x86-64 (AMD64)"],
    [0xb7, "AArch64 (ARM64)"],
    [0xf3, "RISC-V"],
  ] as const)("machine 0x%s → correct name", (machine, name) => {
    expect(root(elf32({ machine })).meta.machine).toBe(name);
  });

  it("unknown machine 0xABCD → 'machine(0xabcd)'", () => {
    expect(root(elf32({ machine: 0xabcd })).meta.machine).toBe("machine(0xabcd)");
  });
});

// parse — program header table (absence conditions)

describe("parse — program header table absent", () => {
  it("no PH table when phOff = 0: root has exactly 1 child", () => {
    const buf = elf32({ phOff: 0, phNum: 2, phEntSz: 32, pad: 64 });
    expect(root(buf).children).toHaveLength(1);
  });

  it("no PH table when phNum = 0", () => {
    const buf = elf32({ phOff: 52, phNum: 0, phEntSz: 32, pad: 32 });
    expect(root(buf).children).toHaveLength(1);
  });

  it("no PH table when phEntSz = 0", () => {
    const buf = elf32({ phOff: 52, phNum: 2, phEntSz: 0, pad: 64 });
    expect(root(buf).children).toHaveLength(1);
  });

  it("no PH table when phOff + phNum * phEntSz > buf.byteLength", () => {
    // phOff=52, phEntSz=32, phNum=5 → need 52+160=212 bytes; buf only 52
    const buf = elf32({ phOff: 52, phNum: 5, phEntSz: 32 }); // pad=0, only 52 bytes
    expect(root(buf).children).toHaveLength(1);
  });
});

// parse — program header table (present)

describe("parse — program header table present", () => {
  it("1 PH entry → root has 2 children (header + PH table)", () => {
    expect(root(elf32WithPH([{}])).children).toHaveLength(2);
  });

  it("3 PH entries → root has 2 children (header + PH table)", () => {
    expect(root(elf32WithPH([{}, {}, {}])).children).toHaveLength(2);
  });

  it("PH table child id is 'elf-ph-table'", () => {
    expect(root(elf32WithPH([{}])).children[1].id).toBe("elf-ph-table");
  });

  it("PH table type is 'container'", () => {
    expect(root(elf32WithPH([{}])).children[1].type).toBe("container");
  });

  it("PH table name contains the entry count", () => {
    expect(root(elf32WithPH([{}, {}])).children[1].name).toContain("2");
  });

  it("PH table meta.entries equals the number of entries", () => {
    expect(root(elf32WithPH([{}, {}, {}])).children[1].meta.entries).toBe(3);
  });

  it("PH table meta.entrySize equals phEntSz (32)", () => {
    expect(root(elf32WithPH([{}])).children[1].meta.entrySize).toBe(32);
  });

  it("PH[0] child id is 'elf-ph-0'", () => {
    expect(root(elf32WithPH([{}])).children[1].children[0].id).toBe("elf-ph-0");
  });

  it("PH[1] child id is 'elf-ph-1'", () => {
    expect(root(elf32WithPH([{}, {}])).children[1].children[1].id).toBe("elf-ph-1");
  });

  it("PH[0] type is 'metadata'", () => {
    expect(root(elf32WithPH([{}])).children[1].children[0].type).toBe("metadata");
  });

  it("PH[0] meta.type is 'PT_LOAD' for pType=1", () => {
    expect(root(elf32WithPH([{ pType: 1 }])).children[1].children[0].meta.type).toBe("PT_LOAD");
  });

  it("PH[0] meta.type is 'PT_NULL' for pType=0", () => {
    expect(root(elf32WithPH([{ pType: 0 }])).children[1].children[0].meta.type).toBe("PT_NULL");
  });

  it("PH[0] meta.type is 'PT_DYNAMIC' for pType=2", () => {
    expect(root(elf32WithPH([{ pType: 2 }])).children[1].children[0].meta.type).toBe("PT_DYNAMIC");
  });

  it("PT_GNU_STACK (0x6474e551) is recognized", () => {
    expect(root(elf32WithPH([{ pType: 0x6474e551 }])).children[1].children[0].meta.type).toBe("PT_GNU_STACK");
  });

  it("PT_GNU_RELRO (0x6474e552) is recognized", () => {
    expect(root(elf32WithPH([{ pType: 0x6474e552 }])).children[1].children[0].meta.type).toBe("PT_GNU_RELRO");
  });

  it("unknown pType → 'PT(0x...)' fallback", () => {
    expect(root(elf32WithPH([{ pType: 0xff }])).children[1].children[0].meta.type).toBe("PT(0xff)");
  });
});

// parse — program header flags string

describe("parse — program header flags string", () => {
  it("pFlags=5 (R+X) → 'R-X'", () => {
    const ph0 = root(elf32WithPH([{ pFlags: 5 }])).children[1].children[0];
    expect(ph0.meta.flags).toBe("R-X");
    expect(ph0.flags.readable).toBe(true);
    expect(ph0.flags.writable).toBe(false);
    expect(ph0.flags.executable).toBe(true);
  });

  it("pFlags=4 (R only) → 'R--'", () => {
    const ph0 = root(elf32WithPH([{ pFlags: 4 }])).children[1].children[0];
    expect(ph0.meta.flags).toBe("R--");
  });

  it("pFlags=6 (R+W) → 'RW-'", () => {
    const ph0 = root(elf32WithPH([{ pFlags: 6 }])).children[1].children[0];
    expect(ph0.meta.flags).toBe("RW-");
    expect(ph0.flags.writable).toBe(true);
    expect(ph0.flags.executable).toBe(false);
  });

  it("pFlags=7 (R+W+X) → 'RWX'", () => {
    const ph0 = root(elf32WithPH([{ pFlags: 7 }])).children[1].children[0];
    expect(ph0.meta.flags).toBe("RWX");
  });

  it("pFlags=0 → '---'", () => {
    const ph0 = root(elf32WithPH([{ pFlags: 0 }])).children[1].children[0];
    expect(ph0.meta.flags).toBe("---");
  });

  it("pFlags=1 (X only) → '--X'", () => {
    const ph0 = root(elf32WithPH([{ pFlags: 1 }])).children[1].children[0];
    expect(ph0.meta.flags).toBe("--X");
  });
});

// parse — program header virtual address

describe("parse — program header virtualAddr", () => {
  it("pVAddr = 0 → virtualAddr undefined", () => {
    const ph0 = root(elf32WithPH([{ pVAddr: 0 }])).children[1].children[0];
    expect(ph0.virtualAddr).toBeUndefined();
  });

  it("pVAddr = 0x1000 → virtualAddr is 0x1000n", () => {
    const ph0 = root(elf32WithPH([{ pVAddr: 0x1000 }])).children[1].children[0];
    expect(ph0.virtualAddr).toBe(0x1000n);
  });

  it("PH fileOffset meta is hex-formatted", () => {
    const ph0 = root(elf32WithPH([{ pOffset: 0x200 }])).children[1].children[0];
    expect(ph0.meta.fileOffset).toBe("0x200");
  });

  it("PH fileSize meta reflects pFileSz", () => {
    const ph0 = root(elf32WithPH([{ pFileSz: 0x400 }])).children[1].children[0];
    expect(ph0.meta.fileSize).toBe(0x400);
  });
});

// parse — program header cap at 128

describe("parse — program header cap at 128", () => {
  it("130 PH entries → PH table has exactly 128 children", () => {
    const entries = Array.from({ length: 130 }, () => ({}));
    const phTable = root(elf32WithPH(entries)).children[1];
    expect(phTable.children).toHaveLength(128);
  });

  it("127 PH entries → all 127 children present (no cap)", () => {
    const entries = Array.from({ length: 127 }, () => ({}));
    const phTable = root(elf32WithPH(entries)).children[1];
    expect(phTable.children).toHaveLength(127);
  });
});

// parse — section header table (absence conditions)

describe("parse — section header table absent", () => {
  it("no SH table when shOff = 0", () => {
    expect(root(elf32({ shOff: 0, shNum: 2, shEntSz: 40, pad: 80 })).children).toHaveLength(1);
  });

  it("no SH table when shNum = 0", () => {
    expect(root(elf32({ shOff: 52, shNum: 0, shEntSz: 40, pad: 40 })).children).toHaveLength(1);
  });

  it("no SH table when shEntSz = 0", () => {
    expect(root(elf32({ shOff: 52, shNum: 2, shEntSz: 0, pad: 80 })).children).toHaveLength(1);
  });

  it("no SH table when shOff + shNum * shEntSz > buf.byteLength", () => {
    const buf = elf32({ shOff: 52, shNum: 10, shEntSz: 40 }); // only 52 bytes
    expect(root(buf).children).toHaveLength(1);
  });
});

// parse — section header table (present)

describe("parse — section header table present", () => {
  it("1 SH entry → root has 2 children (header + SH table)", () => {
    expect(root(elf32WithSH([{}])).children).toHaveLength(2);
  });

  it("SH table child id is 'elf-sh-table'", () => {
    expect(root(elf32WithSH([{}])).children[1].id).toBe("elf-sh-table");
  });

  it("SH table type is 'container'", () => {
    expect(root(elf32WithSH([{}])).children[1].type).toBe("container");
  });

  it("SH table name contains the entry count", () => {
    expect(root(elf32WithSH([{}, {}])).children[1].name).toContain("2");
  });

  it("SH table meta.entries equals shNum", () => {
    expect(root(elf32WithSH([{}, {}, {}])).children[1].meta.entries).toBe(3);
  });

  it("SH table meta.entrySize equals shEntSz (40)", () => {
    expect(root(elf32WithSH([{}])).children[1].meta.entrySize).toBe(40);
  });

  it("SH[0] id is 'elf-sh-0'", () => {
    expect(root(elf32WithSH([{}])).children[1].children[0].id).toBe("elf-sh-0");
  });

  it("SH[1] id is 'elf-sh-1'", () => {
    expect(root(elf32WithSH([{}, {}])).children[1].children[1].id).toBe("elf-sh-1");
  });
});

// parse — SHT names and section type (data vs metadata)

describe("parse — SHT names", () => {
  it.each([
    [0, "SHT_NULL"],
    [1, "SHT_PROGBITS"],
    [2, "SHT_SYMTAB"],
    [3, "SHT_STRTAB"],
    [4, "SHT_RELA"],
    [7, "SHT_NOTE"],
    [8, "SHT_NOBITS"],
    [11, "SHT_DYNSYM"],
    [19, "SHT_GNU_HASH"],
  ] as const)("shType %i → '%s'", (shType, name) => {
    const sh0 = root(elf32WithSH([{ shType }])).children[1].children[0];
    expect(sh0.meta.type).toBe(name);
  });

  it("unknown shType 0xAB → 'SHT(0xab)'", () => {
    const sh0 = root(elf32WithSH([{ shType: 0xab }])).children[1].children[0];
    expect(sh0.meta.type).toBe("SHT(0xab)");
  });
});

describe("parse — section type classification (data vs metadata)", () => {
  it("SHT_PROGBITS (1) → section.type = 'data'", () => {
    expect(root(elf32WithSH([{ shType: 1 }])).children[1].children[0].type).toBe("data");
  });

  it("SHT_SYMTAB (2) → section.type = 'data'", () => {
    expect(root(elf32WithSH([{ shType: 2 }])).children[1].children[0].type).toBe("data");
  });

  it("SHT_DYNSYM (11) → section.type = 'data'", () => {
    expect(root(elf32WithSH([{ shType: 11 }])).children[1].children[0].type).toBe("data");
  });

  it("SHT_NULL (0) → section.type = 'metadata'", () => {
    expect(root(elf32WithSH([{ shType: 0 }])).children[1].children[0].type).toBe("metadata");
  });

  it("SHT_STRTAB (3) → section.type = 'metadata'", () => {
    expect(root(elf32WithSH([{ shType: 3 }])).children[1].children[0].type).toBe("metadata");
  });

  it("SHT_NOTE (7) → section.type = 'metadata'", () => {
    expect(root(elf32WithSH([{ shType: 7 }])).children[1].children[0].type).toBe("metadata");
  });
});

// parse — section header flags (exec/write/alloc)

describe("parse — section header flags", () => {
  it("shFlags=0 → readable=true, writable=false, executable=false", () => {
    const sh0 = root(elf32WithSH([{ shFlags: 0 }])).children[1].children[0];
    expect(sh0.flags).toEqual({ readable: true, writable: false, executable: false });
  });

  it("shFlags=1 (write) → writable=true", () => {
    const sh0 = root(elf32WithSH([{ shFlags: 1 }])).children[1].children[0];
    expect(sh0.flags.writable).toBe(true);
  });

  it("shFlags=4 (exec) → executable=true", () => {
    const sh0 = root(elf32WithSH([{ shFlags: 4 }])).children[1].children[0];
    expect(sh0.flags.executable).toBe(true);
  });

  it("shFlags=7 (write+alloc+exec) → all flags set", () => {
    const sh0 = root(elf32WithSH([{ shFlags: 7 }])).children[1].children[0];
    expect(sh0.flags.writable).toBe(true);
    expect(sh0.flags.executable).toBe(true);
  });

  it("section meta.alloc is true when shFlags bit 1 set", () => {
    const sh0 = root(elf32WithSH([{ shFlags: 2 }])).children[1].children[0];
    expect(sh0.meta.alloc).toBe(true);
  });

  it("section meta.alloc is false when shFlags bit 1 clear", () => {
    const sh0 = root(elf32WithSH([{ shFlags: 0 }])).children[1].children[0];
    expect(sh0.meta.alloc).toBe(false);
  });
});

// parse — section header virtualAddr

describe("parse — section header virtualAddr", () => {
  it("shAddr = 0 → virtualAddr undefined", () => {
    expect(root(elf32WithSH([{ shAddr: 0 }])).children[1].children[0].virtualAddr).toBeUndefined();
  });

  it("shAddr = 0x8000 → virtualAddr = 0x8000n", () => {
    const sh0 = root(elf32WithSH([{ shAddr: 0x8000 }])).children[1].children[0];
    expect(sh0.virtualAddr).toBe(0x8000n);
  });

  it("section meta.fileOffset is hex-formatted", () => {
    const sh0 = root(elf32WithSH([{ shOffset: 0x100 }])).children[1].children[0];
    expect(sh0.meta.fileOffset).toBe("0x100");
  });

  it("section meta.size reflects shSize", () => {
    const sh0 = root(elf32WithSH([{ shSize: 0x200 }])).children[1].children[0];
    expect(sh0.meta.size).toBe(0x200);
  });
});

// parse — section header cap at 256

describe("parse — section header cap at 256", () => {
  it("260 SH entries → SH table has exactly 256 children", () => {
    const entries = Array.from({ length: 260 }, () => ({}));
    const shTable = root(elf32WithSH(entries)).children[1];
    expect(shTable.children).toHaveLength(256);
  });

  it("255 SH entries → all 255 children present (no cap)", () => {
    const entries = Array.from({ length: 255 }, () => ({}));
    const shTable = root(elf32WithSH(entries)).children[1];
    expect(shTable.children).toHaveLength(255);
  });
});

// parse — ELF64 specific field offsets

describe("parse — ELF64 field offsets", () => {
  it("ELF64 reads e_entry as 8 bytes at offset 24", () => {
    expect(parse(elf64({ entry: 0xcafebaben })).entryPoint).toBe(0xcafebaben);
  });

  it("ELF64 meta.entryPoint hex is lowercase", () => {
    expect(root(elf64({ entry: 0xcafebaben })).meta.entryPoint).toBe("0xcafebabe");
  });

  it("ELF64 phOff read from 8-byte field at offset 32", () => {
    // Build an ELF64 buffer with a valid PH table
    const PH64_SZ = 56;
    const PH_OFF = 64;
    const total = PH_OFF + PH64_SZ;
    const bytes = new Uint8Array(total);
    const v = new DataView(bytes.buffer);
    writeMagicIdent(bytes, 2, 1);
    v.setUint16(16, 2, true);
    v.setUint16(18, 0x3e, true);
    v.setUint32(20, 1, true);
    v.setBigUint64(24, 0n, true); // e_entry
    v.setBigUint64(32, BigInt(PH_OFF), true); // e_phoff = 64
    v.setBigUint64(40, 0n, true); // e_shoff = 0
    v.setUint16(54, PH64_SZ, true); // e_phentsize = 56
    v.setUint16(56, 1, true); // e_phnum = 1
    // Write one PT_LOAD PH64 entry (all zeros = PT_NULL at base)
    v.setUint32(PH_OFF + 0, 1, true); // p_type = PT_LOAD
    v.setUint32(PH_OFF + 4, 5, true); // p_flags = R+X
    const buf = loadBuffer(bytes.buffer);
    const phTable = root(buf).children[1];
    expect(phTable.id).toBe("elf-ph-table");
    expect(phTable.children).toHaveLength(1);
    expect(phTable.children[0].meta.type).toBe("PT_LOAD");
  });

  it("ELF64 PH entry: p_flags at offset 4, p_offset at offset 8 (not ELF32 layout)", () => {
    const PH64_SZ = 56;
    const PH_OFF = 64;
    const total = PH_OFF + PH64_SZ;
    const bytes = new Uint8Array(total);
    const v = new DataView(bytes.buffer);
    writeMagicIdent(bytes, 2, 1);
    v.setUint16(16, 2, true);
    v.setUint16(18, 0x3e, true);
    v.setUint32(20, 1, true);
    v.setBigUint64(24, 0n, true);
    v.setBigUint64(32, BigInt(PH_OFF), true);
    v.setBigUint64(40, 0n, true);
    v.setUint16(54, PH64_SZ, true);
    v.setUint16(56, 1, true);
    // ELF64 PH: p_type=0, p_flags=6 (RW-) at +4, p_offset=0x500 at +8
    v.setUint32(PH_OFF + 0, 1, true); // p_type = PT_LOAD
    v.setUint32(PH_OFF + 4, 6, true); // p_flags = RW-
    v.setBigUint64(PH_OFF + 8, 0x500n, true); // p_offset
    const buf = loadBuffer(bytes.buffer);
    const ph0 = root(buf).children[1].children[0];
    expect(ph0.meta.flags).toBe("RW-");
    expect(ph0.meta.fileOffset).toBe("0x500");
  });

  it("ELF64 SH entry: sh_flags as 8 bytes at offset 8", () => {
    const SH64_SZ = 64;
    const SH_OFF = 64;
    const total = SH_OFF + SH64_SZ;
    const bytes = new Uint8Array(total);
    const v = new DataView(bytes.buffer);
    writeMagicIdent(bytes, 2, 1);
    v.setUint16(16, 2, true);
    v.setUint16(18, 0x3e, true);
    v.setUint32(20, 1, true);
    v.setBigUint64(24, 0n, true);
    v.setBigUint64(32, 0n, true);
    v.setBigUint64(40, BigInt(SH_OFF), true); // e_shoff
    v.setUint16(58, SH64_SZ, true); // e_shentsize
    v.setUint16(60, 1, true); // e_shnum
    // ELF64 SH: sh_type=1 at +4, sh_flags=4 (exec) at +8 (8 bytes)
    v.setUint32(SH_OFF + 4, 1, true); // sh_type = SHT_PROGBITS
    v.setBigUint64(SH_OFF + 8, 4n, true); // sh_flags = exec bit
    const buf = loadBuffer(bytes.buffer);
    const sh0 = root(buf).children[1].children[0];
    expect(sh0.type).toBe("data"); // SHT_PROGBITS → "data"
    expect(sh0.flags.executable).toBe(true);
  });
});

// parse — Big-Endian correctness

describe("parse — Big Endian ELF32", () => {
  it("reads e_type correctly in BE", () => {
    expect(root(elf32({ data: 2, type: 3 })).meta.type).toBe("ET_DYN — Shared object");
  });

  it("reads e_machine correctly in BE", () => {
    expect(root(elf32({ data: 2, machine: 0x08 })).meta.machine).toBe("MIPS");
  });

  it("meta.encoding is 'Big Endian (MSB)'", () => {
    expect(root(elf32({ data: 2 })).meta.encoding).toBe("Big Endian (MSB)");
  });

  it("reads e_entry correctly in BE", () => {
    const buf = elf32({ data: 2, entry: 0x4000 });
    expect(parse(buf).entryPoint).toBe(0x4000n);
  });
});

// parse — both PH table and SH table present

describe("parse — PH table and SH table both present", () => {
  it("root has 3 children: header, PH table, SH table", () => {
    const PH_SZ = 32;
    const SH_SZ = 40;
    const PH_OFF = 52;
    const PH_NUM = 1;
    const SH_OFF = PH_OFF + PH_NUM * PH_SZ; // 84
    const total = SH_OFF + 1 * SH_SZ; // 124
    const bytes = new Uint8Array(total);
    const v = new DataView(bytes.buffer);
    writeMagicIdent(bytes, 1, 1);
    v.setUint16(16, 2, true);
    v.setUint16(18, 0x3e, true);
    v.setUint32(20, 1, true);
    v.setUint32(28, PH_OFF, true); // phoff
    v.setUint16(42, PH_SZ, true); // phentsize
    v.setUint16(44, PH_NUM, true); // phnum
    v.setUint32(32, SH_OFF, true); // shoff
    v.setUint16(46, SH_SZ, true); // shentsize
    v.setUint16(48, 1, true); // shnum
    // Write PT_LOAD PH entry
    v.setUint32(PH_OFF, 1, true);
    v.setUint32(PH_OFF + 24, 5, true); // p_flags = R+X
    const r = root(loadBuffer(bytes.buffer));
    expect(r.children).toHaveLength(3);
    expect(r.children[1].id).toBe("elf-ph-table");
    expect(r.children[2].id).toBe("elf-sh-table");
  });
});
