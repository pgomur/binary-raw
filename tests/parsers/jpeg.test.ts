/**
 * @file Comprehensive Vitest tests for the JPEG parser (jpeg.ts).
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
    addChild(c: any) {
      this.d.children.push(c);
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
        children: [...this.d.children],
      };
    }
  }

  return { Offset, Bytes, Range, SectionBuilder };
});

// Modules under test

import { detect, parse } from "../../src/core/parsers/jpeg";
import { loadBuffer } from "../../src/core/buffer";
import type { BinaryBuffer } from "../../src/core/buffer";

// Binary helpers

/**
 * Build one JPEG marker segment:
 *   [0xFF, code, segLen_hi, segLen_lo, ...payload]
 * where segLen = 2 + payload.length (the length field counts itself).
 *
 * The parser at `offset` reads:
 *   code    at offset+1
 *   segLen  at offset+2 (2-byte BE)
 * then advances offset += 2 + segLen.
 * Total bytes emitted by this helper = 4 + payload.length.
 */
function seg(code: number, payload: number[] | Uint8Array = []): Uint8Array {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const len = 2 + p.length; // segLen value written into the stream
  const out = new Uint8Array(4 + p.length);
  out[0] = 0xff;
  out[1] = code;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(p, 4);
  return out;
}

/** Concatenate SOI + ...segments + EOI into a BinaryBuffer. */
function jpeg(...segments: Uint8Array[]): BinaryBuffer {
  const parts = [new Uint8Array([0xff, 0xd8]), ...segments, new Uint8Array([0xff, 0xd9])];
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of parts) {
    out.set(a, pos);
    pos += a.length;
  }
  return loadBuffer(out.buffer);
}

/**
 * Build a SOI + pre-segments + SOS header segment + raw scan bytes + EOI.
 *
 * Layout in bytes:
 *   SOI(2) | [pre...] | FF DA segLen_hi segLen_lo [sosPayload...] | [scanData...] | FF D9
 *
 * SOS is at offset = 2 + sum(pre[i].length).
 * headerLen = 2 + sosPayload.length (the segLen field value).
 * dataStart = sosOffset + 2 + headerLen.
 * scanEnd   = buf.byteLength - 3.
 */
function jpegWithScan(sosPayload: number[], scanData: number[], pre: Uint8Array[] = []): BinaryBuffer {
  const parts = [new Uint8Array([0xff, 0xd8]), ...pre, seg(0xda, sosPayload), new Uint8Array(scanData), new Uint8Array([0xff, 0xd9])];
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of parts) {
    out.set(a, pos);
    pos += a.length;
  }
  return loadBuffer(out.buffer);
}

/**
 * SOF payload layout (at offset+4 relative to the segment's 0xFF byte):
 *   [precision(1), height_hi, height_lo, width_hi, width_lo, components, pad(1)]
 *
 * segLen = 2 + 7 = 9 (exactly the minimum the parser checks: segLen >= 9).
 * The parser reads:
 *   height     = readUint16(offset+5, BE)  → bytes at positions 1–2 of payload
 *   width      = readUint16(offset+7, BE)  → bytes at positions 3–4 of payload
 *   components = readUint8(offset+9)       → byte at position 5 of payload
 */
function sofPayload(height: number, width: number, components: number): number[] {
  return [
    8, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    components,
    0, // padding (makes 7 bytes → segLen=9)
  ];
}

/** Shorthand: return the parsed root as a plain object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const root = (b: BinaryBuffer): any => (parse(b) as any).root;

// detect

describe("detect", () => {
  it("returns true for a valid JPEG with SOI + EOI", () => {
    expect(detect(jpeg())).toBe(true);
  });

  it("returns true for a buffer of exactly 2 bytes [0xFF, 0xD8]", () => {
    expect(detect(loadBuffer(new Uint8Array([0xff, 0xd8]).buffer))).toBe(true);
  });

  it("returns false for an empty buffer (byteLength = 0)", () => {
    expect(detect(loadBuffer(new ArrayBuffer(0)))).toBe(false);
  });

  it("returns false for a 1-byte buffer (below 2-byte minimum)", () => {
    expect(detect(loadBuffer(new Uint8Array([0xff]).buffer))).toBe(false);
  });

  it("returns false when byte 0 is 0xFE instead of 0xFF", () => {
    expect(detect(loadBuffer(new Uint8Array([0xfe, 0xd8]).buffer))).toBe(false);
  });

  it("returns false when byte 1 is 0xD9 (EOI) instead of 0xD8 (SOI)", () => {
    expect(detect(loadBuffer(new Uint8Array([0xff, 0xd9]).buffer))).toBe(false);
  });

  it("returns false when byte 1 is 0x00", () => {
    expect(detect(loadBuffer(new Uint8Array([0xff, 0x00]).buffer))).toBe(false);
  });

  it("returns false for an all-zero buffer", () => {
    expect(detect(loadBuffer(new ArrayBuffer(16)))).toBe(false);
  });

  it("returns false when SOI magic is at offset 1 instead of 0", () => {
    expect(detect(loadBuffer(new Uint8Array([0x00, 0xff, 0xd8]).buffer))).toBe(false);
  });
});

// parse — return shape

describe("parse — return shape", () => {
  it("format is 'JPEG'", () => {
    expect(parse(jpeg()).format).toBe("JPEG");
  });

  it("formatMeta.format is 'JPEG'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(jpeg()) as any).formatMeta.format).toBe("JPEG");
  });

  it("formatMeta.width is 0 when no SOF segment present", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(jpeg()) as any).formatMeta.width).toBe(0);
  });

  it("formatMeta.height is 0 when no SOF segment present", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(jpeg()) as any).formatMeta.height).toBe(0);
  });

  it("formatMeta does NOT contain a components field", () => {
    // The source only puts { format, width, height } in formatMeta
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(jpeg()) as any).formatMeta).not.toHaveProperty("components");
  });

  it("entryPoint is always undefined", () => {
    expect(parse(jpeg()).entryPoint).toBeUndefined();
    expect(parse(jpeg(seg(0xc0, sofPayload(100, 100, 3)))).entryPoint).toBeUndefined();
  });

  it("root is defined", () => {
    expect(root(jpeg())).toBeDefined();
  });

  it("totalSize equals buf.byteLength", () => {
    const b = jpeg(seg(0xe0, new Array(14).fill(0)));
    expect(parse(b).totalSize).toBe(b.byteLength);
  });

  it("totalSize is a number", () => {
    expect(typeof parse(jpeg()).totalSize).toBe("number");
  });
});

// parse — root section

describe("parse — root section", () => {
  it("root.id is 'jpeg-root'", () => {
    expect(root(jpeg()).id).toBe("jpeg-root");
  });

  it("root.name is 'JPEG Image'", () => {
    expect(root(jpeg()).name).toBe("JPEG Image");
  });

  it("root.type is 'container'", () => {
    expect(root(jpeg()).type).toBe("container");
  });

  it("root.flags.readable is true", () => {
    expect(root(jpeg()).flags.readable).toBe(true);
  });

  it("root.flags.writable is false", () => {
    expect(root(jpeg()).flags.writable).toBe(false);
  });

  it("root.flags.executable is false", () => {
    expect(root(jpeg()).flags.executable).toBe(false);
  });

  it("root.range.start is 0", () => {
    expect(root(jpeg()).range.start).toBe(0);
  });

  it("root.range.end is buf.byteLength - 1", () => {
    const b = jpeg(seg(0xe0, new Array(14).fill(0)));
    expect(root(b).range.end).toBe(b.byteLength - 1);
  });

  it("root.meta.width is 0 when no SOF present", () => {
    expect(root(jpeg()).meta.width).toBe(0);
  });

  it("root.meta.height is 0 when no SOF present", () => {
    expect(root(jpeg()).meta.height).toBe(0);
  });

  it("root.meta.components is 0 when no SOF present", () => {
    expect(root(jpeg()).meta.components).toBe(0);
  });
});

// parse — SOI child (always children[0], added before the loop)

describe("parse — SOI child", () => {
  it("children[0].id is 'jpeg-soi'", () => {
    expect(root(jpeg()).children[0].id).toBe("jpeg-soi");
  });

  it("children[0].name is 'SOI — Start of Image'", () => {
    expect(root(jpeg()).children[0].name).toBe("SOI — Start of Image");
  });

  it("children[0].type is 'metadata'", () => {
    expect(root(jpeg()).children[0].type).toBe("metadata");
  });

  it("children[0].range.start is 0", () => {
    expect(root(jpeg()).children[0].range.start).toBe(0);
  });

  it("children[0].range.end is 1 (SOI is always exactly 2 bytes)", () => {
    expect(root(jpeg()).children[0].range.end).toBe(1);
  });

  it("SOI.flags: readable=true, writable=false, executable=false", () => {
    expect(root(jpeg()).children[0].flags).toEqual({ readable: true, writable: false, executable: false });
  });

  it("SOI is still children[0] even when many subsequent segments are present", () => {
    const b = jpeg(seg(0xe0, new Array(14).fill(0)), seg(0xdb, new Array(64).fill(0)), seg(0xc4, new Array(16).fill(0)));
    expect(root(b).children[0].id).toBe("jpeg-soi");
  });
});

// parse — EOI child

describe("parse — EOI child", () => {
  // Minimal JPEG: SOI(2) + EOI(2) = 4 bytes.
  // Loop starts at offset=2, reads [0xFF, 0xD9] → adds EOI, breaks.
  // children = [SOI, EOI].
  const minJpeg = jpeg();

  it("minimal JPEG has exactly 2 children: SOI and EOI", () => {
    expect(root(minJpeg).children).toHaveLength(2);
  });

  it("EOI child id is 'jpeg-eoi'", () => {
    expect(root(minJpeg).children[1].id).toBe("jpeg-eoi");
  });

  it("EOI child name is 'EOI — End of Image'", () => {
    expect(root(minJpeg).children[1].name).toBe("EOI — End of Image");
  });

  it("EOI child type is 'metadata'", () => {
    expect(root(minJpeg).children[1].type).toBe("metadata");
  });

  it("EOI.flags: readable=true, writable=false, executable=false", () => {
    expect(root(minJpeg).children[1].flags).toEqual({ readable: true, writable: false, executable: false });
  });

  it("EOI range.start = 2 in a minimal JPEG (offset when EOI is encountered)", () => {
    // SOI(2) → loop starts at offset=2; EOI at offset=2
    expect(root(minJpeg).children[1].range.start).toBe(2);
  });

  it("EOI range.end = min(offset+1, byteLength-1) = min(3, 3) = 3 in minimal JPEG", () => {
    expect(root(minJpeg).children[1].range.end).toBe(3);
  });

  it("EOI range.start = 10 after SOI + APP0(8 bytes)", () => {
    // SOI(2) + APP0[FF,E0,00,06,00,00,00,00](8) → EOI at offset=10
    const b = jpeg(seg(0xe0, new Array(4).fill(0)));
    const eoi = root(b).children.find((c: { id: string }) => c.id === "jpeg-eoi");
    expect(eoi.range.start).toBe(10);
  });

  it("EOI range.end = min(11, byteLength-1) after SOI + APP0", () => {
    // byteLength = 2 + 8 + 2 = 12; range.end = min(11, 11) = 11
    const b = jpeg(seg(0xe0, new Array(4).fill(0)));
    const eoi = root(b).children.find((c: { id: string }) => c.id === "jpeg-eoi");
    expect(eoi.range.end).toBe(11);
  });

  it("EOI terminates the walk — data after EOI produces no more children", () => {
    // Place junk after EOI in the raw buffer
    const soi = new Uint8Array([0xff, 0xd8]);
    const eoi = new Uint8Array([0xff, 0xd9]);
    const junk = new Uint8Array([0xff, 0xe0, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);
    const all = new Uint8Array(soi.length + eoi.length + junk.length);
    all.set(soi, 0);
    all.set(eoi, 2);
    all.set(junk, 4);
    const ch = root(loadBuffer(all.buffer)).children;
    // Only SOI + EOI; the junk after EOI must not appear
    const eoiIdx = ch.findIndex((c: { id: string }) => c.id === "jpeg-eoi");
    expect(eoiIdx).toBe(ch.length - 1);
    expect(ch).toHaveLength(2);
  });
});

// parse — loop termination without EOI

describe("parse — loop termination without EOI", () => {
  it("buffer = SOI only (2 bytes, no EOI): exactly 1 child (SOI)", () => {
    const b = loadBuffer(new Uint8Array([0xff, 0xd8]).buffer);
    expect(root(b).children).toHaveLength(1);
    expect(root(b).children[0].id).toBe("jpeg-soi");
  });

  it("buffer = SOI + APP0, no EOI: 2 children (SOI + APP0-0)", () => {
    // No EOI appended; loop exits when offset+1 >= buf.byteLength
    const soi = new Uint8Array([0xff, 0xd8]);
    const app0 = seg(0xe0, new Array(4).fill(0)); // 8 bytes
    const all = new Uint8Array(soi.length + app0.length);
    all.set(soi, 0);
    all.set(app0, 2);
    const ch = root(loadBuffer(all.buffer)).children;
    expect(ch).toHaveLength(2);
    expect(ch[0].id).toBe("jpeg-soi");
    expect(ch[1].id).toBe("jpeg-app0-0");
  });
});

// parse — known MARKERS Map entries (code → name, id, markerCode)

describe("parse — known MARKERS entries", () => {
  // For each entry: code, expected markerName, expected id suffix, expected markerCode string
  it.each([
    [0xe0, "APP0", "app0", "0xFFE0"],
    [0xe1, "APP1", "app1", "0xFFE1"],
    [0xe2, "APP2", "app2", "0xFFE2"],
    [0xed, "APP13", "app13", "0xFFED"],
    [0xee, "APP14", "app14", "0xFFEE"],
    [0xdb, "DQT", "dqt", "0xFFDB"],
    [0xc4, "DHT", "dht", "0xFFC4"],
    [0xc0, "SOF0", "sof0", "0xFFC0"],
    [0xc1, "SOF1", "sof1", "0xFFC1"],
    [0xc2, "SOF2", "sof2", "0xFFC2"],
    [0xc3, "SOF3", "sof3", "0xFFC3"],
    [0xdd, "DRI", "dri", "0xFFDD"],
    [0xfe, "COM", "com", "0xFFFE"],
  ] as const)("code 0x%s → id='jpeg-%s-0', name starts with '%s', markerCode='%s'", (code, markerName, idSuffix, markerCode) => {
    // SOF markers need segLen >= 9 for dimension extraction; use sofPayload for them
    const payload = code >= 0xc0 && code <= 0xc3 ? sofPayload(8, 8, 1) : new Array(4).fill(0);
    const b = jpeg(seg(code, payload));
    const ch = root(b).children;
    const s = ch.find((c: { id: string }) => c.id === `jpeg-${idSuffix}-0`);
    expect(s).toBeDefined();
    expect(s.name).toContain(markerName);
    expect(s.meta.markerCode).toBe(markerCode);
  });
});

// parse — APPn fallback naming for unlisted codes

describe("parse — APPn fallback naming", () => {
  // Fallback: `APP${(code - 0xE0).toString().padStart(2, "0")}`
  it("code 0xE3 (not in MARKERS) → markerName 'APP03', id 'jpeg-app03-0'", () => {
    const b = jpeg(seg(0xe3, new Array(4).fill(0)));
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app03-0")).toBeDefined();
  });

  it("code 0xEB (APP11) → id 'jpeg-app11-0'", () => {
    const b = jpeg(seg(0xeb, new Array(4).fill(0)));
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app11-0")).toBeDefined();
  });

  it("code 0xEF (APP15) → id 'jpeg-app15-0'", () => {
    const b = jpeg(seg(0xef, new Array(4).fill(0)));
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app15-0")).toBeDefined();
  });

  it("fallback name contains the APP number in the segment name", () => {
    const b = jpeg(seg(0xeb, new Array(4).fill(0)));
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app11-0").name).toContain("APP11");
  });
});

// parse — segment name, segmentLength, and range

describe("parse — segment name format and metadata", () => {
  it("name format is '{MARKERNAME} (length: {segLen})'", () => {
    // APP0 with 4-byte payload → segLen = 6
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0").name).toBe("APP0 (length: 6)");
  });

  it("meta.segmentLength equals segLen (= 2 + payload.length)", () => {
    // DQT with 64-byte payload → segLen = 66
    const ch = root(jpeg(seg(0xdb, new Array(64).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-0").meta.segmentLength).toBe(66);
  });

  it("segment range.start equals the offset of its 0xFF byte", () => {
    // SOI(2) → first marker starts at offset 2
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0").range.start).toBe(2);
  });

  it("segment range.end = offset + 2 + segLen - 1 (when within bounds)", () => {
    // APP0 at offset=2, segLen=6 → range.end = 2 + 2 + 6 - 1 = 9
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0").range.end).toBe(9);
  });

  it("second segment range.start = previous range.end + 1", () => {
    // SOI(2) + APP0(8) → APP0 range [2, 9] → DQT starts at 10
    const b = jpeg(
      seg(0xe0, new Array(4).fill(0)), // 8 bytes total → [2, 9]
      seg(0xdb, new Array(4).fill(0)), // DQT → starts at 10
    );
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-1").range.start).toBe(10);
  });

  it("segment range.end is clamped to buf.byteLength - 1 when declared segLen overflows buffer", () => {
    // Declare segLen = 0xFFFF but buffer only has 2 payload bytes
    const soi = new Uint8Array([0xff, 0xd8]);
    const stub = new Uint8Array([0xff, 0xe0, 0xff, 0xff, 0x00, 0x00]); // segLen=65535
    const all = new Uint8Array(soi.length + stub.length);
    all.set(soi, 0);
    all.set(stub, 2);
    const b = loadBuffer(all.buffer);
    const ch = root(b).children;
    const app0 = ch.find((c: { id: string }) => c.id === "jpeg-app0-0");
    expect(app0.range.end).toBeLessThanOrEqual(b.byteLength - 1);
  });

  it("segment flags: readable=true, writable=false, executable=false", () => {
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0").flags).toEqual({ readable: true, writable: false, executable: false });
  });
});

// parse — markerCode format (0xFF + uppercase 2-hex-digit code)

describe("parse — markerCode format", () => {
  it("APP0 (0xE0) → meta.markerCode = '0xFFE0'", () => {
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0").meta.markerCode).toBe("0xFFE0");
  });

  it("DQT (0xDB) → meta.markerCode = '0xFFDB'", () => {
    const ch = root(jpeg(seg(0xdb, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-0").meta.markerCode).toBe("0xFFDB");
  });

  it("SOF0 (0xC0) → meta.markerCode = '0xFFC0'", () => {
    const ch = root(jpeg(seg(0xc0, sofPayload(8, 8, 1)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sof0-0").meta.markerCode).toBe("0xFFC0");
  });

  it("COM (0xFE) → meta.markerCode = '0xFFFE'", () => {
    const ch = root(jpeg(seg(0xfe, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-com-0").meta.markerCode).toBe("0xFFFE");
  });

  it("DHT (0xC4) → meta.markerCode = '0xFFC4' (no lowercase hex)", () => {
    const code = root(jpeg(seg(0xc4, new Array(4).fill(0)))).children.find((c: { id: string }) => c.id === "jpeg-dht-0").meta.markerCode as string;
    expect(code).toBe("0xFFC4");
    // hex digits after '0xFF' must be uppercase
    expect(code.slice(4)).not.toMatch(/[a-z]/);
  });
});

// parse — sectionType: 'data' vs 'metadata'

describe("parse — sectionType classification", () => {
  it("DQT (0xDB) → type 'data'", () => {
    const ch = root(jpeg(seg(0xdb, new Array(64).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-0").type).toBe("data");
  });

  it("DHT (0xC4) → type 'data'", () => {
    const ch = root(jpeg(seg(0xc4, new Array(16).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dht-0").type).toBe("data");
  });

  it("APP0 (0xE0) → type 'metadata'", () => {
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0").type).toBe("metadata");
  });

  it("APP1 (0xE1) → type 'metadata'", () => {
    const ch = root(jpeg(seg(0xe1, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app1-0").type).toBe("metadata");
  });

  it("SOF0 (0xC0) → type 'metadata'", () => {
    const ch = root(jpeg(seg(0xc0, sofPayload(8, 8, 1)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sof0-0").type).toBe("metadata");
  });

  it("SOF2 (0xC2) → type 'metadata'", () => {
    const ch = root(jpeg(seg(0xc2, sofPayload(8, 8, 1)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sof2-0").type).toBe("metadata");
  });

  it("DRI (0xDD) → type 'metadata'", () => {
    const ch = root(jpeg(seg(0xdd, new Array(2).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dri-0").type).toBe("metadata");
  });

  it("COM (0xFE) → type 'metadata'", () => {
    const ch = root(jpeg(seg(0xfe, new Array(8).fill(0x41)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-com-0").type).toBe("metadata");
  });
});

// parse — markerIdx increments for regular markers, not for RST/SOS

describe("parse — markerIdx", () => {
  it("first regular marker gets index 0", () => {
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0")).toBeDefined();
  });

  it("second regular marker gets index 1", () => {
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)), seg(0xdb, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-1")).toBeDefined();
  });

  it("third regular marker gets index 2", () => {
    const ch = root(jpeg(seg(0xe0, new Array(4).fill(0)), seg(0xdb, new Array(4).fill(0)), seg(0xc4, new Array(4).fill(0)))).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dht-2")).toBeDefined();
  });

  it("SOS uses the current markerIdx (not yet incremented) for its id", () => {
    // 2 pre-markers consume indices 0 and 1 → SOS gets index 2
    const b = jpegWithScan(
      new Array(4).fill(0),
      [0xab],
      [
        seg(0xe0, new Array(4).fill(0)), // markerIdx 0 → 1
        seg(0xdb, new Array(4).fill(0)), // markerIdx 1 → 2
      ],
    );
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sos-2")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-scan-data-2")).toBeDefined();
  });

  it("RST markers (0xD0–0xD7) do NOT increment markerIdx", () => {
    // RST0 between APP0 and DQT: DQT still gets index 1 (not 2)
    const b = loadBuffer(
      new Uint8Array([
        0xff,
        0xd8, // SOI
        ...seg(0xe0, new Array(4).fill(0)), // APP0 → markerIdx 0→1
        0xff,
        0xd0, // RST0 (skipped, no increment)
        ...seg(0xdb, new Array(4).fill(0)), // DQT → markerIdx 1
        0xff,
        0xd9, // EOI
      ]).buffer,
    );
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-1")).toBeDefined();
  });
});

// parse — SOF dimensions extraction

describe("parse — SOF dimensions extraction", () => {
  // Layout: segment 0xFF byte at `offset`; parser reads:
  //   height     = readUint16(offset + 5, false)  ← sofPayload bytes [1,2]
  //   width      = readUint16(offset + 7, false)  ← sofPayload bytes [3,4]
  //   components = readUint8(offset + 9)           ← sofPayload byte [5]
  // Condition: code in [0xC0–0xC3] AND segLen >= 9.
  // sofPayload(h, w, c) produces 7 bytes → segLen = 2+7 = 9 ✓

  it("SOF0: root.meta.height is set from e_height field", () => {
    expect(root(jpeg(seg(0xc0, sofPayload(480, 640, 3)))).meta.height).toBe(480);
  });

  it("SOF0: root.meta.width is set from e_width field", () => {
    expect(root(jpeg(seg(0xc0, sofPayload(480, 640, 3)))).meta.width).toBe(640);
  });

  it("SOF0: root.meta.components is set from e_components field", () => {
    expect(root(jpeg(seg(0xc0, sofPayload(480, 640, 3)))).meta.components).toBe(3);
  });

  it("SOF1 (0xC1) also extracts dimensions", () => {
    expect(root(jpeg(seg(0xc1, sofPayload(100, 200, 1)))).meta.width).toBe(200);
    expect(root(jpeg(seg(0xc1, sofPayload(100, 200, 1)))).meta.height).toBe(100);
  });

  it("SOF2 (0xC2) also extracts dimensions", () => {
    expect(root(jpeg(seg(0xc2, sofPayload(320, 240, 3)))).meta.height).toBe(320);
  });

  it("SOF3 (0xC3) also extracts dimensions", () => {
    expect(root(jpeg(seg(0xc3, sofPayload(50, 75, 1)))).meta.components).toBe(1);
  });

  it("SOF with segLen < 9 does NOT update dimensions (stays 0)", () => {
    // 5-byte payload → segLen = 7 < 9 → no extraction
    const b = jpeg(seg(0xc0, new Array(5).fill(0)));
    expect(root(b).meta.width).toBe(0);
    expect(root(b).meta.height).toBe(0);
    expect(root(b).meta.components).toBe(0);
  });

  it("SOF with segLen exactly 8 does NOT update dimensions (< 9)", () => {
    // 6-byte payload → segLen = 8 < 9
    const b = jpeg(seg(0xc0, new Array(6).fill(0)));
    expect(root(b).meta.width).toBe(0);
  });

  it("SOF with segLen exactly 9 DOES extract dimensions", () => {
    // sofPayload produces 7 bytes → segLen = 9 ✓
    const b = jpeg(seg(0xc0, sofPayload(1, 1, 1)));
    expect(root(b).meta.width).toBe(1);
  });

  it("formatMeta.width is updated from SOF0", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(jpeg(seg(0xc0, sofPayload(240, 320, 3)))) as any).formatMeta.width).toBe(320);
  });

  it("formatMeta.height is updated from SOF0", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse(jpeg(seg(0xc0, sofPayload(240, 320, 3)))) as any).formatMeta.height).toBe(240);
  });

  it("second SOF overwrites the first (last-write wins)", () => {
    // The source overwrites width/height/components each time a SOF is encountered
    const b = jpeg(seg(0xc0, sofPayload(100, 200, 1)), seg(0xc0, sofPayload(480, 640, 3)));
    expect(root(b).meta.width).toBe(640);
    expect(root(b).meta.height).toBe(480);
    expect(root(b).meta.components).toBe(3);
  });
});

// parse — SOS handling (header + scan data, then break)

describe("parse — SOS handling", () => {
  // Reference layout for jpegWithScan([0,0,0,0], [0xAB,0xCD,0xEF]):
  //   SOI(2) | FF DA 00 06 00 00 00 00 (8) | 0xAB 0xCD 0xEF (3) | FF D9 (2)
  //   byteLength = 15
  //   SOS at offset=2: headerLen = segLen = 6, dataStart = 2+2+6 = 10
  //   scanEnd = 15-3 = 12
  //   scan range = (10, max(10, min(12, 14))) = (10, 12)
  const b3 = jpegWithScan([0, 0, 0, 0], [0xab, 0xcd, 0xef]);

  it("SOS produces two children: sos header and scan-data", () => {
    const ch = root(b3).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sos-0")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-scan-data-0")).toBeDefined();
  });

  it("SOS header id is 'jpeg-sos-0' (first marker)", () => {
    expect(root(jpegWithScan([0, 0, 0, 0], [])).children.find((c: { id: string }) => c.id === "jpeg-sos-0")).toBeDefined();
  });

  it("SOS header name is 'SOS — Start of Scan header'", () => {
    const sos = root(b3).children.find((c: { id: string }) => c.id === "jpeg-sos-0");
    expect(sos.name).toBe("SOS — Start of Scan header");
  });

  it("SOS header type is 'metadata'", () => {
    const sos = root(b3).children.find((c: { id: string }) => c.id === "jpeg-sos-0");
    expect(sos.type).toBe("metadata");
  });

  it("SOS header meta.segmentLength = headerLen = segLen (2 + payload.length)", () => {
    // 4-byte SOS payload → segLen = 6
    const sos = root(b3).children.find((c: { id: string }) => c.id === "jpeg-sos-0");
    expect(sos.meta.segmentLength).toBe(6);
  });

  it("SOS header range.start = sosOffset (= 2 when no pre-segments)", () => {
    const sos = root(b3).children.find((c: { id: string }) => c.id === "jpeg-sos-0");
    expect(sos.range.start).toBe(2);
  });

  it("SOS header range.end = min(sosOffset + 2 + headerLen - 1, byteLength-1) = min(9, 14) = 9", () => {
    const sos = root(b3).children.find((c: { id: string }) => c.id === "jpeg-sos-0");
    expect(sos.range.end).toBe(9);
  });

  it("SOS header flags: readable=true, writable=false, executable=false", () => {
    const sos = root(b3).children.find((c: { id: string }) => c.id === "jpeg-sos-0");
    expect(sos.flags).toEqual({ readable: true, writable: false, executable: false });
  });

  it("scan data child id is 'jpeg-scan-data-0'", () => {
    expect(root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0")).toBeDefined();
  });

  it("scan data child name is 'Scan Data — compressed entropy-coded image'", () => {
    const scan = root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0");
    expect(scan.name).toBe("Scan Data — compressed entropy-coded image");
  });

  it("scan data child type is 'data'", () => {
    const scan = root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0");
    expect(scan.type).toBe("data");
  });

  it("scan data range.start = dataStart = sosOffset + 2 + headerLen = 2+2+6 = 10", () => {
    const scan = root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0");
    expect(scan.range.start).toBe(10);
  });

  it("scan data range.end = max(dataStart, min(scanEnd, byteLength-1)) = max(10, min(12, 14)) = 12", () => {
    const scan = root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0");
    expect(scan.range.end).toBe(12);
  });

  it("scan data flags: readable=true, writable=false, executable=false", () => {
    const scan = root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0");
    expect(scan.flags).toEqual({ readable: true, writable: false, executable: false });
  });

  it("SOS scan data has NO markerCode meta field (unlike regular segments)", () => {
    const scan = root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0");
    expect(scan.meta).not.toHaveProperty("markerCode");
  });

  it("SOS scan data has NO segmentLength meta field", () => {
    const scan = root(b3).children.find((c: { id: string }) => c.id === "jpeg-scan-data-0");
    expect(scan.meta).not.toHaveProperty("segmentLength");
  });

  it("SOS terminates the walk — EOI after SOS is NOT added as a child", () => {
    const ch = root(b3).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-eoi")).toBeUndefined();
  });

  it("scan data NOT added when dataStart >= buf.byteLength", () => {
    // SOI(2) + FF DA 00 XX [payload fills rest] such that dataStart == byteLength
    // headerLen must equal byteLength - sosOffset - 2
    // Use: SOI(2) + [FF DA 00 04 00 00](6) = 8 bytes; no scan, no EOI
    // dataStart = 2+2+4 = 8 = byteLength → not added
    const all = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00]);
    const ch = root(loadBuffer(all.buffer)).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-scan-data-0")).toBeUndefined();
  });

  it("SOS after pre-segments uses the correct markerIdx for both children", () => {
    // APP0 → idx 0, DQT → idx 1; SOS → idx 2
    const b = jpegWithScan(new Array(4).fill(0), [0xab], [seg(0xe0, new Array(4).fill(0)), seg(0xdb, new Array(4).fill(0))]);
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sos-2")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-scan-data-2")).toBeDefined();
  });

  it("SOS range.start updates correctly when pre-segments shift its position", () => {
    // SOI(2) + APP0(8) = 10 bytes before SOS → SOS.range.start = 10
    const b = jpegWithScan(new Array(4).fill(0), [], [seg(0xe0, new Array(4).fill(0))]);
    const sos = root(b).children.find((c: { id: string }) => c.id === "jpeg-sos-1");
    expect(sos.range.start).toBe(10);
  });
});

// parse — RST markers (0xD0–0xD7) are skipped silently

describe("parse — RST markers skipped silently", () => {
  it.each([0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7] as const)("RST 0x%s is not added as a child (SOI + RST + EOI → 2 children)", (rst) => {
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, rst, 0xff, 0xd9]).buffer);
    const ch = root(b).children;
    expect(ch).toHaveLength(2);
    expect(ch[0].id).toBe("jpeg-soi");
    expect(ch[1].id).toBe("jpeg-eoi");
  });

  it("multiple consecutive RST markers produce no extra children", () => {
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xd3, 0xff, 0xd7, 0xff, 0xd9]).buffer);
    expect(root(b).children).toHaveLength(2);
  });
});

// parse — resync on non-0xFF byte

describe("parse — resync on non-0xFF byte", () => {
  it("single junk byte before EOI is skipped (offset++ → resync)", () => {
    // SOI(2) + 0xAB + EOI(2) = 5 bytes
    // Loop: offset=2, reads 0xAB (not 0xFF) → offset=3; reads [FF,D9] → EOI
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xab, 0xff, 0xd9]).buffer);
    const ch = root(b).children;
    expect(ch).toHaveLength(2);
    expect(ch[0].id).toBe("jpeg-soi");
    expect(ch[1].id).toBe("jpeg-eoi");
  });

  it("multiple consecutive junk bytes are all skipped one at a time", () => {
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]).buffer);
    const ch = root(b).children;
    expect(ch).toHaveLength(2);
  });

  it("after resync over junk, the next valid marker is parsed correctly", () => {
    // SOI + junk(1) + APP0(8) + EOI → 3 children
    const app0 = seg(0xe0, new Array(4).fill(0));
    const all = new Uint8Array(2 + 1 + app0.length + 2);
    all.set([0xff, 0xd8], 0);
    all.set([0x11], 2); // junk byte
    all.set(app0, 3);
    all.set([0xff, 0xd9], 3 + app0.length);
    const ch = root(loadBuffer(all.buffer)).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0")).toBeDefined();
  });
});

// parse — guard conditions (offset + 3 >= byteLength, segLen < 2)

describe("parse — guard conditions", () => {
  it("offset + 3 >= buf.byteLength for a regular marker → break (no child added)", () => {
    // SOI(2) + [FF E0 00] = 5 bytes; offset=2, offset+3=5 >= 5 → break
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]).buffer);
    const ch = root(b).children;
    expect(ch).toHaveLength(1);
    expect(ch[0].id).toBe("jpeg-soi");
  });

  it("offset + 3 == buf.byteLength (exactly): also breaks", () => {
    // SOI(2) + [FF E0 00 08] = 6 bytes; offset=2, offset+3=5 < 6 → reads segLen=8
    // then offset advances to 2+2+8=12 which exits the while loop
    // No crash, just no more children after APP0 range is computed (no EOI)
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x08]).buffer);
    // Should not throw
    expect(() => root(b)).not.toThrow();
  });

  it("segLen = 1 (< 2) → break immediately", () => {
    // SOI(2) + FF E0 00 01 = 6 bytes; segLen=1 < 2 → break
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]).buffer);
    const ch = root(b).children;
    expect(ch).toHaveLength(1);
    expect(ch[0].id).toBe("jpeg-soi");
  });

  it("segLen = 0 → break immediately", () => {
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]).buffer);
    const ch = root(b).children;
    expect(ch).toHaveLength(1);
  });

  it("SOS with offset + 3 >= buf.byteLength → break (no SOS child added)", () => {
    // SOI(2) + [FF DA 00] = 5 bytes; offset+3=5 >= 5 → break
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00]).buffer);
    const ch = root(b).children;
    expect(ch).toHaveLength(1);
  });

  it("large segLen declaration does not cause an exception (range clamped)", () => {
    const b = loadBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]).buffer);
    expect(() => root(b)).not.toThrow();
  });
});

// Integration — realistic JPEG structure

describe("Integration — realistic JPEG stream", () => {
  it("SOI + APP0 + DQT + SOF0 + DHT + SOS: all expected section IDs present", () => {
    // markerIdx: APP0=0, DQT=1, SOF0=2, DHT=3, SOS=4
    const b = jpegWithScan(
      new Array(4).fill(0),
      [0xab, 0xcd, 0xef],
      [
        seg(0xe0, new Array(14).fill(0)), // APP0
        seg(0xdb, new Array(64).fill(0)), // DQT
        seg(0xc0, sofPayload(240, 320, 3)), // SOF0
        seg(0xc4, new Array(16).fill(0)), // DHT
      ],
    );
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-soi")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-1")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sof0-2")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dht-3")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sos-4")).toBeDefined();
    expect(ch.find((c: { id: string }) => c.id === "jpeg-scan-data-4")).toBeDefined();
  });

  it("SOF0 dimensions propagate to both root.meta and formatMeta simultaneously", () => {
    const b = jpeg(seg(0xc0, sofPayload(768, 1024, 3)));
    const result = parse(b) as any; // eslint-disable-line
    expect(result.formatMeta.width).toBe(1024);
    expect(result.formatMeta.height).toBe(768);
    expect(result.root.meta.width).toBe(1024);
    expect(result.root.meta.height).toBe(768);
    expect(result.root.meta.components).toBe(3);
  });

  it("totalSize matches the actual byte count of the complete stream", () => {
    const b = jpeg(seg(0xe0, new Array(14).fill(0)), seg(0xc0, sofPayload(100, 100, 1)));
    expect(parse(b).totalSize).toBe(b.byteLength);
  });

  it("section order in children matches stream order", () => {
    const b = jpeg(seg(0xe0, new Array(4).fill(0)), seg(0xdb, new Array(4).fill(0)), seg(0xfe, new Array(4).fill(0x41)));
    const ch = root(b).children;
    const ids = ch.map((c: { id: string }) => c.id);
    expect(ids).toEqual(["jpeg-soi", "jpeg-app0-0", "jpeg-dqt-1", "jpeg-com-2", "jpeg-eoi"]);
  });

  it("DQT and DHT have type 'data'; APP0, SOF0, and COM have type 'metadata'", () => {
    const b = jpeg(seg(0xe0, new Array(4).fill(0)), seg(0xdb, new Array(4).fill(0)), seg(0xc0, sofPayload(8, 8, 1)), seg(0xc4, new Array(4).fill(0)), seg(0xfe, new Array(4).fill(0x41)));
    const ch = root(b).children;
    expect(ch.find((c: { id: string }) => c.id === "jpeg-app0-0").type).toBe("metadata");
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dqt-1").type).toBe("data");
    expect(ch.find((c: { id: string }) => c.id === "jpeg-sof0-2").type).toBe("metadata");
    expect(ch.find((c: { id: string }) => c.id === "jpeg-dht-3").type).toBe("data");
    expect(ch.find((c: { id: string }) => c.id === "jpeg-com-4").type).toBe("metadata");
  });

  it("all segment range.start values are strictly increasing (no overlap)", () => {
    const b = jpeg(seg(0xe0, new Array(4).fill(0)), seg(0xdb, new Array(4).fill(0)), seg(0xc4, new Array(4).fill(0)));
    const ch = root(b).children;
    const starts = ch.map((c: { range: { start: number } }) => c.range.start);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }
  });
});
