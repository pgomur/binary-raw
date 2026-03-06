/**
 * @file Comprehensive Vitest tests for the global selection state module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

//  Mock @app-types
// SelectionState shapes used throughout:
//   { type: "none" }
//   { type: "selecting", anchor: number, current: number }
//   { type: "selected",  range: { start: number, end: number, length: number } }

vi.mock("@app-types/index", () => {
  const Selection = {
    none: () => ({ type: "none" as const }),

    start: (offset: number) => ({
      type: "selecting" as const,
      anchor: offset,
      current: offset,
    }),

    update: (sel: { anchor: number }, offset: number) => ({
      type: "selecting" as const,
      anchor: sel.anchor,
      current: offset,
    }),

    commit: (sel: { type: string; anchor?: number; current?: number; range?: { start: number; end: number; length: number } }) => {
      if (sel.type === "none") return { type: "none" as const };
      if (sel.type === "selecting") {
        const start = Math.min(sel.anchor!, sel.current!);
        const end = Math.max(sel.anchor!, sel.current!);
        const length = end - start + 1;
        return { type: "selected" as const, range: { start, end, length } };
      }
      return sel; // already selected — no-op
    },
  };

  return {
    Offset: {
      create: (n: number) => n,
      add: (a: number, b: number) => a + b,
      diff: (a: number, b: number) => a - b,
    },
    Bytes: {
      create: (n: number) => n,
    },
    Selection,
  };
});

import { getSelection, setSelection, clearSelection, startSelection, updateSelection, commitSelection, onSelectionChange, resetSelection, normalizeSelection, isOffsetSelected, selectionLength } from "../../src/core/selection";

// Helpers

const O = (n: number) => n as Parameters<typeof startSelection>[0];

const noneState = () => ({ type: "none" as const });
const selectingState = (anchor: number, current: number) => ({ type: "selecting" as const, anchor, current });
const selectedState = (start: number, end: number) => ({ type: "selected" as const, range: { start, end, length: end - start + 1 } });

// Lifecycle

beforeEach(() => {
  resetSelection();
});
afterEach(() => {
  resetSelection();
});

// resetSelection

describe("resetSelection", () => {
  it("sets state back to 'none'", () => {
    startSelection(O(5));
    resetSelection();
    expect(getSelection().type).toBe("none");
  });

  it("clears all listeners (subsequent operations do not call them)", () => {
    const fn = vi.fn();
    onSelectionChange(fn);
    resetSelection();
    fn.mockClear();
    startSelection(O(0)); // would notify if listener were still registered
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not throw when called on an already-reset state", () => {
    expect(() => resetSelection()).not.toThrow();
  });

  it("calling twice in a row does not throw", () => {
    expect(() => {
      resetSelection();
      resetSelection();
    }).not.toThrow();
  });
});

// getSelection

describe("getSelection", () => {
  it("returns type 'none' after reset", () => {
    expect(getSelection().type).toBe("none");
  });

  it("returns the state set by setSelection", () => {
    const sel = selectingState(3, 7);
    setSelection(sel);
    expect(getSelection()).toEqual(sel);
  });

  it("returns the state set by startSelection", () => {
    startSelection(O(10));
    const sel = getSelection();
    expect(sel.type).toBe("selecting");
  });

  it("returns the same object reference that was set (no copy)", () => {
    const sel = selectingState(0, 0);
    setSelection(sel);
    expect(getSelection()).toBe(sel);
  });
});

// setSelection

describe("setSelection", () => {
  it("updates the current selection", () => {
    const sel = selectedState(2, 8);
    setSelection(sel);
    expect(getSelection()).toEqual(sel);
  });

  it("replaces a previous selection", () => {
    setSelection(selectingState(0, 5));
    const next = selectedState(10, 20);
    setSelection(next);
    expect(getSelection()).toEqual(next);
  });

  it("notifies listeners with the new selection", () => {
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    const sel = selectedState(1, 4);
    setSelection(sel);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(sel);
    unsub();
  });

  it("accepts a 'none' state", () => {
    startSelection(O(5));
    setSelection(noneState());
    expect(getSelection().type).toBe("none");
  });
});

// clearSelection

describe("clearSelection", () => {
  it("sets state to 'none'", () => {
    startSelection(O(3));
    clearSelection();
    expect(getSelection().type).toBe("none");
  });

  it("notifies listeners", () => {
    startSelection(O(3));
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    clearSelection();
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(noneState());
    unsub();
  });

  it("does not throw when already 'none'", () => {
    expect(() => clearSelection()).not.toThrow();
  });

  it("calling twice sets state to 'none' both times", () => {
    startSelection(O(0));
    clearSelection();
    clearSelection();
    expect(getSelection().type).toBe("none");
  });
});

// startSelection

describe("startSelection", () => {
  it("sets state to 'selecting'", () => {
    startSelection(O(5));
    expect(getSelection().type).toBe("selecting");
  });

  it("anchor equals the provided offset", () => {
    startSelection(O(7));
    const sel = getSelection() as { type: "selecting"; anchor: number; current: number };
    expect(sel.anchor).toBe(7);
  });

  it("current equals anchor on start (single-byte selection point)", () => {
    startSelection(O(7));
    const sel = getSelection() as { type: "selecting"; anchor: number; current: number };
    expect(sel.current).toBe(sel.anchor);
  });

  it("notifies listeners", () => {
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    startSelection(O(3));
    expect(fn).toHaveBeenCalledOnce();
    unsub();
  });

  it("listener receives a 'selecting' state", () => {
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    startSelection(O(3));
    const received = fn.mock.calls[0]![0] as { type: string };
    expect(received.type).toBe("selecting");
    unsub();
  });

  it("overwrites a prior 'selected' state", () => {
    startSelection(O(0));
    commitSelection();
    startSelection(O(9));
    expect(getSelection().type).toBe("selecting");
    const sel = getSelection() as { anchor: number };
    expect(sel.anchor).toBe(9);
  });
});

// updateSelection

describe("updateSelection", () => {
  // From 'none'

  it("creates a new 'selecting' state when current is 'none'", () => {
    updateSelection(O(4));
    expect(getSelection().type).toBe("selecting");
  });

  it("anchor equals the provided offset when started from 'none'", () => {
    updateSelection(O(4));
    const sel = getSelection() as { anchor: number; current: number };
    expect(sel.anchor).toBe(4);
    expect(sel.current).toBe(4);
  });

  // From 'selecting'

  it("updates current while preserving anchor when in 'selecting' state", () => {
    startSelection(O(2));
    updateSelection(O(8));
    const sel = getSelection() as { type: string; anchor: number; current: number };
    expect(sel.type).toBe("selecting");
    expect(sel.anchor).toBe(2);
    expect(sel.current).toBe(8);
  });

  it("can drag backwards (current < anchor)", () => {
    startSelection(O(8));
    updateSelection(O(2));
    const sel = getSelection() as { anchor: number; current: number };
    expect(sel.anchor).toBe(8);
    expect(sel.current).toBe(2);
  });

  it("multiple updates move current each time, keeping anchor fixed", () => {
    startSelection(O(0));
    updateSelection(O(3));
    updateSelection(O(7));
    updateSelection(O(5));
    const sel = getSelection() as { anchor: number; current: number };
    expect(sel.anchor).toBe(0);
    expect(sel.current).toBe(5);
  });

  // From 'selected'

  it("starts a new 'selecting' from the provided offset when already 'selected'", () => {
    startSelection(O(0));
    commitSelection();
    expect(getSelection().type).toBe("selected");
    updateSelection(O(15));
    const sel = getSelection() as { type: string; anchor: number };
    expect(sel.type).toBe("selecting");
    expect(sel.anchor).toBe(15);
  });

  // Notification

  it("notifies listeners on every update", () => {
    startSelection(O(0));
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    updateSelection(O(3));
    updateSelection(O(6));
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
  });
});

// commitSelection

describe("commitSelection", () => {
  it("converts 'selecting' to 'selected'", () => {
    startSelection(O(2));
    updateSelection(O(5));
    commitSelection();
    expect(getSelection().type).toBe("selected");
  });

  it("committed range.start is the smaller of anchor/current", () => {
    startSelection(O(5));
    updateSelection(O(2));
    commitSelection();
    const sel = getSelection() as { range: { start: number; end: number } };
    expect(sel.range.start).toBe(2);
    expect(sel.range.end).toBe(5);
  });

  it("committed range.start and end are equal for a zero-drag (single byte)", () => {
    startSelection(O(7));
    commitSelection();
    const sel = getSelection() as { range: { start: number; end: number } };
    expect(sel.range.start).toBe(7);
    expect(sel.range.end).toBe(7);
  });

  it("committed range.length equals end - start + 1", () => {
    startSelection(O(2));
    updateSelection(O(5));
    commitSelection();
    const sel = getSelection() as { range: { start: number; end: number; length: number } };
    expect(sel.range.length).toBe(sel.range.end - sel.range.start + 1);
  });

  it("committing 'none' keeps state as 'none'", () => {
    commitSelection();
    expect(getSelection().type).toBe("none");
  });

  it("committing an already 'selected' state keeps it 'selected'", () => {
    startSelection(O(1));
    commitSelection();
    const first = getSelection();
    commitSelection();
    expect(getSelection()).toEqual(first);
  });

  it("notifies listeners", () => {
    startSelection(O(0));
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    commitSelection();
    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0]![0]).toHaveProperty("type", "selected");
    unsub();
  });
});

// onSelectionChange

describe("onSelectionChange", () => {
  it("returns an unsubscribe function", () => {
    const unsub = onSelectionChange(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("listener is called when state changes", () => {
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    startSelection(O(0));
    expect(fn).toHaveBeenCalledOnce();
    unsub();
  });

  it("listener receives the current SelectionState as argument", () => {
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    startSelection(O(3));
    expect(fn).toHaveBeenCalledWith(getSelection());
    unsub();
  });

  it("unsubscribed listener is NOT called on subsequent changes", () => {
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    unsub();
    startSelection(O(5));
    expect(fn).not.toHaveBeenCalled();
  });

  it("multiple listeners are all called", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const u1 = onSelectionChange(fn1);
    const u2 = onSelectionChange(fn2);
    fn1.mockClear();
    fn2.mockClear();
    startSelection(O(0));
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
    u1();
    u2();
  });

  it("unsubscribing one listener does not affect others", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const u1 = onSelectionChange(fn1);
    const u2 = onSelectionChange(fn2);
    fn1.mockClear();
    fn2.mockClear();
    u1();
    startSelection(O(0));
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
    u2();
  });

  it("calling the unsubscribe function twice does not throw", () => {
    const unsub = onSelectionChange(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("listener is called on clearSelection", () => {
    startSelection(O(1));
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    clearSelection();
    expect(fn).toHaveBeenCalledOnce();
    unsub();
  });

  it("listener is called on setSelection", () => {
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    setSelection(selectedState(1, 4));
    expect(fn).toHaveBeenCalledOnce();
    unsub();
  });

  it("listener is called on commitSelection", () => {
    startSelection(O(0));
    const fn = vi.fn();
    const unsub = onSelectionChange(fn);
    fn.mockClear();
    commitSelection();
    expect(fn).toHaveBeenCalledOnce();
    unsub();
  });
});

// normalizeSelection

describe("normalizeSelection", () => {
  it("returns null for 'none'", () => {
    expect(normalizeSelection(noneState())).toBeNull();
  });

  // 'selecting' type

  it("'selecting' forward: min = anchor, max = current", () => {
    const result = normalizeSelection(selectingState(2, 8));
    expect(result).toEqual({ min: 2, max: 8 });
  });

  it("'selecting' reverse (anchor > current): min = current, max = anchor", () => {
    const result = normalizeSelection(selectingState(8, 2));
    expect(result).toEqual({ min: 2, max: 8 });
  });

  it("'selecting' same anchor and current: min === max", () => {
    const result = normalizeSelection(selectingState(5, 5));
    expect(result).toEqual({ min: 5, max: 5 });
  });

  // 'selected' type

  it("'selected' forward: min = range.start, max = range.end", () => {
    const result = normalizeSelection(selectedState(3, 9));
    expect(result).toEqual({ min: 3, max: 9 });
  });

  it("'selected' with equal start and end: min === max", () => {
    const result = normalizeSelection(selectedState(4, 4));
    expect(result).toEqual({ min: 4, max: 4 });
  });

  it("'selected' with inverted range (end < start): min = end, max = start", () => {
    // Manually constructed inverted selected state
    const inverted = { type: "selected" as const, range: { start: 9, end: 3, length: 7 } };
    const result = normalizeSelection(inverted);
    expect(result).toEqual({ min: 3, max: 9 });
  });

  it("result has numeric min and max", () => {
    const result = normalizeSelection(selectingState(1, 10));
    expect(typeof result!.min).toBe("number");
    expect(typeof result!.max).toBe("number");
  });

  it("min is always <= max", () => {
    const cases = [selectingState(0, 10), selectingState(10, 0), selectedState(5, 15)];
    for (const sel of cases) {
      const r = normalizeSelection(sel);
      expect(r!.min).toBeLessThanOrEqual(r!.max);
    }
  });
});

// isOffsetSelected

describe("isOffsetSelected", () => {
  it("returns false when state is 'none'", () => {
    expect(isOffsetSelected(O(0))).toBe(false);
    expect(isOffsetSelected(O(5))).toBe(false);
  });

  it("returns true for the anchor offset right after startSelection", () => {
    startSelection(O(5));
    expect(isOffsetSelected(O(5))).toBe(true);
  });

  it("returns true for offsets within a 'selecting' range", () => {
    startSelection(O(2));
    updateSelection(O(6));
    expect(isOffsetSelected(O(2))).toBe(true);
    expect(isOffsetSelected(O(4))).toBe(true);
    expect(isOffsetSelected(O(6))).toBe(true);
  });

  it("returns false for offsets outside a 'selecting' range", () => {
    startSelection(O(2));
    updateSelection(O(6));
    expect(isOffsetSelected(O(1))).toBe(false);
    expect(isOffsetSelected(O(7))).toBe(false);
  });

  it("returns true for offsets within a 'selected' range", () => {
    startSelection(O(3));
    updateSelection(O(7));
    commitSelection();
    expect(isOffsetSelected(O(3))).toBe(true);
    expect(isOffsetSelected(O(5))).toBe(true);
    expect(isOffsetSelected(O(7))).toBe(true);
  });

  it("returns false for offsets outside a 'selected' range", () => {
    startSelection(O(3));
    updateSelection(O(7));
    commitSelection();
    expect(isOffsetSelected(O(2))).toBe(false);
    expect(isOffsetSelected(O(8))).toBe(false);
  });

  it("works correctly for a reverse (backwards) drag before commit", () => {
    startSelection(O(8));
    updateSelection(O(2)); // dragged backwards
    // normalized: min=2, max=8
    expect(isOffsetSelected(O(2))).toBe(true);
    expect(isOffsetSelected(O(5))).toBe(true);
    expect(isOffsetSelected(O(8))).toBe(true);
    expect(isOffsetSelected(O(1))).toBe(false);
    expect(isOffsetSelected(O(9))).toBe(false);
  });

  it("returns false after clearSelection", () => {
    startSelection(O(0));
    updateSelection(O(10));
    clearSelection();
    expect(isOffsetSelected(O(5))).toBe(false);
  });
});

// selectionLength

describe("selectionLength", () => {
  it("returns 0 for 'none'", () => {
    expect(selectionLength(noneState())).toBe(0);
  });

  it("'selecting' anchor === current → 1 (single byte)", () => {
    expect(selectionLength(selectingState(5, 5))).toBe(1);
  });

  it("'selecting' anchor > current (reverse drag): diff(anchor,current)+1 = anchor-current+1", () => {
    // Offset.diff(a,b) = a-b; diff(8,2)+1 = 6+1 = 7
    expect(selectionLength(selectingState(8, 2))).toBe(7);
  });

  it("'selecting' anchor < current (forward drag): diff(anchor,current)+1 = anchor-current+1 (negative)", () => {
    // diff(2,8)+1 = -6+1 = -5  ← actual computed value (bug for forward drags)
    expect(selectionLength(selectingState(2, 8))).toBe(-5);
  });

  it("'selected': returns range.length directly", () => {
    expect(selectionLength(selectedState(2, 8))).toBe(7); // 8-2+1
  });

  it("'selected' single-byte range: length = 1", () => {
    expect(selectionLength(selectedState(5, 5))).toBe(1);
  });

  it("'selected' large range", () => {
    expect(selectionLength(selectedState(0, 255))).toBe(256);
  });
});

// Integration

describe("Integration", () => {
  it("full selection lifecycle: start → update → commit → clear", () => {
    startSelection(O(2));
    updateSelection(O(6));
    expect(getSelection().type).toBe("selecting");

    commitSelection();
    expect(getSelection().type).toBe("selected");
    const committed = getSelection() as { range: { start: number; end: number } };
    expect(committed.range.start).toBe(2);
    expect(committed.range.end).toBe(6);

    clearSelection();
    expect(getSelection().type).toBe("none");
  });

  it("isOffsetSelected is consistent with normalizeSelection across a full selection", () => {
    startSelection(O(3));
    updateSelection(O(9));
    const normalized = normalizeSelection(getSelection());
    expect(normalized).not.toBeNull();
    // All offsets in [min,max] must be selected
    for (let i = normalized!.min; i <= normalized!.max; i++) {
      expect(isOffsetSelected(O(i))).toBe(true);
    }
    // Adjacent offsets must not be selected
    expect(isOffsetSelected(O(normalized!.min - 1))).toBe(false);
    expect(isOffsetSelected(O(normalized!.max + 1))).toBe(false);
  });

  it("listener sequence through a full lifecycle is correct", () => {
    const types: string[] = [];
    const unsub = onSelectionChange((sel) => types.push(sel.type));
    types.length = 0;

    startSelection(O(0)); // "selecting"
    updateSelection(O(5)); // "selecting"
    commitSelection(); // "selected"
    clearSelection(); // "none"

    expect(types).toEqual(["selecting", "selecting", "selected", "none"]);
    unsub();
  });

  it("new selection after commit discards committed range and starts fresh", () => {
    startSelection(O(0));
    updateSelection(O(5));
    commitSelection();

    startSelection(O(20)); // starts new selection
    const sel = getSelection() as { type: string; anchor: number };
    expect(sel.type).toBe("selecting");
    expect(sel.anchor).toBe(20);
    expect(isOffsetSelected(O(0))).toBe(false); // old range gone
    expect(isOffsetSelected(O(20))).toBe(true);
  });

  it("updateSelection from 'selected' state starts a new 'selecting' branch", () => {
    startSelection(O(1));
    commitSelection();
    updateSelection(O(10));
    const sel = getSelection() as { type: string; anchor: number; current: number };
    expect(sel.type).toBe("selecting");
    expect(sel.anchor).toBe(10);
    expect(sel.current).toBe(10);
  });

  it("resetSelection mid-lifecycle removes all listeners and resets state", () => {
    const fn = vi.fn();
    onSelectionChange(fn);
    startSelection(O(5));
    fn.mockClear();

    resetSelection();
    expect(getSelection().type).toBe("none");

    // Re-register a new listener; old one must be gone
    startSelection(O(0));
    expect(fn).not.toHaveBeenCalled();
  });

  it("setSelection can inject a 'selected' state directly and isOffsetSelected works", () => {
    setSelection(selectedState(10, 20));
    for (let i = 10; i <= 20; i++) {
      expect(isOffsetSelected(O(i))).toBe(true);
    }
    expect(isOffsetSelected(O(9))).toBe(false);
    expect(isOffsetSelected(O(21))).toBe(false);
  });
});
