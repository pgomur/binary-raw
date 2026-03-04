/**
 * @file Shannon entropy calculation over byte ranges.
 *
 * Shannon entropy measures the "randomness" of a byte block
 * on a scale of 0 to 8 bits per byte:
 *
 *   0.0 – 1.0  → very uniform data (NUL padding, empty zones)
 *   1.0 – 3.5  → plain text, source code, structured data
 *   3.5 – 6.0  → compiled executables, mixed data
 *   6.0 – 7.2  → compressed data, unencrypted audio/video
 *   7.2 – 8.0  → encrypted data, optimally compressed
 */

import type { AbsoluteOffset, ByteCount, ByteRange } from "@app-types/index";

// Constants

/** Entropy classification thresholds (Shannon scale 0-8) */
export const ENTROPY_THRESHOLDS = {
  UNIFORM: 0.5,    // Almost all zeros or identical bytes
  LOW:     4.5,    // Highly structured data, source code, text
  MEDIUM:  6.5,    // Mixed data, executables, intermediate code
  HIGH:    7.8,    // Very dense data, high compression
  MAX:     8.0,    // Maximum entropy (perfect encryption)
} as const;

/** Minimum window ratio to consider a segment valid */
const MIN_WINDOW_RATIO = 0.5;

// Public types

/** Result of calculating entropy for a range. */
export interface EntropyResult {
  /** Shannon entropy in bits per byte (0.0 – 8.0) */
  readonly entropy: number;
  /** Qualitative classification of the result */
  readonly classification: EntropyClass;
  /** Frequency of each byte (0–255), normalized to [0, 1] */
  readonly frequencies: Float64Array;
  /** Number of unique bytes found */
  readonly uniqueBytes: number;
  /** Most frequent byte */
  readonly dominantByte: number;
  /** Frequency of dominant byte (0.0 – 1.0) */
  readonly dominantFrequency: number;
}

export type EntropyClass =
  | "uniform"      // 0.0 – 1.0  — almost all same (NUL, 0xFF...)
  | "low"          // 1.0 – 3.5  — plain text, highly structured data
  | "medium"       // 3.5 – 6.0  — compiled code, mixed data
  | "high"         // 6.0 – 7.2  — compressed, multimedia
  | "encrypted";   // 7.2 – 8.0  — encrypted or optimally compressed

/** A segment of the entropy heat map. */
export interface EntropySegment {
  readonly offset: AbsoluteOffset;
  readonly length: ByteCount;
  readonly result: EntropyResult;
}

/** Section ranked by entropy */
export interface RankedSection {
  readonly name: string;
  readonly range: ByteRange;
  readonly result: EntropyResult;
}

// Simple cache for repeated calculations

const entropyCache = new Map<string, EntropyResult>();
const MAX_CACHE_SIZE = 1000;

function getCacheKey(buffer: Uint8Array, range: ByteRange): string {
  return `${buffer.length}:${range.start}:${range.end}`;
}

function getCachedResult(key: string): EntropyResult | undefined {
  return entropyCache.get(key);
}

function setCachedResult(key: string, result: EntropyResult): void {
  if (entropyCache.size >= MAX_CACHE_SIZE) {
    const firstKey = entropyCache.keys().next().value;
    if (firstKey !== undefined) {
      entropyCache.delete(firstKey);
    }
  }
  entropyCache.set(key, result);
}

/** Clears the entropy cache (useful for testing or freeing memory) */
export function clearEntropyCache(): void {
  entropyCache.clear();
}

// Main function

/**
 * Calculates the Shannon entropy of a byte range.
 *
 * Complexity: O(n) time, O(1) additional space (256 fixed counters).
 *
 * @param buffer - The complete file buffer
 * @param range  - Range to calculate (start, end, length)
 * @param useCache - If true, caches results for repeated calls
 * @returns EntropyResult with entropy, classification and statistics
 *
 * @example
 * const result = shannonEntropy(buffer, Range.create(Offset.create(0), Offset.create(1023)));
 * console.log(result.entropy);        // → 7.94
 * console.log(result.classification); // → "encrypted"
 */
export function shannonEntropy(
  buffer: Uint8Array,
  range: ByteRange,
  useCache = false
): EntropyResult {
  const start = range.start;
  const end = Math.min(range.end, buffer.length - 1);
  const len = end - start + 1;

  if (len <= 0) return emptyResult();

  if (useCache) {
    const key = getCacheKey(buffer, range);
    const cached = getCachedResult(key);
    if (cached) return cached;
  }

  // Paso 1: contar frecuencias absolutas
  const counts = new Uint32Array(256);

  for (let i = start; i <= end; i++) {
    const b = buffer[i];
    if (b === undefined) continue;
    const current = counts[b] ?? 0;
    counts[b] = current + 1;
  }

  // Paso 2: calcular entropía de Shannon
  let entropy = 0;
  let uniqueBytes = 0;
  let dominantByte = 0;
  let dominantCount = 0;

  const frequencies = new Float64Array(256);

  for (let byte = 0; byte < 256; byte++) {
    const count = counts[byte];
    if (count === undefined || count === 0) continue;

    uniqueBytes++;

    const p = count / len;
    frequencies[byte] = p;
    entropy -= p * Math.log2(p);

    if (count > dominantCount) {
      dominantCount = count;
      dominantByte = byte;
    }
  }

  // Entropy is 0 if all bytes are the same or only one byte
  if (uniqueBytes <= 1) {
    entropy = 0;
  }

  entropy = Math.max(0, Math.min(ENTROPY_THRESHOLDS.MAX, entropy));

  const result: EntropyResult = {
    entropy,
    classification: classify(entropy),
    frequencies,
    uniqueBytes,
    dominantByte,
    dominantFrequency: dominantCount / len,
  };

  if (useCache) {
    setCachedResult(getCacheKey(buffer, range), result);
  }

  return result;
}

// Heat map

/**
 * Splits the buffer into segments of `windowSize` bytes and calculates
 * the entropy of each. Returns the complete file map.
 *
 * @param buffer     - Complete buffer
 * @param windowSize - Size of each window in bytes (default: 256)
 * @param step       - Step between windows (default: equal to windowSize)
 * @param skipResiduals - If true, skips final segments that are too small (< 50% of windowSize)
 */
export function entropyMap(
  buffer: Uint8Array,
  windowSize = 256,
  step = windowSize,
  skipResiduals = false
): EntropySegment[] {
  if (buffer.length === 0 || windowSize <= 0 || step <= 0) return [];

  const segments: EntropySegment[] = [];

  for (let i = 0; i < buffer.length; i += step) {
    const startN = i;
    const endN = Math.min(i + windowSize - 1, buffer.length - 1);
    const lengthN = endN - startN + 1;

    // Skip if segment is too small
    if (skipResiduals && lengthN < windowSize * MIN_WINDOW_RATIO) {
      continue;
    }

    const start = startN as AbsoluteOffset;
    const end = endN as AbsoluteOffset;
    const length = lengthN as ByteCount;

    const range: ByteRange = { start, end, length };

    segments.push({
      offset: start,
      length,
      result: shannonEntropy(buffer, range),
    });
  }

  return segments;
}

// Section comparison

/**
 * Calculates entropy of multiple sections and returns them sorted
 * from highest to lowest entropy.
 *
 * @param buffer   - Complete buffer
 * @param sections - Array of ranges to analyze
 * @param useCache - If true, uses internal cache
 */
export function rankSectionsByEntropy(
  buffer: Uint8Array,
  sections: ReadonlyArray<{ readonly name: string; readonly range: ByteRange }>,
  useCache = false
): RankedSection[] {
  return sections
    .map(({ name, range }) => ({
      name,
      range,
      result: shannonEntropy(buffer, range, useCache),
    }))
    .sort((a, b) => b.result.entropy - a.result.entropy);
}

// Normalization for visualization

/**
 * Normalizes an entropy value (0–8) to (0.0–1.0)
 */
export function normalizeEntropy(entropy: number): number {
  return Math.max(0, Math.min(1, entropy / ENTROPY_THRESHOLDS.MAX));
}

/**
 * Converts entropy to a CSS color in cold-to-hot scale.
 */
export function entropyToColor(entropy: number): string {
  const t = normalizeEntropy(entropy);

  if (t < 0.25) {
    const u = t / 0.25;
    return `rgba(${lerp(30, 74, u)}, ${lerp(80, 222, u)}, ${lerp(180, 128, u)}, 0.7)`;
  }
  if (t < 0.6) {
    const u = (t - 0.25) / 0.35;
    return `rgba(${lerp(74, 245, u)}, ${lerp(222, 158, u)}, ${lerp(128, 11, u)}, 0.7)`;
  }
  const u = (t - 0.6) / 0.4;
  return `rgba(${lerp(245, 248, u)}, ${lerp(158, 113, u)}, ${lerp(11, 113, u)}, 0.7)`;
}

// Heuristics

/** Indicates if a block is likely encrypted or compressed data. */
export function isProbablyEncrypted(result: EntropyResult): boolean {
  return result.entropy > 7.5 && result.uniqueBytes > 250;
}

/** Indicates if a block is likely plain ASCII text. */
export function isProbablyText(result: EntropyResult): boolean {
  // Plain text typically has low-medium entropy and many printable characters
  const printableRatio = result.frequencies.reduce((acc, p, byte) => {
    return (byte >= 0x20 && byte <= 0x7E) || byte === 0x0A || byte === 0x0D || byte === 0x09
      ? acc + p
      : acc;
  }, 0);

  return result.entropy < 5.2 && printableRatio > 0.85;
}

/** Indicates if a block is likely null padding. */
export function isProbablyPadding(result: EntropyResult): boolean {
  return result.dominantByte === 0x00 && result.dominantFrequency > 0.9;
}

// Internal helpers

function classify(entropy: number): EntropyClass {
  if (entropy < ENTROPY_THRESHOLDS.UNIFORM) return "uniform";
  if (entropy < ENTROPY_THRESHOLDS.LOW) return "low";
  if (entropy < ENTROPY_THRESHOLDS.MEDIUM) return "medium";
  if (entropy < ENTROPY_THRESHOLDS.HIGH) return "high";
  return "encrypted";
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function emptyResult(): EntropyResult {
  return {
    entropy: 0,
    classification: "uniform",
    frequencies: new Float64Array(256),
    uniqueBytes: 0,
    dominantByte: 0,
    dominantFrequency: 0,
  };
}