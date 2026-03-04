// src/core/parsers/png.ts
// Parser de PNG: signature, chunks IHDR/IDAT/IEND y auxiliares.
// CRC-32 verificado por chunk. Importa: core/buffer.ts, app-types/index.ts

import type { ParsedStructure, FormatMetadata, ByteCount } from '@app-types/index'
import { Offset, Bytes, Range, SectionBuilder } from '@app-types/index'
import type { BinaryBuffer } from '../buffer'
import { readUint8, readUint32, compareBytes } from '../buffer'

// Magic bytes

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Chunk types

const CHUNK_NAMES = new Map<string, string>([
  ['IHDR', 'Image Header'],
  ['PLTE', 'Palette'],
  ['IDAT', 'Image Data'],
  ['IEND', 'Image Trailer'],
  ['tEXt', 'Textual Data'],
  ['zTXt', 'Compressed Textual Data'],
  ['iTXt', 'International Textual Data'],
  ['cHRM', 'Primary Chromaticities'],
  ['gAMA', 'Image Gamma'],
  ['iCCP', 'Embedded ICC Profile'],
  ['sRGB', 'Standard RGB Colour Space'],
  ['bKGD', 'Background Colour'],
  ['hIST', 'Image Histogram'],
  ['tRNS', 'Transparency'],
  ['pHYs', 'Physical Pixel Dimensions'],
  ['sBIT', 'Significant Bits'],
  ['sPLT', 'Suggested Palette'],
  ['tIME', 'Image Last-Modification Time'],
])

const COLOR_TYPES: Record<number, string> = {
  0: 'Grayscale',
  2: 'Truecolour (RGB)',
  3: 'Indexed-colour',
  4: 'Greyscale with alpha',
  6: 'Truecolour with alpha (RGBA)',
}

// CRC-32 (IEEE 802.3)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c
  }
  return t
})()

function crc32(buf: BinaryBuffer, startByte: number, length: number): number {
  let crc = 0xffffffff
  for (let i = 0; i < length && startByte + i < buf.byteLength; i++) {
    const byte  = readUint8(buf, Offset.create(startByte + i))
    const index = (crc ^ byte) & 0xff
    const entry = CRC_TABLE[index]
    if (entry !== undefined) crc = entry ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Detect

export function detect(buf: BinaryBuffer): boolean {
  return buf.byteLength >= 8 && compareBytes(buf, Offset.create(0), PNG_MAGIC)
}

// Parse

export function parse(buf: BinaryBuffer): ParsedStructure {
  let width      = 0
  let height     = 0
  let bitDepth   = 0
  let colorType  = 0
  let interlace  = 0
  let idatCount  = 0
  let chunkIndex = 0

  const rootBuilder = new SectionBuilder()
    .id('png-root')
    .name('PNG Image')
    .type('container')
    .range(Range.create(Offset.create(0), Offset.create(buf.byteLength - 1)))
    .flags({ readable: true, writable: false, executable: false })

  // Signature (8 bytes)
  rootBuilder.addChild(
    new SectionBuilder()
      .id('png-signature')
      .name('PNG Signature')
      .type('metadata')
      .range(Range.create(Offset.create(0), Offset.create(7)))
      .flags({ readable: true, writable: false, executable: false })
      .build()
  )

  let offset = 8

  while (offset + 12 <= buf.byteLength) {
    // Layout: [dataLen:4][type:4][data:dataLen][crc:4]
    const dataLen  = readUint32(buf, Offset.create(offset),     false)  // big-endian
    const typeEnd  = offset + 8
    const dataEnd  = typeEnd + dataLen
    const chunkEnd = dataEnd + 4  // incluye CRC

    if (chunkEnd > buf.byteLength) break  // chunk truncado

    // Leer los 4 bytes de tipo como ASCII
    const b0 = readUint8(buf, Offset.create(offset + 4))
    const b1 = readUint8(buf, Offset.create(offset + 5))
    const b2 = readUint8(buf, Offset.create(offset + 6))
    const b3 = readUint8(buf, Offset.create(offset + 7))
    const typeName = String.fromCharCode(b0, b1, b2, b3)

    // Verificar CRC: cubre tipo(4) + datos(dataLen)
    const storedCrc   = readUint32(buf, Offset.create(dataEnd), false)
    const computedCrc = crc32(buf, offset + 4, 4 + dataLen)
    const crcValid    = storedCrc === computedCrc

    // IHDR: extraer dimensiones y parámetros
    if (typeName === 'IHDR' && dataLen >= 13) {
      width     = readUint32(buf, Offset.create(offset + 8),  false)
      height    = readUint32(buf, Offset.create(offset + 12), false)
      bitDepth  = readUint8(buf,  Offset.create(offset + 16))
      colorType = readUint8(buf,  Offset.create(offset + 17))
      interlace = readUint8(buf,  Offset.create(offset + 21))
    }

    if (typeName === 'IDAT') idatCount++

    const chunkLabel = CHUNK_NAMES.get(typeName) ?? 'Ancillary Chunk'
    const secType    = typeName === 'IDAT' ? 'data' as const : 'metadata' as const

    rootBuilder.addChild(
      new SectionBuilder()
        .id(`png-chunk-${typeName.toLowerCase()}-${chunkIndex}`)
        .name(`${typeName} — ${chunkLabel} (${dataLen} bytes)`)
        .type(secType)
        .range(Range.create(
          Offset.create(offset),
          Offset.create(chunkEnd - 1)
        ))
        .flags({ readable: true, writable: false, executable: false })
        .meta('dataLength', dataLen)
        .meta('crcValid', crcValid)
        .meta('crcStored', `0x${storedCrc.toString(16).padStart(8, '0')}`)
        .build()
    )

    chunkIndex++
    if (typeName === 'IEND') break
    offset = chunkEnd
  }

  const formatMeta: FormatMetadata = { format: 'PNG', width, height }

  return {
    format:     'PNG',
    formatMeta,
    root:       rootBuilder
                  .meta('width', width)
                  .meta('height', height)
                  .meta('bitDepth', bitDepth)
                  .meta('colorType', COLOR_TYPES[colorType] ?? `unknown(${colorType})`)
                  .meta('interlaced', interlace === 1)
                  .meta('idatChunks', idatCount)
                  .build(),
    totalSize:  buf.byteLength as ByteCount,
    entryPoint: undefined,
  }
}