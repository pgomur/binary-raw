/**
 * @file src/core/parsers/index.ts
 * Parser dispatcher: detects the format of an ArrayBuffer and delegates
 * to the corresponding parser.
 */

import type { ParsedStructure, FileFormat } from "@app-types/index";
import { Offset, Range, SectionBuilder } from "@app-types/index";
import { loadBuffer } from "../buffer";
import type { BinaryBuffer } from "../buffer";

import * as Elf from "./elf";
import * as Pe from "./pe";
import * as Pdf from "./pdf";
import * as Png from "./png";
import * as Jpeg from "./jpeg";
import * as Zip from "./zip";

// Public types

/**
 * Discriminated union returned by {@link parseBuffer}.
 * On success, carries the parsed {@link ParsedStructure};
 * on failure, carries a typed {@link ParseError}.
 */
export type ParseResult = { readonly ok: true; readonly structure: ParsedStructure } | { readonly ok: false; readonly error: ParseError };

/**
 * Typed error thrown (and caught) by the parser dispatcher.
 *
 * @property code  - Machine-readable error category.
 * @property cause - Original exception, if any.
 */
export class ParseError extends Error {
  constructor(
    message: string,
    public readonly code: "UNKNOWN_FORMAT" | "PARSE_FAILED" | "BUFFER_TOO_SMALL",
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

// Parser registry

/**
 * Descriptor for a single registered format parser.
 *
 * @property format  - The {@link FileFormat} this entry handles.
 * @property minSize - Minimum buffer length required to attempt detection.
 * @property detect  - Returns `true` if the buffer matches this format.
 * @property parse   - Produces a {@link ParsedStructure} from the buffer.
 */
interface ParserEntry {
  readonly format: FileFormat;
  readonly minSize: number;
  readonly detect: (buf: BinaryBuffer) => boolean;
  readonly parse: (buf: BinaryBuffer) => ParsedStructure;
}

// Order matters: formats with more specific magic bytes come first.
// ELF, PE, PNG, JPEG, and ZIP have unambiguous signatures.
// PDF has a start-of-file signature but may contain binary data.
// BIN is the fallback — always detected, never parsed to a structure.

const PARSERS: readonly ParserEntry[] = [
  { format: "ELF", minSize: 16, detect: Elf.detect, parse: Elf.parse },
  { format: "PE", minSize: 64, detect: Pe.detect, parse: Pe.parse },
  { format: "PNG", minSize: 8, detect: Png.detect, parse: Png.parse },
  { format: "JPEG", minSize: 2, detect: Jpeg.detect, parse: Jpeg.parse },
  { format: "ZIP", minSize: 4, detect: Zip.detect, parse: Zip.parse },
  { format: "PDF", minSize: 4, detect: Pdf.detect, parse: Pdf.parse },
];

// Public API

/**
 * Detects the format of `arrayBuffer` and parses it into a {@link ParsedStructure}.
 * Falls back to a generic BIN structure if no registered parser matches.
 *
 * @param arrayBuffer - The `ArrayBuffer` of the loaded file.
 * @returns A {@link ParseResult} containing the structure or a typed {@link ParseError}.
 */
export function parseBuffer(arrayBuffer: ArrayBuffer): ParseResult {
  if (arrayBuffer.byteLength === 0) {
    return {
      ok: false,
      error: new ParseError("Buffer is empty", "BUFFER_TOO_SMALL"),
    };
  }

  const buf = loadBuffer(arrayBuffer);

  for (const entry of PARSERS) {
    if (buf.byteLength < entry.minSize) continue;

    let detected = false;
    try {
      detected = entry.detect(buf);
    } catch {
      // detect should never throw, but if it does we skip this entry
      continue;
    }

    if (!detected) continue;

    try {
      const structure = entry.parse(buf);
      return { ok: true, structure };
    } catch (cause) {
      return {
        ok: false,
        error: new ParseError(`Failed to parse ${entry.format} file`, "PARSE_FAILED", cause),
      };
    }
  }

  // Fallback: BIN
  try {
    const structure = parseBin(buf);
    return { ok: true, structure };
  } catch (cause) {
    return {
      ok: false,
      error: new ParseError("Failed to create BIN structure", "PARSE_FAILED", cause),
    };
  }
}

/**
 * Detects the format of `arrayBuffer` without fully parsing it.
 * Useful for displaying the file type in the UI before committing to a full parse.
 *
 * @param arrayBuffer - The `ArrayBuffer` of the loaded file.
 * @returns The detected {@link FileFormat}, or `'BIN'` if no parser matches.
 */
export function detectFormat(arrayBuffer: ArrayBuffer): FileFormat {
  if (arrayBuffer.byteLength === 0) return "BIN";

  const buf = loadBuffer(arrayBuffer);

  for (const entry of PARSERS) {
    if (buf.byteLength < entry.minSize) continue;
    try {
      if (entry.detect(buf)) return entry.format;
    } catch {
      continue;
    }
  }

  return "BIN";
}

/**
 * Returns `true` if the given format has a registered parser (i.e. is not `'BIN'`).
 *
 * @param format - The {@link FileFormat} to check.
 */
export function isFormatSupported(format: FileFormat): boolean {
  return format !== "BIN" && PARSERS.some((p) => p.format === format);
}

/**
 * Returns the list of formats with a registered parser (excludes `'BIN'`).
 */
export function supportedFormats(): readonly FileFormat[] {
  return PARSERS.map((p) => p.format);
}

// Fallback BIN

/**
 * Creates a generic {@link ParsedStructure} for binary files with no recognised format.
 * Splits the file into 4 KB blocks for the section tree (capped at 256 blocks).
 *
 * The `entropy` field in `formatMeta` is left at `0`; it is computed lazily
 * by `sidebar.ts` via `utils/entropy.ts`.
 *
 * @param buf - The binary buffer to wrap.
 * @returns A {@link ParsedStructure} with `format` set to `'BIN'`.
 */
function parseBin(buf: BinaryBuffer): ParsedStructure {
  const BLOCK_SIZE = 4096;
  const numBlocks = Math.ceil(buf.byteLength / BLOCK_SIZE);

  const rootBuilder = new SectionBuilder()
    .id("bin-root")
    .name("Binary Data")
    .type("container")
    .range(Range.create(Offset.create(0), Offset.create(buf.byteLength - 1)))
    .flags({ readable: true, writable: true, executable: false })
    .meta("size", buf.byteLength)
    .meta("blocks", numBlocks);

  for (let i = 0; i < numBlocks && i < 256; i++) {
    const blockStart = i * BLOCK_SIZE;
    const blockEnd = Math.min(blockStart + BLOCK_SIZE - 1, buf.byteLength - 1);

    rootBuilder.addChild(
      new SectionBuilder()
        .id(`bin-block-${i}`)
        .name(`Block ${i} (0x${blockStart.toString(16).padStart(8, "0")}–0x${blockEnd.toString(16).padStart(8, "0")})`)
        .type("data")
        .range(Range.create(Offset.create(blockStart), Offset.create(blockEnd)))
        .flags({ readable: true, writable: true, executable: false })
        .meta("offset", `0x${blockStart.toString(16)}`)
        .meta("size", blockEnd - blockStart + 1)
        .build(),
    );
  }

  return {
    format: "BIN",
    formatMeta: {
      format: "BIN",
      entropy: 0, // computed lazily by sidebar.ts via utils/entropy.ts
    },
    root: rootBuilder.build(),
    totalSize: buf.byteLength,
    entryPoint: undefined,
  };
}
