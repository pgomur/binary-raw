/**
 * @file Wraps the loaded file's ArrayBuffer with strict type safety.
 * Uses branded types without exceptions, no 'as' casts.
 */

import type { AbsoluteOffset, ByteCount } from "@app-types/index";
import { Offset, Bytes } from "@app-types/index";

// Domain errors

export class BufferError extends Error {
  constructor(
    message: string,
    public readonly code: "OUT_OF_BOUNDS" | "OVERFLOW" | "INVALID_OFFSET",
  ) {
    super(message);
    this.name = "BufferError";
  }
}

// Main type

export interface BinaryBuffer {
  readonly byteLength: ByteCount;
  readonly view: DataView;
  readonly buffer: ArrayBuffer;
}

// Constructor

/**
 * Loads an ArrayBuffer into a BinaryBuffer with branded types.
 */
export function loadBuffer(arrayBuffer: ArrayBuffer): BinaryBuffer {
  return {
    byteLength: Bytes.create(arrayBuffer.byteLength),
    view: new DataView(arrayBuffer),
    buffer: arrayBuffer,
  };
}

// Internal validations with branded types

function assertInBounds(buf: BinaryBuffer, offset: AbsoluteOffset, size: ByteCount): void {
  // Use Offset.add for safe arithmetic
  const endOffset = Offset.add(offset, size);

  if (endOffset > buf.byteLength) {
    throw new BufferError(`Range ${offset} + ${size} exceeds buffer length ${buf.byteLength}`, "OUT_OF_BOUNDS");
  }
}

// Single byte reading

/**
 * Reads an unsigned 8-bit integer at the given offset.
 */
export function readUint8(buf: BinaryBuffer, offset: AbsoluteOffset): number {
  assertInBounds(buf, offset, Bytes.create(1));
  return buf.view.getUint8(offset);
}

/**
 * Reads a signed 8-bit integer at the given offset.
 */
export function readInt8(buf: BinaryBuffer, offset: AbsoluteOffset): number {
  assertInBounds(buf, offset, Bytes.create(1));
  return buf.view.getInt8(offset);
}

// Multi-byte value reading

/**
 * Reads an unsigned 16-bit integer at the given offset.
 */
export function readUint16(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): number {
  assertInBounds(buf, offset, Bytes.create(2));
  return buf.view.getUint16(offset, littleEndian);
}

/**
 * Reads a signed 16-bit integer at the given offset.
 */
export function readInt16(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): number {
  assertInBounds(buf, offset, Bytes.create(2));
  return buf.view.getInt16(offset, littleEndian);
}

/**
 * Reads an unsigned 32-bit integer at the given offset.
 */
export function readUint32(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): number {
  assertInBounds(buf, offset, Bytes.create(4));
  return buf.view.getUint32(offset, littleEndian);
}

/**
 * Reads a signed 32-bit integer at the given offset.
 */
export function readInt32(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): number {
  assertInBounds(buf, offset, Bytes.create(4));
  return buf.view.getInt32(offset, littleEndian);
}

/**
 * Reads an unsigned 64-bit integer at the given offset.
 */
export function readUint64(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): bigint {
  assertInBounds(buf, offset, Bytes.create(8));
  return buf.view.getBigUint64(offset, littleEndian);
}

/**
 * Reads a signed 64-bit integer at the given offset.
 */
export function readInt64(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): bigint {
  assertInBounds(buf, offset, Bytes.create(8));
  return buf.view.getBigInt64(offset, littleEndian);
}

/**
 * Reads a 32-bit float at the given offset.
 */
export function readFloat32(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): number {
  assertInBounds(buf, offset, Bytes.create(4));
  return buf.view.getFloat32(offset, littleEndian);
}

/**
 * Reads a 64-bit float at the given offset.
 */
export function readFloat64(buf: BinaryBuffer, offset: AbsoluteOffset, littleEndian = true): number {
  assertInBounds(buf, offset, Bytes.create(8));
  return buf.view.getFloat64(offset, littleEndian);
}

// Range reading

/**
 * Reads a range of bytes from the buffer.
 */
export function readBytes(buf: BinaryBuffer, offset: AbsoluteOffset, length: ByteCount): Uint8Array {
  assertInBounds(buf, offset, length);
  const slice = new Uint8Array(buf.view.buffer, offset, length);
  return new Uint8Array(slice); // Defensive copy
}

// Magic bytes reading

/**
 * Reads magic bytes from the start of the buffer.
 */
export function readMagic(buf: BinaryBuffer, length: ByteCount): Uint8Array {
  // Use Bytes.fromRange or safe comparison
  const safeLength = length > buf.byteLength ? buf.byteLength : length;
  return readBytes(buf, Offset.create(0), safeLength);
}

// Pattern searching

/**
 * Finds a byte pattern in the buffer starting from the given offset.
 */
export function findBytes(buf: BinaryBuffer, pattern: Uint8Array, startOffset: AbsoluteOffset = Offset.create(0)): AbsoluteOffset | null {
  assertInBounds(buf, startOffset, Bytes.create(0));

  // Safe arithmetic with branded types
  const patternLength = Bytes.create(pattern.length);
  const maxSearchEnd = Offset.add(startOffset, Bytes.create(buf.byteLength - patternLength));

  for (let i = startOffset; i <= maxSearchEnd; i = Offset.add(i, Bytes.create(1))) {
    let match = true;
    for (let j = 0; j < pattern.length; j = j + 1) {
      const expected = pattern[j];
      if (expected === undefined) {
        match = false;
        break;
      }
      // Use Offset.add for the index
      const checkOffset = Offset.add(i, Bytes.create(j));
      if (readUint8(buf, checkOffset) !== expected) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  return null;
}

// Range comparison

/**
 * Compares bytes at an offset with an expected byte array.
 */
export function compareBytes(buf: BinaryBuffer, offset: AbsoluteOffset, expected: Uint8Array): boolean {
  const expectedLength = Bytes.create(expected.length);

  // Use Offset.add to validate range
  if (Offset.add(offset, expectedLength) > buf.byteLength) return false;

  for (let i = 0; i < expected.length; i = i + 1) {
    const expectedByte = expected[i];
    if (expectedByte === undefined) return false;

    const checkOffset = Offset.add(offset, Bytes.create(i));
    if (readUint8(buf, checkOffset) !== expectedByte) {
      return false;
    }
  }
  return true;
}

// Endianness utilities

/**
 * Swaps endianness of a 16-bit value.
 */
export function swapEndian16(value: number): number {
  return ((value & 0xff) << 8) | ((value >> 8) & 0xff);
}

/**
 * Swaps endianness of a 32-bit value.
 */
export function swapEndian32(value: number): number {
  return ((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >> 8) & 0xff00) | ((value >> 24) & 0xff);
}

// Buffer information

/**
 * Returns true if the buffer is empty.
 */
export function isEmpty(buf: BinaryBuffer): boolean {
  return buf.byteLength === 0;
}

/**
 * Returns the number of bytes remaining from the given offset.
 */
export function remainingBytes(buf: BinaryBuffer, fromOffset: AbsoluteOffset): ByteCount {
  if (fromOffset >= buf.byteLength) return Bytes.create(0);
  // Use Offset.diff for safe arithmetic
  return Offset.diff(Offset.create(buf.byteLength), fromOffset);
}
