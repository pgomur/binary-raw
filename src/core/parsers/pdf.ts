/**
 * @file src/core/parsers/pdf.ts
 * PDF parser: header, body (objects), xref, trailer, %%EOF.
 */

import type { ParsedStructure, FormatMetadata, ByteCount } from '@app-types/index'
import { Offset, Bytes, Range, SectionBuilder } from '@app-types/index'
import type { BinaryBuffer } from '../buffer'
import { readUint8, compareBytes } from '../buffer'

// Magic bytes

/** PDF header signature: `%PDF`. */
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46])

// Text reading helpers

/**
 * Reads a single ASCII line from `buf` starting at `startOffset`,
 * stopping at CR (`0x0D`), LF (`0x0A`), or after `maxLen` bytes.
 *
 * @param buf         - The binary buffer to read from.
 * @param startOffset - Zero-based byte offset at which reading begins.
 * @param maxLen      - Maximum number of bytes to read (default: 256).
 * @returns The decoded line string, without the line terminator.
 */
function readAsciiLine(buf: BinaryBuffer, startOffset: number, maxLen = 256): string {
  let out = ''
  for (let i = 0; i < maxLen && startOffset + i < buf.byteLength; i++) {
    const b = readUint8(buf, Offset.create(startOffset + i))
    if (b === 0x0a || b === 0x0d) break
    out += String.fromCharCode(b)
  }
  return out
}

/**
 * Finds the **last** occurrence of an ASCII literal in `buf` by scanning
 * backward from the end. Useful for locating `xref` and `%%EOF`.
 *
 * @param buf  - The binary buffer to search.
 * @param text - The ASCII string to locate.
 * @returns The byte offset of the last match, or `-1` if not found.
 */
function findLastAscii(buf: BinaryBuffer, text: string): number {
  if (text.length === 0 || buf.byteLength < text.length) return -1

  const codes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    codes[i] = text.charCodeAt(i)
  }

  outer:
  for (let i = buf.byteLength - text.length; i >= 0; i--) {
    for (let j = 0; j < codes.length; j++) {
      const expected = codes[j]
      if (expected === undefined) continue outer
      if (readUint8(buf, Offset.create(i + j)) !== expected) continue outer
    }
    return i
  }
  return -1
}

/**
 * Finds the **first** occurrence of an ASCII literal in `buf` starting
 * at `startOffset`.
 *
 * @param buf         - The binary buffer to search.
 * @param text        - The ASCII string to locate.
 * @param startOffset - Byte offset at which the search begins (default: 0).
 * @returns The byte offset of the first match, or `-1` if not found.
 */
function findAscii(buf: BinaryBuffer, text: string, startOffset = 0): number {
  if (text.length === 0) return startOffset

  const codes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    codes[i] = text.charCodeAt(i)
  }

  outer:
  for (let i = startOffset; i <= buf.byteLength - text.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      const expected = codes[j]
      if (expected === undefined) continue outer
      if (readUint8(buf, Offset.create(i + j)) !== expected) continue outer
    }
    return i
  }
  return -1
}

// Detect

/**
 * Detects whether `buf` contains a PDF document by verifying the `%PDF`
 * magic bytes at offset 0.
 *
 * @param buf - The binary buffer to inspect.
 * @returns `true` if the buffer starts with a valid PDF signature.
 */
export function detect(buf: BinaryBuffer): boolean {
  return buf.byteLength >= 4 && compareBytes(buf, Offset.create(0), PDF_MAGIC)
}

// Parse

/**
 * Parses a PDF document and returns its structured representation.
 *
 * Produces the following sections:
 * - **Header** – the `%PDF-X.Y` version line and optional binary-hint comment.
 * - **Indirect objects** – up to 200 `obj … endobj` blocks (100 added as tree nodes).
 * - **Cross-Reference Table** – the `xref` section, if present.
 * - **Trailer** – the `startxref` keyword through `%%EOF`.
 *
 * Object scanning is capped at **200 entries** and tree nodes at **100** to
 * avoid O(n²) performance on large files.
 *
 * @param buf - Raw PDF document bytes.
 * @returns A {@link ParsedStructure} with `format` set to `'PDF'` and
 *   `entryPoint` set to `undefined`.
 */
export function parse(buf: BinaryBuffer): ParsedStructure {
  // 1. Header (%PDF-X.Y)
  const headerLine   = readAsciiLine(buf, 0, 24)
  const versionMatch = /^%PDF-(\d+\.\d+)/.exec(headerLine)
  const version      = versionMatch?.[1] ?? 'unknown'

  // End of header: first line + optional binary-hint comment line (%XXX)
  let headerEnd = headerLine.length
  // Advance past the first line terminator
  while (headerEnd < buf.byteLength && headerEnd < 30) {
    const b = readUint8(buf, Offset.create(headerEnd))
    if (b === 0x0a || b === 0x0d) { headerEnd++; break }
    headerEnd++
  }
  // Optional binary-hint line (starts with %)
  if (headerEnd < buf.byteLength) {
    const maybePercent = readUint8(buf, Offset.create(headerEnd))
    if (maybePercent === 0x25) {
      while (headerEnd < buf.byteLength) {
        const b = readUint8(buf, Offset.create(headerEnd))
        if (b === 0x0a || b === 0x0d) { headerEnd++; break }
        headerEnd++
      }
    }
  }

  const rootBuilder = new SectionBuilder()
    .id('pdf-root')
    .name(`PDF ${version}`)
    .type('container')
    .range(Range.create(Offset.create(0), Offset.create(buf.byteLength - 1)))
    .flags({ readable: true, writable: false, executable: false })
    .meta('version', version)

  rootBuilder.addChild(
    new SectionBuilder()
      .id('pdf-header')
      .name(`Header — %PDF-${version}`)
      .type('metadata')
      .range(Range.create(Offset.create(0), Offset.create(Math.max(0, headerEnd - 1))))
      .flags({ readable: true, writable: false, executable: false })
      .meta('version', version)
      .build()
  )

  // 2. Indirect objects (N G obj ... endobj)
  // Strategy: scan forward for " obj\n" or " obj\r" literals.
  // Capped at MAX_OBJECTS to avoid O(n²) on large files.

  const MAX_OBJECTS = 200
  let objectCount   = 0
  let scanPos       = headerEnd

  while (objectCount < MAX_OBJECTS && scanPos < buf.byteLength) {
    const objPos = findAscii(buf, ' obj', scanPos)
    if (objPos === -1) break

    // The preceding byte must be a digit (generation number); otherwise skip
    if (objPos > 0) {
      const prevChar = readUint8(buf, Offset.create(objPos - 1))
      if (prevChar < 0x30 || prevChar > 0x39) { scanPos = objPos + 4; continue }
    }

    // Find the matching "endobj" from objPos onward
    const endPos = findAscii(buf, 'endobj', objPos + 4)
    if (endPos === -1) break

    const objEnd = endPos + 5  // last byte of "endobj"

    // Read the object number line for a display label
    const objLine = readAsciiLine(buf, Math.max(0, objPos - 20), 24).trim()

    objectCount++
    if (objectCount <= 100) {  // limit tree nodes to avoid excessive depth
      rootBuilder.addChild(
        new SectionBuilder()
          .id(`pdf-obj-${objectCount}`)
          .name(`Object ${objectCount}${objLine ? ` (${objLine})` : ''}`)
          .type('data')
          .range(Range.create(
            Offset.create(Math.max(0, objPos - 20)),
            Offset.create(Math.min(objEnd, buf.byteLength - 1))
          ))
          .flags({ readable: true, writable: false, executable: false })
          .build()
      )
    }

    scanPos = objEnd + 1
  }

  // 3. Cross-Reference (xref table or xref stream)
  const xrefPos  = findLastAscii(buf, '\nxref')
  const xrefStart = xrefPos !== -1 ? xrefPos + 1 : findLastAscii(buf, 'xref')

  const startxrefPos = findLastAscii(buf, 'startxref')
  const eofPos       = findLastAscii(buf, '%%EOF')

  if (xrefStart !== -1 && startxrefPos !== -1 && xrefStart < startxrefPos) {
    rootBuilder.addChild(
      new SectionBuilder()
        .id('pdf-xref')
        .name('Cross-Reference Table')
        .type('metadata')
        .range(Range.create(
          Offset.create(xrefStart),
          Offset.create(startxrefPos - 1)
        ))
        .flags({ readable: true, writable: false, executable: false })
        .build()
    )
  }

  // 4. Trailer (startxref … %%EOF)
  if (startxrefPos !== -1) {
    const trailerEnd = eofPos !== -1
      ? Math.min(eofPos + 4, buf.byteLength - 1)
      : buf.byteLength - 1

    rootBuilder.addChild(
      new SectionBuilder()
        .id('pdf-trailer')
        .name('Trailer — startxref + %%EOF')
        .type('metadata')
        .range(Range.create(
          Offset.create(startxrefPos),
          Offset.create(trailerEnd)
        ))
        .flags({ readable: true, writable: false, executable: false })
        .build()
    )
  }

  const formatMeta: FormatMetadata = { format: 'PDF', version }

  return {
    format:     'PDF',
    formatMeta,
    root:       rootBuilder
                  .meta('version', version)
                  .meta('objectCount', objectCount)
                  .meta('hasXref', xrefStart !== -1)
                  .build(),
    totalSize:  buf.byteLength as ByteCount,
    entryPoint: undefined,
  }
}