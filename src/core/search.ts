/**
 * @file Search utilities for binary buffers using branded types.
 * Provides type safety and safe memory access.
 */

import type { AbsoluteOffset, ByteRange } from "@app-types/index";
import { Offset, Bytes } from "@app-types/index";
import type { BinaryBuffer } from "@core/buffer";
import { readUint8 } from "@core/buffer";

export interface SearchOptions {
  readonly range?: ByteRange;
  readonly maxResults?: number;
}

/**
 * Finds the first occurrence of a byte pattern starting from an offset.
 */
export function findNext(buf: BinaryBuffer, pattern: Uint8Array, startOffset: AbsoluteOffset = Offset.create(0)): AbsoluteOffset | null {
  const patternLength = Bytes.create(pattern.length);
  if (patternLength === 0 || buf.byteLength === 0) return null;

  const remainingSize = Offset.diff(Offset.create(buf.byteLength), startOffset);
  if (remainingSize < patternLength) return null;

  const maxSearchEnd = Offset.create(buf.byteLength - patternLength);

  for (let i = startOffset; i <= maxSearchEnd; i = Offset.add(i, Bytes.create(1))) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      const expected = pattern[j];
      // Guard for noUncheckedIndexedAccess
      if (expected === undefined) {
        match = false;
        break;
      }
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

/**
 * Finds all occurrences of a byte pattern within the buffer or a range.
 */
export function findAll(buf: BinaryBuffer, pattern: Uint8Array, options: SearchOptions = {}): readonly AbsoluteOffset[] {
  const results: AbsoluteOffset[] = [];
  const patternLength = Bytes.create(pattern.length);
  if (patternLength === 0 || buf.byteLength === 0) return results;

  const maxLimit = options.maxResults ?? Number.MAX_SAFE_INTEGER;

  const start = options.range ? options.range.start : Offset.create(0);
  const end = options.range ? options.range.end : Offset.create(buf.byteLength - 1);

  if (start > end) return results;
  const rangeLength = Bytes.fromRange(start, end);
  if (rangeLength < patternLength) return results;

  const bufferSpace = buf.byteLength - patternLength;
  const rangeSpace = (end as number) - patternLength + 1;
  const maxSearchEnd = Offset.create(Math.min(bufferSpace, rangeSpace));

  for (let i = start; i <= maxSearchEnd; i = Offset.add(i, Bytes.create(1))) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      const expected = pattern[j];
      // Guard for noUncheckedIndexedAccess
      if (expected === undefined) {
        match = false;
        break;
      }
      const checkOffset = Offset.add(i, Bytes.create(j));
      if (readUint8(buf, checkOffset) !== expected) {
        match = false;
        break;
      }
    }
    if (match) {
      results.push(i);
      if (results.length >= maxLimit) break;
    }
  }

  return results;
}

/**
 * Converts an ASCII string to a Uint8Array for searching.
 */
export function asciiToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const b = bytes[i];
    // Guard for noUncheckedIndexedAccess (even though i is bounded, TS requires this)
    if (b === undefined) continue;
    bytes[i] = charCode & 0xff;
  }
  return bytes;
}

/**
 * Finds all occurrences of an ASCII text string in the buffer.
 */
export function findAscii(buf: BinaryBuffer, text: string, options: SearchOptions = {}): readonly AbsoluteOffset[] {
  return findAll(buf, asciiToBytes(text), options);
}

/**
 * Converts a hexadecimal string to a Uint8Array.
 */
export function hexToBytes(hexPattern: string): Uint8Array {
  const cleanHex = hexPattern.replace(/\s+/g, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Hex pattern must have an even number of characters");
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    const byteStr = cleanHex.substring(i, i + 2);
    const byte = parseInt(byteStr, 16);
    if (isNaN(byte)) {
      throw new Error(`Invalid hex string: ${byteStr}`);
    }
    const target = bytes[i / 2];
    // Guard for noUncheckedIndexedAccess
    if (target === undefined) continue;
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Finds all occurrences of a hexadecimal sequence in the buffer.
 */
export function findHexPattern(buf: BinaryBuffer, hexPattern: string, options: SearchOptions = {}): readonly AbsoluteOffset[] {
  return findAll(buf, hexToBytes(hexPattern), options);
}
