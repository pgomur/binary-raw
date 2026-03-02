/**
 * @file Type definitions for binary-raw, a binary file viewer and editor.
 * Provides branded types for domain-specific primitives, file format structures,
 * editing operations, and event handling.
 */

/**
 * Unique symbol used to create branded types that prevent mixing of
 * semantically different numeric values at compile time.
 */
declare const __brand: unique symbol;

/**
 * Represents an absolute offset in a binary file (0-based byte position).
 * Branded type to prevent confusion with regular numbers, indices, or counts.
 * @example
 * const offset = Offset.create(1024); // AbsoluteOffset
 */
export type AbsoluteOffset = number & { readonly [__brand]: "AbsoluteOffset" };

/**
 * Represents a count of bytes.
 * Branded type to prevent confusion with offsets or other numeric values.
 * @example
 * const size = Bytes.create(512); // ByteCount
 */
export type ByteCount = number & { readonly [__brand]: "ByteCount" };

/**
 * Represents a virtual memory address as used in executable file formats.
 * Uses bigint to handle 64-bit addresses without precision loss.
 */
export type VirtualAddress = bigint & { readonly [__brand]: "VirtualAddress" };

/**
 * Error class for domain-specific validation failures.
 * Used to represent invalid operations on offsets, byte counts, and ranges.
 */
export class DomainError extends Error {
  /**
   * Creates a new DomainError.
   * @param message - Human-readable description of the error.
   * @param code - Specific error code indicating the failure type.
   */
  constructor(
    message: string,
    public readonly code: "NEGATIVE" | "OVERFLOW" | "MISALIGNED" | "INVALID",
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/**
 * Utility namespace for creating and manipulating absolute offsets.
 * Provides validation and type-safe arithmetic operations.
 */
export const Offset = {
  /**
   * Creates an AbsoluteOffset from a number with validation.
   * @param n - The numeric offset value.
   * @returns A branded AbsoluteOffset if valid.
   * @throws {DomainError} If the value is not finite, negative, or non-integer.
   */
  create(n: number): AbsoluteOffset {
    if (!Number.isFinite(n)) throw new DomainError("Offset must be finite", "OVERFLOW");
    if (n < 0) throw new DomainError("Offset cannot be negative", "NEGATIVE");
    if (!Number.isInteger(n)) throw new DomainError("Offset must be integer", "INVALID");
    return n as AbsoluteOffset;
  },

  /**
   * Adds a byte count to an offset.
   * @param a - The base offset.
   * @param b - The byte count to add.
   * @returns A new AbsoluteOffset.
   */
  add(a: AbsoluteOffset, b: ByteCount): AbsoluteOffset {
    return (a + b) as AbsoluteOffset;
  },

  /**
   * Calculates the absolute difference between two offsets.
   * @param a - First offset.
   * @param b - Second offset.
   * @returns The absolute difference as a ByteCount.
   */
  diff(a: AbsoluteOffset, b: AbsoluteOffset): ByteCount {
    return Math.abs(a - b) as ByteCount;
  },
};

/**
 * Utility namespace for creating and manipulating byte counts.
 */
export const Bytes = {
  /**
   * Creates a ByteCount from a number with validation.
   * @param n - The numeric byte count.
   * @returns A branded ByteCount if valid.
   * @throws {DomainError} If the value is negative or non-integer.
   */
  create(n: number): ByteCount {
    if (n < 0 || !Number.isInteger(n)) throw new DomainError("Invalid byte count", "INVALID");
    return n as ByteCount;
  },

  /**
   * Calculates the byte count for a range from start to end (inclusive).
   * @param start - The starting offset (inclusive).
   * @param end - The ending offset (inclusive).
   * @returns The number of bytes in the range.
   */
  fromRange(start: AbsoluteOffset, end: AbsoluteOffset): ByteCount {
    return (end - start + 1) as ByteCount;
  },

  /**
   * Converts kilobytes to bytes.
   * @param n - Number of kilobytes.
   * @returns ByteCount equivalent.
   */
  KB: (n: number): ByteCount => (n * 1024) as ByteCount,
  /**
   * Converts megabytes to bytes.
   * @param n - Number of megabytes.
   * @returns ByteCount equivalent.
   */
  MB: (n: number): ByteCount => (n * 1024 * 1024) as ByteCount,
};

/**
 * Represents a contiguous range of bytes in a binary file (inclusive bounds).
 */
export interface ByteRange {
  /** The starting offset (inclusive). */
  readonly start: AbsoluteOffset;
  /** The ending offset (inclusive). */
  readonly end: AbsoluteOffset;
  /** The number of bytes in the range. */
  readonly length: ByteCount;
}

/**
 * Utility namespace for creating and manipulating byte ranges.
 */
export const Range = {
  /**
   * Creates a ByteRange with validation.
   * @param start - The starting offset (inclusive).
   * @param end - The ending offset (inclusive).
   * @returns A ByteRange if valid.
   * @throws {DomainError} If start > end.
   */
  create(start: AbsoluteOffset, end: AbsoluteOffset): ByteRange {
    if (start > end) throw new DomainError("Invalid range: start > end", "INVALID");
    return {
      start,
      end,
      length: Bytes.fromRange(start, end),
    };
  },

  /**
   * Creates a ByteRange from a starting offset and length.
   * @param start - The starting offset (inclusive).
   * @param length - The number of bytes.
   * @returns A ByteRange spanning length bytes from start.
   */
  fromLength(start: AbsoluteOffset, length: ByteCount): ByteRange {
    return Range.create(start, (start + length - 1) as AbsoluteOffset);
  },

  /**
   * Checks if an offset falls within a range.
   * @param range - The range to check.
   * @param offset - The offset to test.
   * @returns True if start <= offset <= end.
   */
  contains(range: ByteRange, offset: AbsoluteOffset): boolean {
    return offset >= range.start && offset <= range.end;
  },
};

/**
 * Represents the current state of a selection in the binary viewer.
 * - "none": No active selection.
 * - "selecting": User is actively selecting; anchor is fixed, current moves.
 * - "selected": A range has been committed.
 */
export type SelectionState =
  { readonly type: "none" } |
  { readonly type: "selecting"; readonly anchor: AbsoluteOffset; readonly current: AbsoluteOffset } |
  { readonly type: "selected"; readonly range: ByteRange };

/**
 * Utility namespace for managing selection state transitions.
 */
export const Selection = {
  /**
   * Creates a "none" selection state (no selection).
   */
  none: (): SelectionState => ({ type: "none" }),

  /**
   * Begins a new selection from an anchor point.
   * @param anchor - The fixed anchor offset.
   */
  start: (anchor: AbsoluteOffset): SelectionState => ({
    type: "selecting",
    anchor,
    current: anchor,
  }),

  /**
   * Updates the current position of an in-progress selection.
   * @param state - The current selection state (must be "selecting").
   * @param current - The new current offset.
   * @returns Updated SelectionState.
   */
  update: (state: SelectionState, current: AbsoluteOffset): SelectionState => {
    if (state.type !== "selecting") return state;
    return { ...state, current };
  },

  /**
   * Commits a selecting state, creating a final selected range.
   * @param state - The selection state to commit.
   * @returns A "selected" state with the calculated range, or unchanged if not selecting.
   */
  commit: (state: SelectionState): SelectionState => {
    if (state.type !== "selecting") return state;
    return {
      type: "selected",
      range: Range.create(Math.min(state.anchor, state.current) as AbsoluteOffset, Math.max(state.anchor, state.current) as AbsoluteOffset),
    };
  },

  /**
   * Creates a "selected" state directly from a known ByteRange.
   * Used when clicking in the sidebar to select a range directly.
   * @param range - The byte range to select.
   */
  select: (range: ByteRange): SelectionState => ({
    type: "selected",
    range,
  }),
};

/**
 * Supported binary file formats for parsing and display.
 */
export type FileFormat = "ELF" | "PE" | "MACHO" | "PDF" | "PNG" | "JPEG" | "ZIP" | "BIN";

/**
 * Format-specific metadata extracted during parsing.
 * Discriminated union containing format-specific details.
 */
export type FormatMetadata =
  // ELF executable format: class (32/64 bit) and endianness.
  { readonly format: "ELF"; readonly class: 32 | 64; readonly endian: "le" | "be" } |
  // PE (Windows Portable Executable) format: PE32 or PE32+ (64-bit).
  { readonly format: "PE"; readonly peType: "PE32" | "PE32+" } |
  // Mach-O (macOS) format: CPU architecture type.
  { readonly format: "MACHO"; readonly cpuType: string } |
  // PDF format: version string.
  { readonly format: "PDF"; readonly version: string } |
  // PNG image: dimensions.
  { readonly format: "PNG"; readonly width: number; readonly height: number } |
  // JPEG image: dimensions.
  { readonly format: "JPEG"; readonly width: number; readonly height: number } |
  // ZIP archive: number of entries.
  { readonly format: "ZIP"; readonly entries: number } |
  // Raw binary: entropy score (0-8, higher = more random).
  { readonly format: "BIN"; readonly entropy: number };

/**
 * Type guard to narrow FormatMetadata to a specific format.
 * @template F - The expected format type.
 * @param meta - The format metadata to check.
 * @param format - The expected format string.
 * @returns True if meta matches the expected format.
 */
export const isFormat = <F extends FileFormat>(meta: FormatMetadata, format: F): meta is Extract<FormatMetadata, { format: F }> => meta.format === format;

/**
 * Categorizes the purpose of a section within a parsed file structure.
 */
export type SectionType =
  // Container section that holds other sections (e.g., segments, groups).
  "container" |
  // Contains actual data (e.g., code, initialized data).
  "data" |
  // Metadata (e.g., headers, symbol tables).
  "metadata" |
  // Padding/alignment bytes (no meaningful content).
  "padding";

/**
 * Represents a node in the hierarchical structure of a parsed binary file.
 * Sections can be nested (parent-child relationship) and contain metadata.
 */
export interface SectionNode {
  /** Unique identifier for this section. */
  readonly id: string;
  /** Human-readable name of the section. */
  readonly name: string;
  /** The type/category of this section. */
  readonly type: SectionType;
  /** The byte range this section occupies in the file. */
  readonly range: ByteRange;
  /** Virtual memory address (if applicable, e.g., in ELF/PE). */
  readonly virtualAddr: VirtualAddress | undefined; // explicit undefined
  /** Access control flags for this section. */
  readonly flags: {
    /** Whether the section is readable. */
    readonly readable: boolean;
    /** Whether the section is writable. */
    readonly writable: boolean;
    /** Whether the section is executable. */
    readonly executable: boolean;
  };
  /** Additional format-specific metadata. */
  readonly metadata: Record<string, unknown>;
  /** Child sections (nested within this section). */
  readonly children: readonly SectionNode[];
  /** ID of the parent section, if any. */
  readonly parent: string | undefined; // explicit undefined
}

/**
 * Builder pattern for creating SectionNode instances with validation.
 * Provides a fluent API for constructing sections step by step.
 * @example
 * const section = new SectionBuilder()
 *   .id(".text")
 *   .name("Code Section")
 *   .type("data")
 *   .range(Range.create(start, end))
 *   .flags({ readable: true, writable: false, executable: true })
 *   .build();
 */
export class SectionBuilder {
  private idValue: string = "";
  private nameValue: string = "";
  private typeValue: SectionType = "data";
  private rangeValue?: ByteRange;
  private virtualAddrValue: VirtualAddress | undefined = undefined;
  private flagsValue = { readable: true, writable: false, executable: false };
  private metadataValue: Record<string, unknown> = {};
  private childrenValue: SectionNode[] = [];
  private parentValue: string | undefined = undefined;

  /**
   * Sets the section identifier.
   * @param id - Unique identifier.
   */
  id(id: string): this {
    this.idValue = id;
    return this;
  }

  /**
   * Sets the section name.
   * @param name - Human-readable name.
   */
  name(name: string): this {
    this.nameValue = name;
    return this;
  }

  /**
   * Sets the section type.
   * @param type - The SectionType.
   */
  type(type: SectionType): this {
    this.typeValue = type;
    return this;
  }

  /**
   * Sets the byte range this section occupies.
   * @param range - The ByteRange.
   */
  range(range: ByteRange): this {
    this.rangeValue = range;
    return this;
  }

  /**
   * Sets the virtual address (if applicable).
   * @param addr - The VirtualAddress or undefined.
   */
  virtualAddr(addr: VirtualAddress | undefined): this {
    this.virtualAddrValue = addr;
    return this;
  }

  /**
   * Sets the access flags.
   * @param flags - The flags object.
   */
  flags(flags: SectionNode["flags"]): this {
    this.flagsValue = { ...flags };
    return this;
  }

  /**
   * Adds a metadata key-value pair.
   * @param key - Metadata key.
   * @param value - Metadata value.
   */
  meta(key: string, value: unknown): this {
    this.metadataValue = { ...this.metadataValue, [key]: value };
    return this;
  }

  /**
   * Adds a child section.
   * @param child - The child SectionNode to add.
   */
  addChild(child: SectionNode): this {
    this.childrenValue = [...this.childrenValue, child];
    return this;
  }

  /**
   * Sets the parent section ID.
   * @param parent - The parent section ID or undefined.
   */
  parent(parent: string | undefined): this {
    this.parentValue = parent;
    return this;
  }

  /**
   * Builds the SectionNode instance.
   * @returns The constructed SectionNode.
   * @throws {DomainError} If required fields (id, name, range) are missing.
   */
  build(): SectionNode {
    if (!this.idValue || !this.nameValue || !this.rangeValue) {
      throw new DomainError("Section missing required fields", "INVALID");
    }

    return {
      id: this.idValue,
      name: this.nameValue,
      type: this.typeValue,
      range: this.rangeValue,
      virtualAddr: this.virtualAddrValue,
      flags: this.flagsValue,
      metadata: this.metadataValue,
      children: this.childrenValue,
      parent: this.parentValue,
    };
  }
}

/**
 * Represents a fully parsed binary file with its structure and metadata.
 */
export interface ParsedStructure {
  /** The detected file format. */
  readonly format: FileFormat;
  /** Format-specific metadata extracted during parsing. */
  readonly formatMeta: FormatMetadata;
  /** The root section node of the hierarchical structure. */
  readonly root: SectionNode;
  /** Total size of the file in bytes. */
  readonly totalSize: ByteCount;
  /** Entry point virtual address (if applicable). */
  readonly entryPoint: VirtualAddress | undefined; // explicit undefined
}

/**
 * Represents a single edit operation on a binary file.
 * Discriminated union of possible edit types.
 */
export type EditOperation =
  // Replaces bytes in a range with new data (must be same length).
  { readonly type: "replace"; readonly range: ByteRange; readonly data: Uint8Array } |
  // Inserts new data at an offset, shifting existing bytes forward.
  { readonly type: "insert"; readonly offset: AbsoluteOffset; readonly data: Uint8Array } |
  // Deletes a range of bytes, pulling following bytes backward.
  { readonly type: "delete"; readonly range: ByteRange };

/**
 * Represents a complete edit command with metadata for undo/redo support.
 */
export interface EditCommand {
  /** Unique identifier for this command. */
  readonly id: string;
  /** Unix timestamp of when the command was created. */
  readonly timestamp: number;
  /** The actual operation performed. */
  readonly operation: EditOperation;
  /** Human-readable description of the change. */
  readonly description: string;
  /** All byte ranges affected by this operation. */
  readonly affectedRanges: readonly ByteRange[];
  /** The inverse operation for undo functionality. */
  readonly inverse: EditOperation;
}

/**
 * Maintains the edit history for undo/redo functionality.
 */
export interface EditHistory {
  /** List of all executed commands. */
  readonly commands: readonly EditCommand[];
  /** Index of the current position in the command list (-1 = before first). */
  readonly currentIndex: number;
  /** Maximum number of commands to retain in history. */
  readonly maxSize: number;
  /** Total number of bytes affected by all commands in history. */
  readonly totalBytesAffected: ByteCount;
}

/**
 * Utility namespace for managing edit history with undo/redo support.
 */
export const History = {
  /**
   * Creates a new empty edit history.
   * @param maxSize - Maximum number of commands to retain (default: 1000).
   */
  create(maxSize = 1000): EditHistory {
    return {
      commands: [],
      currentIndex: -1,
      maxSize,
      totalBytesAffected: Bytes.create(0),
    };
  },

  /**
   * Pushes a new command to history, removing any redo-able commands.
   * @param history - Current history state.
   * @param cmd - The command to add.
   * @returns New history state with the command added.
   */
  push(history: EditHistory, cmd: EditCommand): EditHistory {
    const newCommands = history.commands.slice(0, history.currentIndex + 1);
    if (newCommands.length >= history.maxSize) newCommands.shift();

    const bytesAffected = cmd.affectedRanges.reduce((sum, r) => sum + r.length, 0) as ByteCount;

    return {
      commands: [...newCommands, cmd],
      currentIndex: newCommands.length,
      maxSize: history.maxSize,
      totalBytesAffected: (history.totalBytesAffected + bytesAffected) as ByteCount,
    };
  },

  /**
   * Checks if undo is available (there are commands to undo).
   * @param h - The history to check.
   */
  canUndo: (h: EditHistory): boolean => h.currentIndex >= 0,
  /**
   * Checks if redo is available (there are undone commands).
   * @param h - The history to check.
   */
  canRedo: (h: EditHistory): boolean => h.currentIndex < h.commands.length - 1,

  /**
   * Undoes the last command, returning it along with updated history.
   * @param h - Current history state.
   * @returns Object with new history and the undone command, or null if nothing to undo.
   */
  undo: (h: EditHistory): { history: EditHistory; command: EditCommand } | null => {
    if (!History.canUndo(h)) return null;
    const command = h.commands[h.currentIndex];
    if (!command) return null;
    return {
      history: { ...h, currentIndex: h.currentIndex - 1 },
      command,
    };
  },

  /**
   * Redoes a previously undone command.
   * @param h - Current history state.
   * @returns Object with new history and the redone command, or null if nothing to redo.
   */
  redo: (h: EditHistory): { history: EditHistory; command: EditCommand } | null => {
    if (!History.canRedo(h)) return null;
    const command = h.commands[h.currentIndex + 1];
    if (!command) return null;
    return {
      history: { ...h, currentIndex: h.currentIndex + 1 },
      command,
    };
  },
};

/**
 * Endianness byte order for multi-byte data types.
 */
export type Endianness = "le" | "be";

/**
 * Represents a decoded value from a specific offset in the binary data.
 * @template T - The decoded value type (number, bigint, or string).
 */
export interface DecodedValue<T> {
  /** The decoded value. */
  readonly value: T;
  /** Offset in the file where this value starts. */
  readonly offset: AbsoluteOffset;
  /** Size in bytes of this value. */
  readonly size: ByteCount;
  /** Byte order used for decoding. */
  readonly endianness: Endianness;
  /** Whether the value is valid (e.g., not truncated). */
  readonly valid: boolean;
  /** Raw byte values that were decoded. */
  readonly raw: readonly number[];
}

/**
 * Represents a data inspector value with type information.
 * Discriminated union of all supported inspector value types.
 */
export type InspectorValue =
  | { readonly type: "uint8"; readonly data: DecodedValue<number> }
  | { readonly type: "int8"; readonly data: DecodedValue<number> }
  | { readonly type: "uint16"; readonly data: DecodedValue<number>; readonly endian: Endianness }
  | { readonly type: "int16"; readonly data: DecodedValue<number>; readonly endian: Endianness }
  | { readonly type: "uint32"; readonly data: DecodedValue<number>; readonly endian: Endianness }
  | { readonly type: "int32"; readonly data: DecodedValue<number>; readonly endian: Endianness }
  | { readonly type: "uint64"; readonly data: DecodedValue<bigint>; readonly endian: Endianness }
  | { readonly type: "float32"; readonly data: DecodedValue<number>; readonly endian: Endianness }
  | { readonly type: "float64"; readonly data: DecodedValue<number>; readonly endian: Endianness }
  | { readonly type: "ascii"; readonly data: DecodedValue<string> }
  | { readonly type: "utf8"; readonly data: DecodedValue<string> };

/**
 * Represents the data inspector's view at a specific offset.
 * Shows decoded values and bit-level information.
 */
export interface InspectorView {
  /** The file offset being inspected. */
  readonly offset: AbsoluteOffset;
  /** Map of decoded values by type. */
  readonly values: {
    readonly [K in InspectorValue["type"]]?: Extract<InspectorValue, { type: K }>;
  };
  /** Individual bit values for the byte at the current offset. */
  readonly bitField: {
    readonly b0: boolean;
    readonly b1: boolean;
    readonly b2: boolean;
    readonly b3: boolean;
    readonly b4: boolean;
    readonly b5: boolean;
    readonly b6: boolean;
    readonly b7: boolean;
  };
}

/**
 * Represents an open file handle for reading and writing binary data.
 * Abstracts the underlying storage mechanism (local file, remote, or memory).
 */
export interface FileHandle {
  /** Unique identifier for this file handle. */
  readonly id: string;
  /** Display name of the file. */
  readonly name: string;
  /** Size of the file in bytes. */
  readonly size: ByteCount;
  /** Source of the file data. */
  readonly source: "local" | "remote" | "memory";
  /** Last modification timestamp (Unix ms). */
  readonly lastModified: number;
  /** Whether the file can be read. */
  readonly readable: boolean;
  /** Whether the file can be written to. */
  readonly writable: boolean;

  /**
   * Reads bytes from a specific range.
   * @param range - The byte range to read.
   * @returns Promise resolving to the raw bytes read.
   */
  read(range: ByteRange): Promise<Uint8Array>;
  /**
   * Writes bytes to a specific range.
   * @param range - The byte range to write to.
   * @param data - The data to write.
   */
  write(range: ByteRange, data: Uint8Array): Promise<void>;
  /**
   * Closes the file handle and releases resources.
   */
  close(): Promise<void>;
}

/**
 * Represents a fully loaded file with its structure, state, and metadata.
 */
export interface LoadedFile {
  /** The file handle for I/O operations. */
  readonly handle: FileHandle;
  /** The parsed structure of the file. */
  readonly structure: ParsedStructure;
  /** Edit history for undo/redo. */
  readonly history: EditHistory;
  /** Current selection state. */
  readonly selection: SelectionState;
  /** Viewport configuration and visible range. */
  readonly viewport: {
    /** The currently visible byte range. */
    readonly visibleRange: ByteRange;
    /** Number of bytes displayed per row. */
    readonly bytesPerRow: 16 | 32 | 64;
  };
  /** Whether the file has unsaved changes. */
  readonly dirty: boolean;
  /** Whether the file is read-only. */
  readonly readOnly: boolean;
}

/**
 * Entry in the recently opened files list.
 */
export interface RecentFileEntry {
  /** Unique identifier for this file entry. */
  readonly id: string;
  /** Display name of the file. */
  readonly name: string;
  /** Size of the file in bytes. */
  readonly size: ByteCount;
  /** Detected file format. */
  readonly format: FileFormat;
  /** ISO timestamp of when the file was last opened. */
  readonly lastOpened: string;
  /** Whether this file is pinned to the top of the list. */
  readonly pinned: boolean;
  /** User-defined tags for categorization. */
  readonly tags: readonly string[];
}

/**
 * Domain events that can be dispatched throughout the application.
 * Discriminated union of all possible event types.
 */
export type DomainEvent =
  // A file has been loaded into the editor.
  { readonly type: "file.loaded"; readonly payload: LoadedFile } |
  // A file has been closed.
  { readonly type: "file.closed"; readonly id: string } |
  // The selection state has changed.
  { readonly type: "selection.changed"; readonly previous: SelectionState; readonly current: SelectionState } |
  // An edit operation has been applied.
  { readonly type: "edit.applied"; readonly command: EditCommand } |
  // An edit operation has been undone.
  { readonly type: "edit.undone"; readonly command: EditCommand } |
  // A domain error has occurred.
  { readonly type: "error.occurred"; readonly error: DomainError };

/**
 * Type for event handler functions.
 * @template E - The specific event type to handle.
 */
export type EventHandler<E extends DomainEvent["type"]> = (event: Extract<DomainEvent, { type: E }>) => void;
