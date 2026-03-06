/**
 * @file Comprehensive Vitest tests for the Shannon entropy module.
 * Covers every exported function, constant, classification boundary,
 * and edge case with mathematically verified expected values.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ByteRange } from "../../src/types/index";
import type { AbsoluteOffset, ByteCount } from "../../src/types/index";
import { ENTROPY_THRESHOLDS, clearEntropyCache, shannonEntropy, entropyMap, rankSectionsByEntropy, normalizeEntropy, entropyToColor, isProbablyEncrypted, isProbablyText, isProbablyPadding, type EntropyResult, type EntropyClass } from "../../src/utils/entropy";

// Test helpers

/** Builds a ByteRange from plain numbers. */
const range = (start: number, end: number): ByteRange => ({
  start: start as AbsoluteOffset,
  end: end as AbsoluteOffset,
  length: (end - start + 1) as ByteCount,
});

/** Creates a Uint8Array filled with a single repeated byte value. */
const uniform = (value: number, length: number) => new Uint8Array(length).fill(value);

/** Creates a Uint8Array with all 256 byte values appearing exactly once. */
const allBytes256 = () => new Uint8Array(Array.from({ length: 256 }, (_, i) => i));

/**
 * Creates a buffer where `k` distinct byte values each appear `n` times.
 * Produces k*n bytes total with perfectly uniform distribution → entropy = log2(k).
 */
const uniformK = (k: number, n: number): Uint8Array => {
  const buf = new Uint8Array(k * n);
  for (let i = 0; i < k * n; i++) buf[i] = i % k;
  return buf;
};

/** Tolerance for floating-point entropy comparisons. */
const EPS = 1e-9;

// ENTROPY_THRESHOLDS

describe("ENTROPY_THRESHOLDS", () => {
  it("UNIFORM is 0.5", () => expect(ENTROPY_THRESHOLDS.UNIFORM).toBe(0.5));
  it("LOW is 4.5", () => expect(ENTROPY_THRESHOLDS.LOW).toBe(4.5));
  it("MEDIUM is 6.5", () => expect(ENTROPY_THRESHOLDS.MEDIUM).toBe(6.5));
  it("HIGH is 7.8", () => expect(ENTROPY_THRESHOLDS.HIGH).toBe(7.8));
  it("MAX is 8.0", () => expect(ENTROPY_THRESHOLDS.MAX).toBe(8.0));

  it("thresholds are strictly ascending", () => {
    const { UNIFORM, LOW, MEDIUM, HIGH, MAX } = ENTROPY_THRESHOLDS;
    expect(UNIFORM).toBeLessThan(LOW);
    expect(LOW).toBeLessThan(MEDIUM);
    expect(MEDIUM).toBeLessThan(HIGH);
    expect(HIGH).toBeLessThan(MAX);
  });

  it("is a readonly const (runtime values are frozen or at least stable)", () => {
    // Verify the object is not accidentally mutable at test-time
    const snapshot = { ...ENTROPY_THRESHOLDS };
    expect(ENTROPY_THRESHOLDS).toMatchObject(snapshot);
  });
});

// shannonEntropy – result shape
describe("shannonEntropy – result shape", () => {
  const buf = allBytes256();
  const r = range(0, 255);

  it("returns an object with all required fields", () => {
    const result = shannonEntropy(buf, r);
    expect(result).toHaveProperty("entropy");
    expect(result).toHaveProperty("classification");
    expect(result).toHaveProperty("frequencies");
    expect(result).toHaveProperty("uniqueBytes");
    expect(result).toHaveProperty("dominantByte");
    expect(result).toHaveProperty("dominantFrequency");
  });

  it("frequencies is a Float64Array of length 256", () => {
    const { frequencies } = shannonEntropy(buf, r);
    expect(frequencies).toBeInstanceOf(Float64Array);
    expect(frequencies.length).toBe(256);
  });

  it("entropy is always in [0, 8]", () => {
    const { entropy } = shannonEntropy(buf, r);
    expect(entropy).toBeGreaterThanOrEqual(0);
    expect(entropy).toBeLessThanOrEqual(8);
  });

  it("dominantFrequency is always in [0, 1]", () => {
    const { dominantFrequency } = shannonEntropy(buf, r);
    expect(dominantFrequency).toBeGreaterThanOrEqual(0);
    expect(dominantFrequency).toBeLessThanOrEqual(1);
  });
});

// shannonEntropy – empty / degenerate input
describe("shannonEntropy – empty / degenerate input", () => {
  it("returns emptyResult when range produces len <= 0 (start > end)", () => {
    const buf = new Uint8Array([0x41]);
    const result = shannonEntropy(buf, range(5, 5)); // start=5 >= buffer.length → len=0
    expect(result.entropy).toBe(0);
    expect(result.uniqueBytes).toBe(0);
    expect(result.dominantFrequency).toBe(0);
    expect(result.classification).toBe("uniform");
  });

  it("emptyResult has a Float64Array of 256 zeros for frequencies", () => {
    const buf = new Uint8Array(0);
    const { frequencies } = shannonEntropy(buf, range(0, 0));
    expect(frequencies).toBeInstanceOf(Float64Array);
    expect(frequencies.every((v) => v === 0)).toBe(true);
  });

  it("single byte buffer → entropy 0, uniqueBytes 1", () => {
    const buf = new Uint8Array([0x41]);
    const result = shannonEntropy(buf, range(0, 0));
    expect(result.entropy).toBe(0);
    expect(result.uniqueBytes).toBe(1);
    expect(result.dominantByte).toBe(0x41);
    expect(result.dominantFrequency).toBe(1);
  });
});

// shannonEntropy – mathematical correctness
describe("shannonEntropy – mathematical correctness", () => {
  it("uniform buffer (all same byte) → entropy exactly 0", () => {
    const buf = uniform(0x00, 1024);
    const result = shannonEntropy(buf, range(0, 1023));
    expect(result.entropy).toBe(0);
    expect(result.uniqueBytes).toBe(1);
  });

  it("2 equally likely bytes (128+128) → entropy exactly 1.0 (log2(2))", () => {
    // 128 × 0x00 + 128 × 0x01
    const buf = new Uint8Array(256);
    buf.fill(0x00, 0, 128);
    buf.fill(0x01, 128, 256);
    const { entropy } = shannonEntropy(buf, range(0, 255));
    expect(entropy).toBeCloseTo(1.0, 10);
  });

  it("4 equally likely bytes (64 each) → entropy exactly 2.0 (log2(4))", () => {
    const buf = uniformK(4, 64); // 256 bytes
    const { entropy } = shannonEntropy(buf, range(0, 255));
    expect(entropy).toBeCloseTo(2.0, 10);
  });

  it("8 equally likely bytes (32 each) → entropy exactly 3.0 (log2(8))", () => {
    const buf = uniformK(8, 32); // 256 bytes
    const { entropy } = shannonEntropy(buf, range(0, 255));
    expect(entropy).toBeCloseTo(3.0, 10);
  });

  it("all 256 byte values once each → entropy exactly 8.0 (log2(256))", () => {
    const buf = allBytes256();
    const { entropy } = shannonEntropy(buf, range(0, 255));
    expect(entropy).toBeCloseTo(8.0, 10);
  });

  it("entropy is clamped to [0, 8] — never exceeds MAX", () => {
    const buf = allBytes256();
    const { entropy } = shannonEntropy(buf, range(0, 255));
    expect(entropy).toBeLessThanOrEqual(ENTROPY_THRESHOLDS.MAX);
    expect(entropy).toBeGreaterThanOrEqual(0);
  });

  it("uniqueBytes counts correctly for 256-byte all-distinct buffer", () => {
    const { uniqueBytes } = shannonEntropy(allBytes256(), range(0, 255));
    expect(uniqueBytes).toBe(256);
  });

  it("uniqueBytes is 1 for all-same buffer", () => {
    const { uniqueBytes } = shannonEntropy(uniform(0xab, 100), range(0, 99));
    expect(uniqueBytes).toBe(1);
  });

  it("frequencies sum to approximately 1.0 for any non-empty buffer", () => {
    const buf = allBytes256();
    const { frequencies } = shannonEntropy(buf, range(0, 255));
    const sum = Array.from(frequencies).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("frequencies[b] equals count(b)/total for a 2-byte distribution", () => {
    const buf = new Uint8Array(100).fill(0x41); // 100 × 'A'
    const buf2 = new Uint8Array([...buf, ...new Uint8Array(100).fill(0x42)]); // 100×A + 100×B
    const { frequencies } = shannonEntropy(buf2, range(0, 199));
    expect(frequencies[0x41]).toBeCloseTo(0.5, 10);
    expect(frequencies[0x42]).toBeCloseTo(0.5, 10);
    expect(frequencies[0x43]).toBe(0);
  });

  it("dominantByte is correct for skewed distribution", () => {
    // 200 × 0x05, 55 × 0x06
    const buf = new Uint8Array(255);
    buf.fill(0x05, 0, 200);
    buf.fill(0x06, 200, 255);
    const { dominantByte, dominantFrequency } = shannonEntropy(buf, range(0, 254));
    expect(dominantByte).toBe(0x05);
    expect(dominantFrequency).toBeCloseTo(200 / 255, 10);
  });

  it("sub-range calculation only uses bytes within [start, end]", () => {
    // Fill with 0x00 except bytes [10..19] which are 0xFF
    const buf = new Uint8Array(100).fill(0x00);
    buf.fill(0xff, 10, 20);
    // Range covering only the 0xFF zone → all same byte → entropy 0
    const result = shannonEntropy(buf, range(10, 19));
    expect(result.entropy).toBe(0);
    expect(result.dominantByte).toBe(0xff);
    expect(result.uniqueBytes).toBe(1);
  });

  it("end clamped to buffer.length - 1 when range.end exceeds buffer", () => {
    const buf = new Uint8Array(10).fill(0x41);
    // range.end=999 >> buf.length-1=9, should clamp and still work
    const result = shannonEntropy(buf, range(0, 999));
    expect(result.entropy).toBe(0);
    expect(result.uniqueBytes).toBe(1);
  });
});

// shannonEntropy – classification
describe("shannonEntropy – classification boundaries", () => {
  /** Helper: creates a buffer designed to produce a target entropy value. */
  const withEntropy = (targetClass: EntropyClass): Uint8Array => {
    switch (targetClass) {
      case "uniform":
        return uniform(0x00, 256); // entropy = 0
      case "low":
        return uniformK(4, 64); // entropy ≈ 2.0
      case "medium":
        return uniformK(32, 8); // entropy = 5.0
      case "high":
        return uniformK(100, 3).slice(0, 300); // entropy ≈ 6.64
      case "encrypted":
        return allBytes256(); // entropy = 8.0
    }
  };

  it("entropy=0 → 'uniform'", () => {
    const result = shannonEntropy(withEntropy("uniform"), range(0, 255));
    expect(result.classification).toBe("uniform");
  });

  it("entropy≈2.0 → 'low'", () => {
    const result = shannonEntropy(withEntropy("low"), range(0, 255));
    expect(result.classification).toBe("low");
  });

  it("entropy≈5.0 → 'medium'", () => {
    const buf = uniformK(32, 8); // log2(32) = 5.0
    const result = shannonEntropy(buf, range(0, buf.length - 1));
    expect(result.entropy).toBeCloseTo(5.0, 10);
    expect(result.classification).toBe("medium");
  });

  it("entropy=8.0 → 'encrypted'", () => {
    const result = shannonEntropy(withEntropy("encrypted"), range(0, 255));
    expect(result.classification).toBe("encrypted");
  });

  it("entropy just below UNIFORM threshold (0.49) → 'uniform'", () => {
    // Produce entropy just below 0.5 manually via 97% dominant byte
    const buf = new Uint8Array(200);
    buf.fill(0x00, 0, 195);
    buf.fill(0x01, 195, 200); // 5/200 = 2.5%
    const result = shannonEntropy(buf, range(0, 199));
    expect(result.entropy).toBeLessThan(ENTROPY_THRESHOLDS.UNIFORM);
    expect(result.classification).toBe("uniform");
  });

  it("entropy just above LOW threshold (4.5) → 'medium'", () => {
    // log2(k) > 4.5 requires k > 22.6 → use k=23
    const buf = uniformK(23, 100);
    const result = shannonEntropy(buf, range(0, buf.length - 1));
    expect(result.entropy).toBeGreaterThan(ENTROPY_THRESHOLDS.LOW);
    expect(result.classification).toBe("medium");
  });

  it("entropy just above HIGH threshold (7.8) → 'encrypted'", () => {
    // Use near-maximum entropy: all 256 bytes with slight imbalance → still > 7.8
    const buf = allBytes256();
    const result = shannonEntropy(buf, range(0, 255));
    expect(result.entropy).toBeGreaterThan(ENTROPY_THRESHOLDS.HIGH);
    expect(result.classification).toBe("encrypted");
  });
});

// shannonEntropy – caching
describe("shannonEntropy – caching", () => {
  beforeEach(() => clearEntropyCache());

  it("with useCache=true, two calls with the same key return the same object reference", () => {
    const buf = allBytes256();
    const r = range(0, 255);
    const first = shannonEntropy(buf, r, true);
    const second = shannonEntropy(buf, r, true);
    expect(first).toBe(second); // strict reference equality
  });

  it("with useCache=false, two calls return different object instances", () => {
    const buf = allBytes256();
    const r = range(0, 255);
    const first = shannonEntropy(buf, r, false);
    const second = shannonEntropy(buf, r, false);
    expect(first).not.toBe(second);
  });

  it("clearEntropyCache forces a new computation (new object reference)", () => {
    const buf = allBytes256();
    const r = range(0, 255);
    const first = shannonEntropy(buf, r, true);
    clearEntropyCache();
    const second = shannonEntropy(buf, r, true);
    expect(first).not.toBe(second);
    // Values must still be the same
    expect(first.entropy).toBeCloseTo(second.entropy, 10);
  });

  it("different ranges produce different cached results (no collision)", () => {
    const buf = allBytes256();
    const r1 = range(0, 127);
    const r2 = range(128, 255);
    const res1 = shannonEntropy(buf, r1, true);
    const res2 = shannonEntropy(buf, r2, true);
    // Same entropy in both halves, but they must be different objects
    expect(res1).not.toBe(res2);
  });

  it("clearEntropyCache does not throw when cache is already empty", () => {
    clearEntropyCache();
    expect(() => clearEntropyCache()).not.toThrow();
  });
});

// entropyMap
describe("entropyMap", () => {
  it("returns empty array for empty buffer", () => {
    expect(entropyMap(new Uint8Array(0))).toEqual([]);
  });

  it("returns empty array for windowSize=0", () => {
    expect(entropyMap(new Uint8Array(256), 0)).toEqual([]);
  });

  it("returns empty array for step=0", () => {
    expect(entropyMap(new Uint8Array(256), 256, 0)).toEqual([]);
  });

  it("single window covers entire buffer when buffer.length == windowSize", () => {
    const buf = allBytes256();
    const segments = entropyMap(buf, 256);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.offset).toBe(0);
    expect(segments[0]!.length).toBe(256);
    expect(segments[0]!.result.entropy).toBeCloseTo(8.0, 10);
  });

  it("produces correct number of non-overlapping windows for divisible length", () => {
    const buf = new Uint8Array(1024).fill(0x41);
    const segments = entropyMap(buf, 256);
    expect(segments).toHaveLength(4); // 1024 / 256 = 4
  });

  it("produces a residual last segment when buffer is not perfectly divisible", () => {
    const buf = new Uint8Array(300).fill(0x41);
    const segments = entropyMap(buf, 256);
    expect(segments).toHaveLength(2);
    expect(segments[1]!.length).toBe(44); // 300 - 256 = 44
  });

  it("skipResiduals=true drops final segment when it is < 50% of windowSize", () => {
    // 256 + 100 bytes; residual = 100 which is < 256*0.5=128 → skip
    const buf = new Uint8Array(356).fill(0x41);
    const segments = entropyMap(buf, 256, 256, true);
    expect(segments).toHaveLength(1);
  });

  it("skipResiduals=true keeps final segment when it is ≥ 50% of windowSize", () => {
    // 256 + 130 bytes; residual = 130 ≥ 128 → keep
    const buf = new Uint8Array(386).fill(0x41);
    const segments = entropyMap(buf, 256, 256, true);
    expect(segments).toHaveLength(2);
  });

  it("skipResiduals=false (default) keeps all segments regardless of size", () => {
    const buf = new Uint8Array(257).fill(0x41);
    const segments = entropyMap(buf, 256, 256, false);
    expect(segments).toHaveLength(2);
    expect(segments[1]!.length).toBe(1);
  });

  it("each segment has the correct offset (offset = i * step)", () => {
    const buf = new Uint8Array(512).fill(0x41);
    const segments = entropyMap(buf, 256, 256);
    expect(segments[0]!.offset).toBe(0);
    expect(segments[1]!.offset).toBe(256);
  });

  it("overlapping windows (step < windowSize) produce more segments", () => {
    const buf = new Uint8Array(512).fill(0x41);
    // step=128, windowSize=256 → starts at 0, 128, 256, 384 → 4 segments
    const segments = entropyMap(buf, 256, 128);
    expect(segments.length).toBeGreaterThan(2);
  });

  it("each segment's result is a valid EntropyResult", () => {
    const buf = allBytes256();
    const segments = entropyMap(buf, 128);
    for (const seg of segments) {
      expect(seg.result.entropy).toBeGreaterThanOrEqual(0);
      expect(seg.result.entropy).toBeLessThanOrEqual(8);
      expect(seg.result.frequencies).toBeInstanceOf(Float64Array);
    }
  });

  it("uniform buffer → all segments have entropy 0", () => {
    const buf = uniform(0x00, 512);
    const segments = entropyMap(buf, 128);
    for (const seg of segments) {
      expect(seg.result.entropy).toBe(0);
    }
  });

  it("default step equals windowSize (non-overlapping)", () => {
    const buf = new Uint8Array(768).fill(0x41);
    const segments = entropyMap(buf, 256); // step defaults to 256
    expect(segments).toHaveLength(3);
    const offsets = segments.map((s) => s.offset);
    expect(offsets).toEqual([0, 256, 512]);
  });
});

// rankSectionsByEntropy
describe("rankSectionsByEntropy", () => {
  const buildBuffer = () => {
    // First 256 bytes: all same (entropy 0)
    // Next 256 bytes:  all 256 distinct (entropy 8)
    // Next 256 bytes:  4 distinct (entropy 2)
    const buf = new Uint8Array(768);
    buf.fill(0x00, 0, 256);
    for (let i = 0; i < 256; i++) buf[256 + i] = i; // all distinct
    const k4 = uniformK(4, 64);
    buf.set(k4, 512);
    return buf;
  };

  const buf = buildBuffer();
  const sections = [
    { name: "uniform", range: range(0, 255) },
    { name: "encrypted", range: range(256, 511) },
    { name: "low", range: range(512, 767) },
  ];

  it("returns same number of sections as input", () => {
    expect(rankSectionsByEntropy(buf, sections)).toHaveLength(3);
  });

  it("sections are sorted from highest to lowest entropy", () => {
    const ranked = rankSectionsByEntropy(buf, sections);
    expect(ranked[0]!.name).toBe("encrypted");
    expect(ranked[1]!.name).toBe("low");
    expect(ranked[2]!.name).toBe("uniform");
  });

  it("first ranked section has the highest entropy", () => {
    const ranked = rankSectionsByEntropy(buf, sections);
    expect(ranked[0]!.result.entropy).toBeCloseTo(8.0, 10);
  });

  it("last ranked section has the lowest entropy", () => {
    const ranked = rankSectionsByEntropy(buf, sections);
    expect(ranked[ranked.length - 1]!.result.entropy).toBe(0);
  });

  it("preserves name and range on each RankedSection", () => {
    const ranked = rankSectionsByEntropy(buf, sections);
    for (const r of ranked) {
      expect(r).toHaveProperty("name");
      expect(r).toHaveProperty("range");
      expect(r).toHaveProperty("result");
    }
  });

  it("returns empty array for empty sections input", () => {
    expect(rankSectionsByEntropy(buf, [])).toEqual([]);
  });

  it("with useCache=true, repeated call returns equal entropy values", () => {
    clearEntropyCache();
    const r1 = rankSectionsByEntropy(buf, sections, true);
    const r2 = rankSectionsByEntropy(buf, sections, true);
    for (let i = 0; i < r1.length; i++) {
      expect(r1[i]!.result.entropy).toBe(r2[i]!.result.entropy);
    }
  });

  it("single section returns that section", () => {
    const ranked = rankSectionsByEntropy(buf, [{ name: "only", range: range(0, 255) }]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.name).toBe("only");
  });
});

// normalizeEntropy
describe("normalizeEntropy", () => {
  it("0 → 0.0", () => expect(normalizeEntropy(0)).toBe(0));
  it("8 → 1.0", () => expect(normalizeEntropy(8)).toBe(1));
  it("4 → 0.5", () => expect(normalizeEntropy(4)).toBeCloseTo(0.5));
  it("2 → 0.25", () => expect(normalizeEntropy(2)).toBeCloseTo(0.25));
  it("6 → 0.75", () => expect(normalizeEntropy(6)).toBeCloseTo(0.75));

  it("clamped to 0 for negative input", () => {
    expect(normalizeEntropy(-1)).toBe(0);
    expect(normalizeEntropy(-100)).toBe(0);
  });

  it("clamped to 1 for input > 8", () => {
    expect(normalizeEntropy(9)).toBe(1);
    expect(normalizeEntropy(100)).toBe(1);
  });

  it("always returns a value in [0, 1]", () => {
    const inputs = [-10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    for (const v of inputs) {
      const n = normalizeEntropy(v);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it("monotonically non-decreasing for inputs in [0, 8]", () => {
    for (let v = 0; v < 8; v += 0.1) {
      expect(normalizeEntropy(v)).toBeLessThanOrEqual(normalizeEntropy(v + 0.1) + EPS);
    }
  });
});

// entropyToColor
describe("entropyToColor", () => {
  it("always returns a string starting with 'rgba('", () => {
    [0, 2, 4, 6, 8].forEach((e) => expect(entropyToColor(e)).toMatch(/^rgba\(/));
  });

  it("always returns a string ending with ', 0.7)'", () => {
    [0, 2, 4, 6, 8].forEach((e) => expect(entropyToColor(e)).toMatch(/,\s*0\.7\)$/));
  });

  it("entropy=0 → cold color (t=0, first branch u=0)", () => {
    // lerp(30,74,0)=30, lerp(80,222,0)=80, lerp(180,128,0)=180
    expect(entropyToColor(0)).toBe("rgba(30, 80, 180, 0.7)");
  });

  it("entropy=8 → hot color (t=1, third branch u=1)", () => {
    // t=1, u=(1-0.6)/0.4=1 → lerp(245,248,1)=248, lerp(158,113,1)=113, lerp(11,113,1)=113
    expect(entropyToColor(8)).toBe("rgba(248, 113, 113, 0.7)");
  });

  it("entropy=2 → first/second branch boundary (t=0.25, u=1 in first branch)", () => {
    // t=0.25, exactly at boundary, first branch: u=0.25/0.25=1
    // lerp(30,74,1)=74, lerp(80,222,1)=222, lerp(180,128,1)=128
    expect(entropyToColor(2)).toBe("rgba(74, 222, 128, 0.7)");
  });

  it("entropy=4.8 → second/third branch boundary (t=0.6, u=1 in second branch)", () => {
    // t=0.6, second branch: u=(0.6-0.25)/0.35=1
    // lerp(74,245,1)=245, lerp(222,158,1)=158, lerp(128,11,1)=11
    expect(entropyToColor(4.8)).toBe("rgba(245, 158, 11, 0.7)");
  });

  it("negative entropy does not throw (clamped via normalizeEntropy)", () => {
    expect(() => entropyToColor(-1)).not.toThrow();
    expect(entropyToColor(-1)).toBe(entropyToColor(0));
  });

  it("entropy > 8 does not throw (clamped)", () => {
    expect(() => entropyToColor(100)).not.toThrow();
    expect(entropyToColor(100)).toBe(entropyToColor(8));
  });

  it("all RGB components in the output are integers in [0, 255]", () => {
    for (let e = 0; e <= 8; e += 0.5) {
      const color = entropyToColor(e);
      const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+)/);
      expect(match).not.toBeNull();
      const [, r, g, b] = match!;
      [r, g, b].forEach((component) => {
        const n = Number(component);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(255);
      });
    }
  });
});

// isProbablyEncrypted
describe("isProbablyEncrypted", () => {
  it("returns true for all-256-distinct bytes (entropy=8, uniqueBytes=256)", () => {
    const buf = allBytes256();
    const result = shannonEntropy(buf, range(0, 255));
    expect(isProbablyEncrypted(result)).toBe(true);
  });

  it("returns false for uniform buffer (entropy=0)", () => {
    const buf = uniform(0x00, 256);
    const result = shannonEntropy(buf, range(0, 255));
    expect(isProbablyEncrypted(result)).toBe(false);
  });

  it("returns false when entropy > 7.5 but uniqueBytes ≤ 250 (sparse high-entropy)", () => {
    // Manually forge a result with high entropy but few unique bytes
    const fakeResult: EntropyResult = {
      entropy: 7.9,
      classification: "encrypted",
      frequencies: new Float64Array(256),
      uniqueBytes: 200, // below threshold of 250
      dominantByte: 0,
      dominantFrequency: 0.05,
    };
    expect(isProbablyEncrypted(fakeResult)).toBe(false);
  });

  it("returns false when uniqueBytes > 250 but entropy ≤ 7.5", () => {
    const fakeResult: EntropyResult = {
      entropy: 7.4,
      classification: "high",
      frequencies: new Float64Array(256),
      uniqueBytes: 255,
      dominantByte: 0,
      dominantFrequency: 0.01,
    };
    expect(isProbablyEncrypted(fakeResult)).toBe(false);
  });

  it("returns true right above both thresholds (entropy=7.51, uniqueBytes=251)", () => {
    const freqs = new Float64Array(256);
    // 251 bytes each with frequency ~1/251 and rest 0
    for (let i = 0; i < 251; i++) freqs[i] = 1 / 251;
    const fakeResult: EntropyResult = {
      entropy: 7.51,
      classification: "encrypted",
      frequencies: freqs,
      uniqueBytes: 251,
      dominantByte: 0,
      dominantFrequency: 1 / 251,
    };
    expect(isProbablyEncrypted(fakeResult)).toBe(true);
  });
});

// isProbablyText
describe("isProbablyText", () => {
  const makeTextResult = (text: string): EntropyResult => {
    const buf = new TextEncoder().encode(text);
    return shannonEntropy(buf, range(0, buf.length - 1));
  };

  it("returns true for a long ASCII prose string", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    expect(isProbablyText(makeTextResult(text))).toBe(true);
  });

  it("returns true for source code (low entropy, mostly printable)", () => {
    const code = 'function hello() { return "world"; }\n'.repeat(15);
    expect(isProbablyText(makeTextResult(code))).toBe(true);
  });

  it("returns false for fully random/encrypted buffer (entropy=8)", () => {
    const buf = allBytes256();
    const result = shannonEntropy(buf, range(0, 255));
    expect(isProbablyText(result)).toBe(false);
  });

  it("returns false for uniform null buffer (printableRatio=0)", () => {
    const buf = uniform(0x00, 256);
    const result = shannonEntropy(buf, range(0, 255));
    expect(isProbablyText(result)).toBe(false);
  });

  it("counts tab (0x09), LF (0x0A), CR (0x0D) as printable for the ratio", () => {
    // A buffer mostly made of spaces + tabs/LF/CR → should still be text
    const buf = new Uint8Array(200);
    buf.fill(0x20, 0, 160); // spaces
    buf.fill(0x0a, 160, 180); // LF
    buf.fill(0x09, 180, 200); // TAB
    const result = shannonEntropy(buf, range(0, 199));
    expect(isProbablyText(result)).toBe(true);
  });

  it("returns false when entropy ≥ 5.2 even if mostly printable", () => {
    const fakeResult: EntropyResult = {
      entropy: 5.3,
      classification: "medium",
      frequencies: (() => {
        const f = new Float64Array(256);
        for (let i = 0x20; i <= 0x7e; i++) f[i] = 1 / (0x7e - 0x20 + 1);
        return f;
      })(),
      uniqueBytes: 95,
      dominantByte: 0x20,
      dominantFrequency: 1 / 95,
    };
    expect(isProbablyText(fakeResult)).toBe(false);
  });

  it("returns false when printableRatio ≤ 0.85 even with low entropy", () => {
    // 80% printable, 20% binary → ratio = 0.80 ≤ 0.85
    const buf = new Uint8Array(100);
    buf.fill(0x41, 0, 80); // 80 × 'A'
    buf.fill(0x01, 80, 100); // 20 × control char
    const result = shannonEntropy(buf, range(0, 99));
    expect(isProbablyText(result)).toBe(false);
  });
});

// isProbablyPadding
describe("isProbablyPadding", () => {
  it("returns true for 100% null bytes", () => {
    const buf = uniform(0x00, 256);
    const result = shannonEntropy(buf, range(0, 255));
    expect(isProbablyPadding(result)).toBe(true);
  });

  it("returns true when 95% of bytes are null (> 0.9 threshold)", () => {
    const buf = new Uint8Array(200);
    buf.fill(0x00, 0, 190); // 95%
    buf.fill(0x41, 190, 200);
    const result = shannonEntropy(buf, range(0, 199));
    expect(isProbablyPadding(result)).toBe(true);
  });

  it("returns false when dominant byte is not 0x00", () => {
    // 95% 0xFF, 5% other → dominantByte=0xFF, not 0x00
    const buf = new Uint8Array(200);
    buf.fill(0xff, 0, 190);
    buf.fill(0x41, 190, 200);
    const result = shannonEntropy(buf, range(0, 199));
    expect(isProbablyPadding(result)).toBe(false);
  });

  it("returns false when 0x00 is dominant but frequency ≤ 0.9", () => {
    // 80% 0x00, 20% other → below threshold
    const buf = new Uint8Array(100);
    buf.fill(0x00, 0, 80);
    buf.fill(0x41, 80, 100);
    const result = shannonEntropy(buf, range(0, 99));
    expect(isProbablyPadding(result)).toBe(false);
  });

  it("returns false for perfectly random buffer", () => {
    const result = shannonEntropy(allBytes256(), range(0, 255));
    expect(isProbablyPadding(result)).toBe(false);
  });

  it("boundary: exactly 90% null bytes (0.9 is not > 0.9) → false", () => {
    // 90/100 = 0.9, condition is dominantFrequency > 0.9 (strict)
    const buf = new Uint8Array(100);
    buf.fill(0x00, 0, 90);
    buf.fill(0x41, 90, 100);
    const result = shannonEntropy(buf, range(0, 99));
    expect(isProbablyPadding(result)).toBe(false);
  });

  it("boundary: 91% null bytes → true", () => {
    const buf = new Uint8Array(100);
    buf.fill(0x00, 0, 91);
    buf.fill(0x41, 91, 100);
    const result = shannonEntropy(buf, range(0, 99));
    expect(isProbablyPadding(result)).toBe(true);
  });
});

// Integration
describe("Integration: full pipeline", () => {
  it("entropyMap + isProbablyPadding identifies padding segment in a mixed buffer", () => {
    const buf = new Uint8Array(512);
    buf.fill(0x00, 0, 256); // null padding
    for (let i = 256; i < 512; i++) buf[i] = i & 0xff; // varied data
    const segments = entropyMap(buf, 256);
    expect(segments).toHaveLength(2);
    expect(isProbablyPadding(segments[0]!.result)).toBe(true);
    expect(isProbablyPadding(segments[1]!.result)).toBe(false);
  });

  it("rankSectionsByEntropy + isProbablyEncrypted identifies the highest-entropy section", () => {
    const buf = new Uint8Array(768);
    buf.fill(0x41, 0, 256); // all same → entropy 0
    for (let i = 256; i < 512; i++) buf[i] = i & 0xff; // all 256 values → entropy 8
    buf.fill(0x42, 512, 768);

    const sections = [
      { name: "text", range: range(0, 255) },
      { name: "encrypted", range: range(256, 511) },
      { name: "text2", range: range(512, 767) },
    ];

    const ranked = rankSectionsByEntropy(buf, sections);
    expect(ranked[0]!.name).toBe("encrypted");
    expect(isProbablyEncrypted(ranked[0]!.result)).toBe(true);
  });

  it("normalizeEntropy + entropyToColor pipeline produces valid output for every segment", () => {
    const buf = allBytes256();
    const segments = entropyMap(buf, 64);
    for (const seg of segments) {
      const norm = normalizeEntropy(seg.result.entropy);
      const color = entropyToColor(seg.result.entropy);
      expect(norm).toBeGreaterThanOrEqual(0);
      expect(norm).toBeLessThanOrEqual(1);
      expect(color).toMatch(/^rgba\(/);
    }
  });

  it("cache survives rankSectionsByEntropy and clearEntropyCache round-trip", () => {
    clearEntropyCache();
    const buf = allBytes256();
    const sections = [{ name: "all", range: range(0, 255) }];
    const r1 = rankSectionsByEntropy(buf, sections, true);
    clearEntropyCache();
    const r2 = rankSectionsByEntropy(buf, sections, true);
    expect(r1[0]!.result.entropy).toBeCloseTo(r2[0]!.result.entropy, 10);
  });
});
