/**
 * @file Comprehensive Vitest tests for the byte editor (command pattern / undo-redo).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @app-types

vi.mock("@app-types/index", () => ({
  Offset: {
    create: (n: number) => n,
    add: (a: number, b: number) => a + b,
    diff: (a: number, b: number) => a - b,
  },
  Bytes: {
    create: (n: number) => n,
  },
}));

import { initEditor, destroyEditor, getBuffer, getModified, modifiedCount, canUndo, canRedo, getOriginalByte, isByteModified, editByte, editRange, undo, redo, exportBuffer, onEditorChange, type ChangeListener } from "../../src/core/editor";

// Helpers

/** Branded offset/byte-count (plain number after mock). */
const O = (n: number) => n as Parameters<typeof editByte>[0];

/** Build an ArrayBuffer from explicit byte values. */
const ab = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

/** Init the editor with a fresh copy of the given bytes. */
const init = (...bytes: number[]) => initEditor(ab(...bytes));

// Lifecycle

beforeEach(() => {
  init(0x00, 0x01, 0x02, 0x03);
}); // 4-byte default
afterEach(() => {
  destroyEditor();
});

// initEditor

describe("initEditor", () => {
  it("getBuffer reflects the initial byte values", () => {
    init(0xaa, 0xbb, 0xcc);
    expect(Array.from(getBuffer())).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("buffer is an independent copy (mutating source ArrayBuffer after init has no effect)", () => {
    const source = new Uint8Array([0x01, 0x02, 0x03]).buffer;
    initEditor(source);
    new Uint8Array(source)[0] = 0xff; // mutate source
    expect(getBuffer()[0]).toBe(0x01); // buffer unchanged
  });

  it("originalSnapshot is independent from the working buffer", () => {
    init(0x10, 0x20);
    editByte(O(0), 0xff);
    // Original must still hold the initial value
    expect(getOriginalByte(O(0))).toBe(0x10);
  });

  it("clears undoStack: canUndo() is false", () => {
    editByte(O(0), 0xff); // push something
    init(0x00); // re-init should clear
    expect(canUndo()).toBe(false);
  });

  it("clears redoStack: canRedo() is false", () => {
    editByte(O(0), 0xff);
    undo(); // creates a redo entry
    init(0x00);
    expect(canRedo()).toBe(false);
  });

  it("clears modifiedCache: modifiedCount() is 0", () => {
    editByte(O(0), 0xff);
    init(0x00, 0x01, 0x02, 0x03);
    expect(modifiedCount()).toBe(0);
  });

  it("notifies listeners on init", () => {
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear(); // discard the call from `onEditorChange` registration (none expected here)
    init(0xaa);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(0); // 0 modified bytes
    unsub();
  });

  it("handles an empty ArrayBuffer without throwing", () => {
    expect(() => initEditor(new ArrayBuffer(0))).not.toThrow();
    expect(getBuffer().byteLength).toBe(0);
  });
});

// destroyEditor

describe("destroyEditor", () => {
  it("resets buffer to 0 bytes", () => {
    destroyEditor();
    expect(getBuffer().byteLength).toBe(0);
  });

  it("canUndo() is false after destroy", () => {
    editByte(O(0), 0xff);
    destroyEditor();
    expect(canUndo()).toBe(false);
  });

  it("canRedo() is false after destroy", () => {
    editByte(O(0), 0xff);
    undo();
    destroyEditor();
    expect(canRedo()).toBe(false);
  });

  it("modifiedCount() is 0 after destroy", () => {
    editByte(O(0), 0xff);
    destroyEditor();
    expect(modifiedCount()).toBe(0);
  });

  it("clears listeners: subsequent operations do not call destroyed listeners", () => {
    const fn = vi.fn();
    onEditorChange(fn);
    destroyEditor();
    fn.mockClear();
    initEditor(new ArrayBuffer(4));
    // listeners were cleared; fn should not be called
    expect(fn).not.toHaveBeenCalled();
  });

  it("calling destroyEditor twice does not throw", () => {
    destroyEditor();
    expect(() => destroyEditor()).not.toThrow();
  });
});

// getBuffer

describe("getBuffer", () => {
  it("returns a Uint8Array", () => {
    expect(getBuffer()).toBeInstanceOf(Uint8Array);
  });

  it("length matches the init buffer", () => {
    init(0x01, 0x02, 0x03);
    expect(getBuffer().length).toBe(3);
  });

  it("reflects edits immediately", () => {
    editByte(O(0), 0xff);
    expect(getBuffer()[0]).toBe(0xff);
  });

  it("is 0 bytes after destroyEditor", () => {
    destroyEditor();
    expect(getBuffer().length).toBe(0);
  });
});

// getModified

describe("getModified", () => {
  it("returns a Map", () => {
    expect(getModified()).toBeInstanceOf(Map);
  });

  it("is empty after init with no edits", () => {
    expect(getModified().size).toBe(0);
  });

  it("contains the modified offset after editByte", () => {
    editByte(O(2), 0xff);
    expect(getModified().has(O(2))).toBe(true);
  });

  it("maps offset → current value (not original)", () => {
    editByte(O(1), 0xab);
    expect(getModified().get(O(1))).toBe(0xab);
  });

  it("is empty again after undo restores all bytes", () => {
    editByte(O(0), 0xff);
    undo();
    expect(getModified().size).toBe(0);
  });

  it("updates value after a second edit on the same offset", () => {
    editByte(O(0), 0x11);
    editByte(O(0), 0x22);
    expect(getModified().get(O(0))).toBe(0x22);
  });

  it("removes entry when byte is edited back to original value", () => {
    const original = getBuffer()[0]!;
    editByte(O(0), 0xff);
    editByte(O(0), original); // restore
    expect(getModified().has(O(0))).toBe(false);
  });
});

// modifiedCount

describe("modifiedCount", () => {
  it("is 0 after init", () => {
    expect(modifiedCount()).toBe(0);
  });

  it("increments after each editByte on a different offset", () => {
    editByte(O(0), 0xff);
    editByte(O(1), 0xee);
    expect(modifiedCount()).toBe(2);
  });

  it("does not double-count repeated edits on the same offset", () => {
    editByte(O(0), 0x11);
    editByte(O(0), 0x22);
    expect(modifiedCount()).toBe(1);
  });

  it("decrements to 0 after undo of a single edit", () => {
    editByte(O(0), 0xff);
    undo();
    expect(modifiedCount()).toBe(0);
  });

  it("is 0 after destroyEditor", () => {
    editByte(O(0), 0xff);
    destroyEditor();
    expect(modifiedCount()).toBe(0);
  });
});

// canUndo / canRedo

describe("canUndo", () => {
  it("is false after init", () => {
    expect(canUndo()).toBe(false);
  });

  it("is true after one editByte", () => {
    editByte(O(0), 0xff);
    expect(canUndo()).toBe(true);
  });

  it("is false after undo of the only command", () => {
    editByte(O(0), 0xff);
    undo();
    expect(canUndo()).toBe(false);
  });

  it("remains true when there is more than one command and one is undone", () => {
    editByte(O(0), 0x11);
    editByte(O(1), 0x22);
    undo();
    expect(canUndo()).toBe(true);
  });
});

describe("canRedo", () => {
  it("is false after init", () => {
    expect(canRedo()).toBe(false);
  });

  it("is true after undo", () => {
    editByte(O(0), 0xff);
    undo();
    expect(canRedo()).toBe(true);
  });

  it("is false after redo consumes the last entry", () => {
    editByte(O(0), 0xff);
    undo();
    redo();
    expect(canRedo()).toBe(false);
  });

  it("is false after a new editByte clears the redo stack", () => {
    editByte(O(0), 0xff);
    undo();
    editByte(O(1), 0xaa); // new edit → clears redo
    expect(canRedo()).toBe(false);
  });
});

// getOriginalByte

describe("getOriginalByte", () => {
  it("returns the initial byte value at offset 0", () => {
    init(0xab, 0xcd);
    expect(getOriginalByte(O(0))).toBe(0xab);
  });

  it("returns the initial byte value at each position", () => {
    init(0x01, 0x02, 0x03);
    expect(getOriginalByte(O(0))).toBe(0x01);
    expect(getOriginalByte(O(1))).toBe(0x02);
    expect(getOriginalByte(O(2))).toBe(0x03);
  });

  it("does NOT change after editByte (snapshot is immutable)", () => {
    init(0x10, 0x20);
    editByte(O(0), 0xff);
    expect(getOriginalByte(O(0))).toBe(0x10);
  });

  it("does NOT change after undo", () => {
    init(0x10);
    editByte(O(0), 0xff);
    undo();
    expect(getOriginalByte(O(0))).toBe(0x10);
  });

  it("returns undefined for an offset beyond buffer length", () => {
    expect(getOriginalByte(O(100))).toBeUndefined();
  });

  it("returns undefined for an empty buffer", () => {
    initEditor(new ArrayBuffer(0));
    expect(getOriginalByte(O(0))).toBeUndefined();
  });
});

// isByteModified

describe("isByteModified", () => {
  it("returns false for every byte right after init", () => {
    init(0x01, 0x02, 0x03);
    for (let i = 0; i < 3; i++) {
      expect(isByteModified(O(i))).toBe(false);
    }
  });

  it("returns true for a byte that has been edited", () => {
    editByte(O(1), 0xff);
    expect(isByteModified(O(1))).toBe(true);
  });

  it("returns false for bytes NOT touched by an edit", () => {
    editByte(O(0), 0xff);
    expect(isByteModified(O(1))).toBe(false);
    expect(isByteModified(O(2))).toBe(false);
  });

  it("returns false after undo restores the byte", () => {
    editByte(O(0), 0xff);
    undo();
    expect(isByteModified(O(0))).toBe(false);
  });

  it("returns true after redo re-applies the edit", () => {
    editByte(O(0), 0xff);
    undo();
    redo();
    expect(isByteModified(O(0))).toBe(true);
  });

  it("returns false when byte is edited back to its original value", () => {
    const original = getBuffer()[0]!;
    editByte(O(0), 0xff);
    editByte(O(0), original);
    expect(isByteModified(O(0))).toBe(false);
  });

  it("returns false for an out-of-bounds offset (guard for undefined)", () => {
    expect(isByteModified(O(100))).toBe(false);
  });
});

// editByte

describe("editByte", () => {
  // Happy path

  it("writes the new value into the buffer", () => {
    editByte(O(0), 0xff);
    expect(getBuffer()[0]).toBe(0xff);
  });

  it("does not alter other positions", () => {
    editByte(O(0), 0xff);
    expect(getBuffer()[1]).toBe(0x01);
    expect(getBuffer()[2]).toBe(0x02);
  });

  it("adds an entry to the undo stack", () => {
    editByte(O(0), 0xff);
    expect(canUndo()).toBe(true);
  });

  it("clears the redo stack", () => {
    editByte(O(0), 0x11);
    undo();
    editByte(O(0), 0x22); // new edit → redo must be cleared
    expect(canRedo()).toBe(false);
  });

  it("updates modifiedCache", () => {
    editByte(O(2), 0xab);
    expect(getModified().has(O(2))).toBe(true);
  });

  it("notifies listeners with updated modifiedCount", () => {
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    editByte(O(0), 0xff);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(1);
    unsub();
  });

  // Clamping

  it("clamps values > 255 with 0xFF mask: 256 → 0", () => {
    editByte(O(0), 256);
    expect(getBuffer()[0]).toBe(0);
  });

  it("clamps negative values with 0xFF mask: -1 → 255", () => {
    editByte(O(0), -1);
    expect(getBuffer()[0]).toBe(255);
  });

  it("clamps 257 → 1", () => {
    editByte(O(0), 257);
    expect(getBuffer()[0]).toBe(1);
  });

  // Silent no-ops

  it("does nothing when offset >= buffer.length (silent ignore)", () => {
    const before = Array.from(getBuffer());
    editByte(O(100), 0xff);
    expect(Array.from(getBuffer())).toEqual(before);
    expect(canUndo()).toBe(false);
  });

  it("does nothing when offset < 0 (silent ignore)", () => {
    const before = Array.from(getBuffer());
    editByte(O(-1), 0xff);
    expect(Array.from(getBuffer())).toEqual(before);
    expect(canUndo()).toBe(false);
  });

  it("does nothing when new value equals current value (no command pushed)", () => {
    const current = getBuffer()[0]!;
    editByte(O(0), current);
    expect(canUndo()).toBe(false);
  });

  it("does nothing when clamped value equals current value (e.g., 256 when byte is 0)", () => {
    // init sets buffer[0] = 0x00; 256 & 0xFF = 0 → same → no-op
    editByte(O(0), 256);
    expect(canUndo()).toBe(false);
  });
});

// editRange

describe("editRange", () => {
  // Happy path

  it("writes multiple values starting at startOffset", () => {
    editRange(O(1), [0xaa, 0xbb]);
    expect(getBuffer()[1]).toBe(0xaa);
    expect(getBuffer()[2]).toBe(0xbb);
  });

  it("creates a single undoable command for the whole range", () => {
    editRange(O(0), [0x11, 0x22, 0x33, 0x44]);
    expect(canUndo()).toBe(true);
    undo();
    expect(canUndo()).toBe(false); // only one command was created
  });

  it("undoing a range edit restores all bytes at once", () => {
    const before = Array.from(getBuffer());
    editRange(O(0), [0x11, 0x22, 0x33, 0x44]);
    undo();
    expect(Array.from(getBuffer())).toEqual(before);
  });

  it("clamps each value with 0xFF mask", () => {
    editRange(O(0), [256, -1, 257]);
    expect(getBuffer()[0]).toBe(0); // 256 & 0xFF
    expect(getBuffer()[1]).toBe(255); // -1 & 0xFF
    expect(getBuffer()[2]).toBe(1); // 257 & 0xFF
  });

  it("stops at buffer boundary when range extends beyond end", () => {
    init(0x00, 0x00, 0x00); // 3-byte buffer
    editRange(O(2), [0xaa, 0xbb, 0xcc]); // only index 2 is valid
    expect(getBuffer()[2]).toBe(0xaa);
    expect(getBuffer().length).toBe(3);
  });

  it("updates modifiedCache for all changed bytes", () => {
    editRange(O(0), [0xaa, 0xbb, 0xcc, 0xdd]);
    expect(modifiedCount()).toBe(4);
  });

  it("skips bytes that equal their current value (no unnecessary dirty-marking)", () => {
    // buffer = [0x00, 0x01, 0x02, 0x03]; only write the same values
    editRange(O(0), [0x00, 0x01, 0x02, 0x03]);
    // all values equal current → no edits → no command
    expect(canUndo()).toBe(false);
    expect(modifiedCount()).toBe(0);
  });

  it("clears redo stack", () => {
    editByte(O(0), 0xff);
    undo();
    editRange(O(1), [0xaa]);
    expect(canRedo()).toBe(false);
  });

  it("notifies listeners", () => {
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    editRange(O(0), [0x11, 0x22]);
    expect(fn).toHaveBeenCalledOnce();
    unsub();
  });

  // Silent no-ops

  it("does nothing for an empty array", () => {
    const before = Array.from(getBuffer());
    editRange(O(0), []);
    expect(Array.from(getBuffer())).toEqual(before);
    expect(canUndo()).toBe(false);
  });

  it("does nothing when startOffset is beyond buffer length", () => {
    const before = Array.from(getBuffer());
    editRange(O(100), [0xff]);
    expect(Array.from(getBuffer())).toEqual(before);
    expect(canUndo()).toBe(false);
  });
});

// undo

describe("undo", () => {
  it("does nothing if undo stack is empty", () => {
    const before = Array.from(getBuffer());
    undo();
    expect(Array.from(getBuffer())).toEqual(before);
  });

  it("restores the previous byte value", () => {
    const original = getBuffer()[0]!;
    editByte(O(0), 0xff);
    undo();
    expect(getBuffer()[0]).toBe(original);
  });

  it("moves the command to the redo stack", () => {
    editByte(O(0), 0xff);
    undo();
    expect(canRedo()).toBe(true);
  });

  it("multiple undos restore bytes in reverse order", () => {
    const b0 = getBuffer()[0]!;
    const b1 = getBuffer()[1]!;
    editByte(O(0), 0x11);
    editByte(O(1), 0x22);
    undo(); // reverts edit on O(1)
    expect(getBuffer()[1]).toBe(b1);
    undo(); // reverts edit on O(0)
    expect(getBuffer()[0]).toBe(b0);
  });

  it("rebuilds modifiedCache: modifiedCount decreases after undo", () => {
    editByte(O(0), 0xff);
    editByte(O(1), 0xee);
    undo();
    expect(modifiedCount()).toBe(1);
  });

  it("notifies listeners after undo", () => {
    editByte(O(0), 0xff);
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    undo();
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(0); // 0 modified bytes after undo
    unsub();
  });

  it("undoing an editRange restores all bytes in the range", () => {
    const before = Array.from(getBuffer());
    editRange(O(0), [0x11, 0x22, 0x33, 0x44]);
    undo();
    expect(Array.from(getBuffer())).toEqual(before);
  });
});

// redo

describe("redo", () => {
  it("does nothing if redo stack is empty", () => {
    editByte(O(0), 0xff);
    undo();
    redo();
    const snapshot = Array.from(getBuffer());
    redo(); // second redo — stack empty, no change
    expect(Array.from(getBuffer())).toEqual(snapshot);
  });

  it("re-applies the last undone edit", () => {
    editByte(O(0), 0xff);
    undo();
    redo();
    expect(getBuffer()[0]).toBe(0xff);
  });

  it("moves the command back to the undo stack", () => {
    editByte(O(0), 0xff);
    undo();
    redo();
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
  });

  it("multiple redo steps re-apply in forward order", () => {
    editByte(O(0), 0x11);
    editByte(O(1), 0x22);
    undo();
    undo();
    redo(); // re-applies edit on O(0)
    expect(getBuffer()[0]).toBe(0x11);
    expect(getBuffer()[1]).toBe(0x01); // O(1) not redone yet
    redo(); // re-applies edit on O(1)
    expect(getBuffer()[1]).toBe(0x22);
  });

  it("rebuilds modifiedCache after redo", () => {
    editByte(O(0), 0xff);
    undo();
    expect(modifiedCount()).toBe(0);
    redo();
    expect(modifiedCount()).toBe(1);
  });

  it("notifies listeners after redo", () => {
    editByte(O(0), 0xff);
    undo();
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    redo();
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(1);
    unsub();
  });

  it("redoing an editRange re-applies all bytes in the range", () => {
    editRange(O(0), [0x11, 0x22, 0x33, 0x44]);
    undo();
    redo();
    expect(getBuffer()[0]).toBe(0x11);
    expect(getBuffer()[1]).toBe(0x22);
    expect(getBuffer()[2]).toBe(0x33);
    expect(getBuffer()[3]).toBe(0x44);
  });
});

// exportBuffer

describe("exportBuffer", () => {
  it("returns a Blob", () => {
    expect(exportBuffer()).toBeInstanceOf(Blob);
  });

  it("Blob.type is 'application/octet-stream'", () => {
    expect(exportBuffer().type).toBe("application/octet-stream");
  });

  it("Blob.size matches buffer byteLength", () => {
    init(0xaa, 0xbb, 0xcc);
    expect(exportBuffer().size).toBe(3);
  });

  it("Blob contains the current (edited) buffer content", async () => {
    init(0x00, 0x01, 0x02);
    editByte(O(0), 0xff);
    const blob = exportBuffer();
    const raw = await blob.arrayBuffer();
    expect(new Uint8Array(raw)[0]).toBe(0xff);
    expect(new Uint8Array(raw)[1]).toBe(0x01);
  });

  it("Blob size is 0 for an empty buffer", () => {
    initEditor(new ArrayBuffer(0));
    expect(exportBuffer().size).toBe(0);
  });

  it("reflects the state after undo (reverted bytes exported)", async () => {
    init(0x10, 0x20);
    editByte(O(0), 0xff);
    undo();
    const blob = exportBuffer();
    const raw = await blob.arrayBuffer();
    expect(new Uint8Array(raw)[0]).toBe(0x10);
  });
});

// onEditorChange

describe("onEditorChange", () => {
  it("returns an unsubscribe function", () => {
    const unsub = onEditorChange(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("listener is called when editByte fires", () => {
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    editByte(O(0), 0xff);
    expect(fn).toHaveBeenCalledOnce();
    unsub();
  });

  it("listener receives the current modifiedCount as argument", () => {
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    editByte(O(0), 0xff);
    editByte(O(1), 0xee);
    expect(fn).toHaveBeenLastCalledWith(2);
    unsub();
  });

  it("unsubscribed listener is NOT called on subsequent edits", () => {
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    unsub();
    editByte(O(0), 0xff);
    expect(fn).not.toHaveBeenCalled();
  });

  it("multiple listeners are all called", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const u1 = onEditorChange(fn1);
    const u2 = onEditorChange(fn2);
    fn1.mockClear();
    fn2.mockClear();
    editByte(O(0), 0xff);
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
    u1();
    u2();
  });

  it("unsubscribing one listener does not affect others", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const u1 = onEditorChange(fn1);
    const u2 = onEditorChange(fn2);
    fn1.mockClear();
    fn2.mockClear();
    u1(); // unsub only fn1
    editByte(O(0), 0xff);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
    u2();
  });

  it("calling the unsubscribe function twice does not throw", () => {
    const unsub = onEditorChange(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("listener is called on undo", () => {
    editByte(O(0), 0xff);
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    undo();
    expect(fn).toHaveBeenCalledWith(0);
    unsub();
  });

  it("listener is called on redo", () => {
    editByte(O(0), 0xff);
    undo();
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    redo();
    expect(fn).toHaveBeenCalledWith(1);
    unsub();
  });

  it("listener is called on initEditor", () => {
    const fn = vi.fn();
    const unsub = onEditorChange(fn);
    fn.mockClear();
    init(0xaa, 0xbb);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(0);
    unsub();
  });
});

// Integration

describe("Integration", () => {
  it("full edit → undo → redo round-trip preserves byte values correctly", () => {
    const original = Array.from(getBuffer());
    editByte(O(0), 0x11);
    editByte(O(1), 0x22);
    undo();
    undo();
    expect(Array.from(getBuffer())).toEqual(original);
    redo();
    redo();
    expect(getBuffer()[0]).toBe(0x11);
    expect(getBuffer()[1]).toBe(0x22);
  });

  it("modifiedCount stays consistent across edit → undo → redo cycles", () => {
    editByte(O(0), 0xaa);
    editByte(O(1), 0xbb);
    expect(modifiedCount()).toBe(2);
    undo();
    expect(modifiedCount()).toBe(1);
    undo();
    expect(modifiedCount()).toBe(0);
    redo();
    expect(modifiedCount()).toBe(1);
    redo();
    expect(modifiedCount()).toBe(2);
  });

  it("originalSnapshot stays immutable across the full lifecycle", () => {
    init(0x10, 0x20, 0x30);
    editByte(O(0), 0xff);
    editByte(O(1), 0xee);
    undo();
    redo();
    expect(getOriginalByte(O(0))).toBe(0x10);
    expect(getOriginalByte(O(1))).toBe(0x20);
    expect(getOriginalByte(O(2))).toBe(0x30);
  });

  it("editRange then undo then redo keeps modifiedCount accurate", () => {
    editRange(O(0), [0x11, 0x22, 0x33, 0x44]);
    expect(modifiedCount()).toBe(4);
    undo();
    expect(modifiedCount()).toBe(0);
    redo();
    expect(modifiedCount()).toBe(4);
  });

  it("new edit after undo clears redo and creates a new branch", () => {
    editByte(O(0), 0x11);
    editByte(O(1), 0x22);
    undo(); // undo second edit → canRedo=true
    editByte(O(2), 0x33); // new edit → clears redo
    expect(canRedo()).toBe(false);
    expect(canUndo()).toBe(true);
    expect(getBuffer()[1]).toBe(0x01); // second edit was discarded
    expect(getBuffer()[2]).toBe(0x33);
  });

  it("exportBuffer after a series of edits exports the final state", async () => {
    editRange(O(0), [0xde, 0xad, 0xbe, 0xef]);
    const blob = exportBuffer();
    const raw = await blob.arrayBuffer();
    const arr = new Uint8Array(raw);
    expect(arr[0]).toBe(0xde);
    expect(arr[1]).toBe(0xad);
    expect(arr[2]).toBe(0xbe);
    expect(arr[3]).toBe(0xef);
  });

  it("listener receives correct count through a full edit/undo/redo sequence", () => {
    const counts: number[] = [];
    const unsub = onEditorChange((c) => counts.push(c));
    counts.length = 0; // discard init call
    editByte(O(0), 0xaa); // count=1
    editByte(O(1), 0xbb); // count=2
    undo(); // count=1
    redo(); // count=2
    expect(counts).toEqual([1, 2, 1, 2]);
    unsub();
  });
});
