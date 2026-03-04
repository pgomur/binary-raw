/**
 * @file src/core/parsers/jpeg.ts
 * JPEG/JFIF parser: markers SOI, APPn, SOFn, DHT, DQT, SOS, EOI.
 */

import type { ParsedStructure, FormatMetadata, ByteCount } from "@app-types/index";
import { Offset, Bytes, Range, SectionBuilder } from "@app-types/index";
import type { BinaryBuffer } from "../buffer";
import { readUint8, readUint16, compareBytes } from "../buffer";

// Magic bytes

/** JPEG Start of Image signature: `0xFF 0xD8`. */
const JPEG_SOI = new Uint8Array([0xff, 0xd8]);

/**
 * Map of JPEG marker codes (the byte following `0xFF`) to their standard names.
 * Covers SOI/EOI, APPn, SOFn, DHT, DQT, SOS, DRI, and COM markers.
 */
const MARKERS = new Map<number, string>([
  [0xd8, "SOI"],
  [0xe0, "APP0"], // JFIF
  [0xe1, "APP1"], // EXIF / XMP
  [0xe2, "APP2"], // ICC Profile
  [0xed, "APP13"], // IPTC / Photoshop
  [0xee, "APP14"], // Adobe
  [0xdb, "DQT"], // Define Quantization Table
  [0xc0, "SOF0"], // Baseline DCT
  [0xc1, "SOF1"], // Extended sequential
  [0xc2, "SOF2"], // Progressive DCT
  [0xc3, "SOF3"], // Lossless
  [0xc4, "DHT"], // Define Huffman Table
  [0xda, "SOS"], // Start of Scan
  [0xdd, "DRI"], // Define Restart Interval
  [0xd9, "EOI"], // End of Image
  [0xfe, "COM"], // Comment
]);

// Detect

/**
 * Detects whether `buf` contains a JPEG image by verifying the SOI marker
 * (`0xFF 0xD8`) at offset 0.
 *
 * @param buf - The binary buffer to inspect.
 * @returns `true` if the buffer starts with a valid JPEG SOI marker.
 */
export function detect(buf: BinaryBuffer): boolean {
  return buf.byteLength >= 2 && compareBytes(buf, Offset.create(0), JPEG_SOI);
}

// Parse

/**
 * Parses a JPEG image and returns its structured representation.
 *
 * Walks the marker stream sequentially, producing one section per marker:
 * - **SOI** – fixed 2-byte Start of Image marker.
 * - **APPn / SOFn / DHT / DQT / DRI / COM** – variable-length segments with
 *   a 2-byte big-endian length field; `DQT` and `DHT` are typed as `'data'`,
 *   all others as `'metadata'`.
 * - **SOS** – header segment followed by a separate entropy-coded scan-data section.
 * - **EOI** – End of Image marker; terminates the walk.
 *
 * RST0–RST7 restart markers (no payload) are skipped silently.
 * Any `0xFF` byte that does not introduce a recognised sequence triggers a
 * one-byte resync to recover from padding or corrupted streams.
 *
 * Image dimensions and component count are extracted from the first SOF0–SOF3
 * segment encountered.
 *
 * @param buf - Raw JPEG image bytes.
 * @returns A {@link ParsedStructure} with `format` set to `'JPEG'` and
 *   `entryPoint` set to `undefined`.
 */
export function parse(buf: BinaryBuffer): ParsedStructure {
  let width = 0;
  let height = 0;
  let components = 0;
  let markerIdx = 0;

  const rootBuilder = new SectionBuilder()
    .id("jpeg-root")
    .name("JPEG Image")
    .type("container")
    .range(Range.create(Offset.create(0), Offset.create(buf.byteLength - 1)))
    .flags({ readable: true, writable: false, executable: false });

  // SOI — fixed 2 bytes
  rootBuilder.addChild(
    new SectionBuilder()
      .id("jpeg-soi")
      .name("SOI — Start of Image")
      .type("metadata")
      .range(Range.create(Offset.create(0), Offset.create(1)))
      .flags({ readable: true, writable: false, executable: false })
      .build(),
  );

  let offset = 2;

  while (offset + 1 < buf.byteLength) {
    const ff = readUint8(buf, Offset.create(offset));
    if (ff !== 0xff) {
      offset++;
      continue;
    } // resync

    const code = readUint8(buf, Offset.create(offset + 1));

    // RST0–RST7: no payload
    if (code >= 0xd0 && code <= 0xd7) {
      offset += 2;
      continue;
    }

    // EOI
    if (code === 0xd9) {
      rootBuilder.addChild(
        new SectionBuilder()
          .id("jpeg-eoi")
          .name("EOI — End of Image")
          .type("metadata")
          .range(Range.create(Offset.create(offset), Offset.create(Math.min(offset + 1, buf.byteLength - 1))))
          .flags({ readable: true, writable: false, executable: false })
          .build(),
      );
      break;
    }

    // SOS: length-prefixed header + entropy-coded scan data up to EOI
    if (code === 0xda) {
      if (offset + 3 >= buf.byteLength) break;
      const headerLen = readUint16(buf, Offset.create(offset + 2), false);
      const dataStart = offset + 2 + headerLen;
      const scanEnd = buf.byteLength - 3; // just before EOI

      rootBuilder.addChild(
        new SectionBuilder()
          .id(`jpeg-sos-${markerIdx}`)
          .name("SOS — Start of Scan header")
          .type("metadata")
          .range(Range.create(Offset.create(offset), Offset.create(Math.min(offset + 2 + headerLen - 1, buf.byteLength - 1))))
          .flags({ readable: true, writable: false, executable: false })
          .meta("segmentLength", headerLen)
          .build(),
      );

      if (dataStart < buf.byteLength) {
        rootBuilder.addChild(
          new SectionBuilder()
            .id(`jpeg-scan-data-${markerIdx}`)
            .name("Scan Data — compressed entropy-coded image")
            .type("data")
            .range(Range.create(Offset.create(dataStart), Offset.create(Math.max(dataStart, Math.min(scanEnd, buf.byteLength - 1)))))
            .flags({ readable: true, writable: false, executable: false })
            .build(),
        );
      }
      break;
    }

    // All other markers: 2-byte big-endian length field
    if (offset + 3 >= buf.byteLength) break;
    const segLen = readUint16(buf, Offset.create(offset + 2), false);
    if (segLen < 2) break;

    const segEnd = offset + 2 + segLen - 1;
    const markerName = MARKERS.get(code) ?? `APP${(code - 0xe0).toString().padStart(2, "0")}`;

    // SOF0–SOF3: extract image dimensions and component count
    if (code >= 0xc0 && code <= 0xc3 && segLen >= 9) {
      height = readUint16(buf, Offset.create(offset + 5), false);
      width = readUint16(buf, Offset.create(offset + 7), false);
      components = readUint8(buf, Offset.create(offset + 9));
    }

    const sectionType = code === 0xdb || code === 0xc4 ? ("data" as const) : ("metadata" as const);

    rootBuilder.addChild(
      new SectionBuilder()
        .id(`jpeg-${markerName.toLowerCase()}-${markerIdx}`)
        .name(`${markerName} (length: ${segLen})`)
        .type(sectionType)
        .range(Range.create(Offset.create(offset), Offset.create(Math.min(segEnd, buf.byteLength - 1))))
        .flags({ readable: true, writable: false, executable: false })
        .meta("markerCode", `0xFF${code.toString(16).toUpperCase().padStart(2, "0")}`)
        .meta("segmentLength", segLen)
        .build(),
    );

    markerIdx++;
    offset += 2 + segLen;
  }

  const formatMeta: FormatMetadata = { format: "JPEG", width, height };

  return {
    format: "JPEG",
    formatMeta,
    root: rootBuilder.meta("width", width).meta("height", height).meta("components", components).build(),
    totalSize: buf.byteLength as ByteCount,
    entryPoint: undefined,
  };
}
