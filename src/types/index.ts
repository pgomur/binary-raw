// Section 1: Core Branded Types

declare const __brand: unique symbol;

export type AbsoluteOffset = number & { readonly [__brand]: "AbsoluteOffset" };
export type ByteCount = number & { readonly [__brand]: "ByteCount" };
export type VirtualAddress = bigint & { readonly [__brand]: "VirtualAddress" };

// Section 2: Constructors and Utilities

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: "NEGATIVE" | "OVERFLOW" | "MISALIGNED" | "INVALID",
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const Offset = {
  create(n: number): AbsoluteOffset {
    if (!Number.isFinite(n)) throw new DomainError("Offset must be finite", "OVERFLOW");
    if (n < 0) throw new DomainError("Offset cannot be negative", "NEGATIVE");
    if (!Number.isInteger(n)) throw new DomainError("Offset must be integer", "INVALID");
    return n as AbsoluteOffset;
  },

  add(a: AbsoluteOffset, b: ByteCount): AbsoluteOffset {
    return (a + b) as AbsoluteOffset;
  },

  diff(a: AbsoluteOffset, b: AbsoluteOffset): ByteCount {
    return Math.abs(a - b) as ByteCount;
  },
};

export const Bytes = {
  create(n: number): ByteCount {
    if (n < 0 || !Number.isInteger(n)) throw new DomainError("Invalid byte count", "INVALID");
    return n as ByteCount;
  },

  fromRange(start: AbsoluteOffset, end: AbsoluteOffset): ByteCount {
    return (end - start + 1) as ByteCount;
  },

  KB: (n: number): ByteCount => (n * 1024) as ByteCount,
  MB: (n: number): ByteCount => (n * 1024 * 1024) as ByteCount,
};

// Section 3: Ranges and Selection

export interface ByteRange {
  readonly start: AbsoluteOffset;
  readonly end: AbsoluteOffset;
  readonly length: ByteCount;
}

export const Range = {
  create(start: AbsoluteOffset, end: AbsoluteOffset): ByteRange {
    if (start > end) throw new DomainError("Invalid range: start > end", "INVALID");
    return {
      start,
      end,
      length: Bytes.fromRange(start, end),
    };
  },

  fromLength(start: AbsoluteOffset, length: ByteCount): ByteRange {
    return Range.create(start, (start + length - 1) as AbsoluteOffset);
  },

  contains(range: ByteRange, offset: AbsoluteOffset): boolean {
    return offset >= range.start && offset <= range.end;
  },
};

export type SelectionState = { readonly type: "none" } | { readonly type: "selecting"; readonly anchor: AbsoluteOffset; readonly current: AbsoluteOffset } | { readonly type: "selected"; readonly range: ByteRange };

export const Selection = {
  none: (): SelectionState => ({ type: "none" }),

  start: (anchor: AbsoluteOffset): SelectionState => ({
    type: "selecting",
    anchor,
    current: anchor,
  }),

  update: (state: SelectionState, current: AbsoluteOffset): SelectionState => {
    if (state.type !== "selecting") return state;
    return { ...state, current };
  },

  commit: (state: SelectionState): SelectionState => {
    if (state.type !== "selecting") return state;
    return {
      type: "selected",
      range: Range.create(Math.min(state.anchor, state.current) as AbsoluteOffset, Math.max(state.anchor, state.current) as AbsoluteOffset),
    };
  },

  // FIX punto 6: helper para crear estado 'selected' directamente
  // desde un ByteRange conocido (usado por sidebar.ts al hacer clic).
  select: (range: ByteRange): SelectionState => ({
    type: "selected",
    range,
  }),
};

// Section 4: File Formats

export type FileFormat = "ELF" | "PE" | "MACHO" | "PDF" | "PNG" | "JPEG" | "ZIP" | "BIN";

export type FormatMetadata =
  | { readonly format: "ELF"; readonly class: 32 | 64; readonly endian: "le" | "be" }
  | { readonly format: "PE"; readonly peType: "PE32" | "PE32+" }
  | { readonly format: "MACHO"; readonly cpuType: string }
  | { readonly format: "PDF"; readonly version: string }
  | { readonly format: "PNG"; readonly width: number; readonly height: number }
  | { readonly format: "JPEG"; readonly width: number; readonly height: number }
  | { readonly format: "ZIP"; readonly entries: number }
  | { readonly format: "BIN"; readonly entropy: number };

export const isFormat = <F extends FileFormat>(meta: FormatMetadata, format: F): meta is Extract<FormatMetadata, { format: F }> => meta.format === format;

// Section 5: Section Structure

export type SectionType = "container" | "data" | "metadata" | "padding";

export interface SectionNode {
  readonly id: string;
  readonly name: string;
  readonly type: SectionType;
  readonly range: ByteRange;
  readonly virtualAddr: VirtualAddress | undefined; // explicit undefined
  readonly flags: {
    readonly readable: boolean;
    readonly writable: boolean;
    readonly executable: boolean;
  };
  readonly metadata: Record<string, unknown>;
  readonly children: readonly SectionNode[];
  readonly parent: string | undefined; // explicit undefined
}

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

  id(id: string): this {
    this.idValue = id;
    return this;
  }

  name(name: string): this {
    this.nameValue = name;
    return this;
  }

  type(type: SectionType): this {
    this.typeValue = type;
    return this;
  }

  range(range: ByteRange): this {
    this.rangeValue = range;
    return this;
  }

  virtualAddr(addr: VirtualAddress | undefined): this {
    this.virtualAddrValue = addr;
    return this;
  }

  flags(flags: SectionNode["flags"]): this {
    this.flagsValue = { ...flags };
    return this;
  }

  meta(key: string, value: unknown): this {
    this.metadataValue = { ...this.metadataValue, [key]: value };
    return this;
  }

  addChild(child: SectionNode): this {
    this.childrenValue = [...this.childrenValue, child];
    return this;
  }

  parent(parent: string | undefined): this {
    this.parentValue = parent;
    return this;
  }

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

export interface ParsedStructure {
  readonly format: FileFormat;
  readonly formatMeta: FormatMetadata;
  readonly root: SectionNode;
  readonly totalSize: ByteCount;
  readonly entryPoint: VirtualAddress | undefined; // explicit undefined
}

// Section 6: Editing System

export type EditOperation = { readonly type: "replace"; readonly range: ByteRange; readonly data: Uint8Array } | { readonly type: "insert"; readonly offset: AbsoluteOffset; readonly data: Uint8Array } | { readonly type: "delete"; readonly range: ByteRange };

export interface EditCommand {
  readonly id: string;
  readonly timestamp: number;
  readonly operation: EditOperation;
  readonly description: string;
  readonly affectedRanges: readonly ByteRange[];
  readonly inverse: EditOperation;
}

export interface EditHistory {
  readonly commands: readonly EditCommand[];
  readonly currentIndex: number;
  readonly maxSize: number;
  readonly totalBytesAffected: ByteCount;
}

export const History = {
  create(maxSize = 1000): EditHistory {
    return {
      commands: [],
      currentIndex: -1,
      maxSize,
      totalBytesAffected: Bytes.create(0),
    };
  },

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

  canUndo: (h: EditHistory): boolean => h.currentIndex >= 0,
  canRedo: (h: EditHistory): boolean => h.currentIndex < h.commands.length - 1,

  undo: (h: EditHistory): { history: EditHistory; command: EditCommand } | null => {
    if (!History.canUndo(h)) return null;
    const command = h.commands[h.currentIndex];
    if (!command) return null;
    return {
      history: { ...h, currentIndex: h.currentIndex - 1 },
      command,
    };
  },

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

// Section 7: Data Inspector

export type Endianness = "le" | "be";

export interface DecodedValue<T> {
  readonly value: T;
  readonly offset: AbsoluteOffset;
  readonly size: ByteCount;
  readonly endianness: Endianness;
  readonly valid: boolean;
  readonly raw: readonly number[];
}

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

export interface InspectorView {
  readonly offset: AbsoluteOffset;
  readonly values: {
    readonly [K in InspectorValue["type"]]?: Extract<InspectorValue, { type: K }>;
  };
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

// Section 8: Files and Persistence

export interface FileHandle {
  readonly id: string;
  readonly name: string;
  readonly size: ByteCount;
  readonly source: "local" | "remote" | "memory";
  readonly lastModified: number;
  readonly readable: boolean;
  readonly writable: boolean;

  read(range: ByteRange): Promise<Uint8Array>;
  write(range: ByteRange, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface LoadedFile {
  readonly handle: FileHandle;
  readonly structure: ParsedStructure;
  readonly history: EditHistory;
  readonly selection: SelectionState;
  readonly viewport: {
    readonly visibleRange: ByteRange;
    readonly bytesPerRow: 16 | 32 | 64;
  };
  readonly dirty: boolean;
  readonly readOnly: boolean;
}

export interface RecentFileEntry {
  readonly id: string;
  readonly name: string;
  readonly size: ByteCount;
  readonly format: FileFormat;
  readonly lastOpened: string;
  readonly pinned: boolean;
  readonly tags: readonly string[];
}

// Section 9: Events

export type DomainEvent =
  | { readonly type: "file.loaded"; readonly payload: LoadedFile }
  | { readonly type: "file.closed"; readonly id: string }
  | { readonly type: "selection.changed"; readonly previous: SelectionState; readonly current: SelectionState }
  | { readonly type: "edit.applied"; readonly command: EditCommand }
  | { readonly type: "edit.undone"; readonly command: EditCommand }
  | { readonly type: "error.occurred"; readonly error: DomainError };

export type EventHandler<E extends DomainEvent["type"]> = (event: Extract<DomainEvent, { type: E }>) => void;
