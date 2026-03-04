/**
 * @file src/ui/screens/editor.ts
 * Hex editor screen orchestrator.
 *
 * Responsibilities:
 * - Mount and destroy the five UI components.
 * - Connect data flows between components.
 * - Manage the hover cursor over hex-view.
 * - Integrate toolbar search with search.ts.
 * - Clean up everything on unmount.
 */

import type { LoadedFile, SectionNode, AbsoluteOffset } from "@app-types/index";
import { Bytes, Offset } from "@app-types/index";
import template from "./editor.html?raw";

import { mountHexView, type HexViewHandle } from "@ui/components/hex-view";
import { mountInspector, type InspectorHandle } from "@ui/components/inspector";
import { mountStatusBar, type StatusBarHandle } from "@ui/components/status-bar";
import { mountSidebar, type SidebarHandle } from "@ui/components/sidebar";
import { mountToolbar, type ToolbarHandle } from "@ui/components/toolbar";
import type { SearchQuery } from "@ui/components/toolbar";

import { initEditor, destroyEditor, getBuffer, onEditorChange } from "@core/editor";
import { onSelectionChange, clearSelection, resetSelection, startSelection, updateSelection, commitSelection, getSelection } from "@core/selection";
import { loadBuffer } from "@core/buffer";
import { findAll, hexToBytes, asciiToBytes } from "@core/search";

// DOM element references

const el = {
  root: null as HTMLElement | null,
  fileName: null as HTMLElement | null,
  formatBadge: null as HTMLElement | null,
  btnClose: null as HTMLButtonElement | null,
  btnOpen: null as HTMLButtonElement | null,
  toolbar: null as HTMLElement | null,
  hexRows: null as HTMLElement | null,
  sidebar: null as HTMLElement | null,
  inspector: null as HTMLElement | null,
  statusBar: null as HTMLElement | null,
};

// Component handles

let hexViewHandle: HexViewHandle | null = null;
let inspectorHandle: InspectorHandle | null = null;
let statusBarHandle: StatusBarHandle | null = null;
let sidebarHandle: SidebarHandle | null = null;
let toolbarHandle: ToolbarHandle | null = null;

// Subscriptions

let unsubSelection: (() => void) | null = null;
let unsubEditor: (() => void) | null = null;

// Hover (cursor tracking) listeners

let onHexMouseMove: ((e: MouseEvent) => void) | null = null;
let onHexMouseLeave: (() => void) | null = null;
let onGlobalKeydown: ((e: KeyboardEvent) => void) | null = null;

// State

let currentBuffer: ArrayBuffer | null = null;

// Search state
let searchMatches: readonly AbsoluteOffset[] = [];
let searchIndex: number = -1;
let lastPatternLen: number | null = null;

// Public API

/**
 * Mounts the hex editor screen into `container` for the given `loadedFile`.
 *
 * Mounting order:
 * 1. Inject the HTML template and read the file buffer.
 * 2. Initialise `core/editor` with the buffer.
 * 3. Cache DOM element references.
 * 4. Set header metadata (filename, format badge).
 * 5. Wire up close / open buttons.
 * 6. Build structured and signature offset sets for hex-view colouring.
 * 7. Mount toolbar, hex-view, inspector, status-bar, and sidebar.
 * 8. Subscribe to selection and editor-change events.
 * 9. Attach hover listeners for cursor tracking.
 * 10. Synchronise the initial column layout.
 *
 * @param container  - The host element that receives the editor template.
 * @param loadedFile - The parsed file descriptor; must include a valid `structure.root`.
 * @throws If `loadedFile.structure.root` is missing.
 */
export async function mountEditor(container: HTMLElement, loadedFile: LoadedFile): Promise<void> {
  container.innerHTML = template;
  container.style.display = "block";

  if (!loadedFile.structure?.root) {
    throw new Error("Invalid file structure: missing root");
  }

  // 1. Obtain buffer and initialise editor
  currentBuffer = await getBufferFromLoadedFile(loadedFile);
  initEditor(currentBuffer);

  // 2. Cache DOM element references
  el.root = container.querySelector(".editor");
  el.fileName = container.querySelector("#file-tab-name");
  el.formatBadge = container.querySelector("#format-badge");
  el.btnClose = container.querySelector("#btn-close");
  el.btnOpen = container.querySelector("#btn-open");
  el.toolbar = container.querySelector("#toolbar");
  el.hexRows = container.querySelector("#hex-rows");
  el.sidebar = container.querySelector("#sidebar");
  el.inspector = container.querySelector("#inspector");
  el.statusBar = container.querySelector("#status-bar");

  // 3. Header metadata
  if (el.fileName) el.fileName.textContent = loadedFile.handle.name;
  if (el.formatBadge) el.formatBadge.textContent = loadedFile.structure.format;
  if (el.root) el.root.dataset["format"] = loadedFile.structure.format;

  // 4. Navigation buttons
  // Dispatch 'editor:close' instead of reloading directly.
  // main.ts listens for this event, clears sessionStorage, and THEN reloads.
  // Calling reload() here would persist sessionStorage and cause main.ts to
  // restore the editor on the next load, preventing a return to the welcome screen.
  el.btnClose?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("editor:close"));
  });
  el.btnOpen?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("editor:close"));
  });

  // 5. Build offset sets for hex-view semantic colouring
  const { structuredOffsets, signatureOffsets } = buildOffsetSets(loadedFile.structure.root);

  // 6. Mount toolbar
  if (el.toolbar) {
    toolbarHandle = mountToolbar(el.toolbar, {
      initialCols: 16,
      format: loadedFile.structure.format,
      filename: loadedFile.handle.name,
      onColsChange: (cols) => {
        hexViewHandle?.setCols(cols);
        updateColumnLayout(cols);
      },
      onSearch: (query) => handleSearch(query),
      onSearchNext: () => navigateSearch(1),
      onSearchPrev: () => navigateSearch(-1),
    });
  }

  // 7. Mount hex-view
  if (el.hexRows) {
    hexViewHandle = mountHexView(el.hexRows, {
      structuredOffsets,
      signatureOffsets,
      cols: 16,
      sections: loadedFile.structure.root.children as SectionNode[],
    });
  }

  // 8. Mount inspector
  if (el.inspector) {
    inspectorHandle = mountInspector(el.inspector, {
      buffer: getBuffer(),
    });
  }

  // 9. Mount status-bar
  if (el.statusBar) {
    statusBarHandle = mountStatusBar(el.statusBar, {
      fileSize: loadedFile.handle.size,
      format: loadedFile.structure.format,
      filename: loadedFile.handle.name,
    });
  }

  // 10. Mount sidebar
  if (el.sidebar) {
    sidebarHandle = mountSidebar(el.sidebar, {
      structure: loadedFile.structure,
      buffer: getBuffer(),
      onSectionClick: (node: SectionNode) => {
        inspectorHandle?.setSection(node);
        hexViewHandle?.scrollToOffset(node.range.start as number);
      },
      onSectionHover: (_node: SectionNode | null) => {
        // Reserved for future tooltips
      },
      showEntropy: true,
    });
  }

  // 11. Subscribe to selection changes
  unsubSelection = onSelectionChange((sel) => {
    const buf = getBuffer();
    inspectorHandle?.setSelection(sel);
    statusBarHandle?.setSelection(sel, buf);
  });

  // 12. Subscribe to editor changes (edits, undo/redo)
  unsubEditor = onEditorChange(() => {
    const newBuf = getBuffer();
    // hex-view updates itself (it has its own onEditorChange subscription)
    // Inspector needs the fresh buffer after each edit
    inspectorHandle?.setBuffer(newBuf);
    // Sidebar also needs the updated buffer to recalculate entropy,
    // but recalculating in real-time is expensive for large files, so we skip it here.
  });

  // 13. Cursor tracking: hover over hex-view
  if (el.hexRows) {
    onHexMouseMove = (e: MouseEvent) => {
      // Supports both .byte (hex) and .ascii-char (text) targets
      const target = (e.target as Element).closest<HTMLElement>("[data-offset]");
      if (!target) {
        statusBarHandle?.clearCursor();
        return;
      }
      const raw = parseInt(target.dataset["offset"] ?? "", 10);
      if (isNaN(raw)) return;

      const offset = Offset.create(raw);
      const buf = getBuffer();
      const byte = buf[offset];
      if (byte === undefined) return;

      statusBarHandle?.setCursor(offset, byte);

      // Show hover in the inspector only when there is no active selection
      const sel = getSelection();
      if (sel.type === "none") {
        inspectorHandle?.setCursor(offset);
      }
    };

    onHexMouseLeave = () => {
      statusBarHandle?.clearCursor();
    };

    el.hexRows.addEventListener("mousemove", onHexMouseMove);
    el.hexRows.addEventListener("mouseleave", onHexMouseLeave);
  }

  onGlobalKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      clearSelection();
    }
  };
  if (onGlobalKeydown) {
    document.addEventListener("keydown", onGlobalKeydown);
  }

  // Sync initial column layout (16 columns)
  updateColumnLayout(16);
}

/**
 * Unmounts the editor screen, destroys all components, and clears the container.
 *
 * @param container - The host element that was passed to {@link mountEditor}.
 */
export function unmountEditor(container: HTMLElement): void {
  // Remove hover listeners
  if (el.hexRows) {
    if (onHexMouseMove) el.hexRows.removeEventListener("mousemove", onHexMouseMove);
    if (onHexMouseLeave) el.hexRows.removeEventListener("mouseleave", onHexMouseLeave);
  }
  onHexMouseMove = null;
  onHexMouseLeave = null;

  if (onGlobalKeydown) {
    document.removeEventListener("keydown", onGlobalKeydown);
  }
  onGlobalKeydown = null;

  // Cancel subscriptions
  unsubSelection?.();
  unsubEditor?.();
  unsubSelection = null;
  unsubEditor = null;

  // Destroy components
  toolbarHandle?.destroy();
  hexViewHandle?.destroy();
  inspectorHandle?.destroy();
  statusBarHandle?.destroy();
  sidebarHandle?.destroy();

  toolbarHandle = null;
  hexViewHandle = null;
  inspectorHandle = null;
  statusBarHandle = null;
  sidebarHandle = null;

  // Tear down core singletons
  destroyEditor();
  resetSelection();
  currentBuffer = null;

  // Clear DOM references
  el.root = null;
  el.fileName = null;
  el.formatBadge = null;
  el.btnClose = null;
  el.btnOpen = null;
  el.toolbar = null;
  el.hexRows = null;
  el.sidebar = null;
  el.inspector = null;
  el.statusBar = null;

  // Clear the container
  container.innerHTML = "";
  container.style.display = "none";
}

// Search

/**
 * Runs the search query received from the toolbar and scrolls to the first
 * result. Uses `search.ts` (`findAll`) with a `BinaryBuffer` built from
 * `currentBuffer`.
 *
 * @param query - The search query submitted by the toolbar.
 */
function handleSearch(query: SearchQuery): void {
  if (!currentBuffer || currentBuffer.byteLength === 0) return;

  if (!query.text) {
    searchMatches = [];
    searchIndex = -1;
    toolbarHandle?.setSearchMatches(0, 0);
    return;
  }

  const binBuf = loadBuffer(currentBuffer);
  let pattern: Uint8Array | null = null;

  try {
    if (query.mode === "hex") {
      pattern = hexToBytes(query.text);
    } else if (query.mode === "ascii") {
      pattern = asciiToBytes(query.text);
    } else {
      pattern = new TextEncoder().encode(query.text);
    }
  } catch {
    return;
  }

  if (!pattern || pattern.length === 0) return;

  const results = findAll(binBuf, pattern, { maxResults: 1000 });
  searchMatches = results as readonly AbsoluteOffset[];
  searchIndex = results.length > 0 ? 0 : -1;

  updateSearchUI(pattern.length);
}

/**
 * Advances the active search result by `delta` positions (wraps around).
 *
 * @param delta - `+1` for next, `-1` for previous.
 */
function navigateSearch(delta: number): void {
  if (searchMatches.length === 0) return;
  searchIndex = (searchIndex + delta + searchMatches.length) % searchMatches.length;
  updateSearchUI();
}

/**
 * Syncs the toolbar match counter, selection, and hex-view scroll position
 * to the current search result.
 *
 * @param patternLen - Byte length of the search pattern. When omitted, the
 *   last known length (`lastPatternLen`) is used.
 */
function updateSearchUI(patternLen?: number): void {
  const total = searchMatches.length;
  if (total === 0) {
    toolbarHandle?.setSearchMatches(0, 0);
    return;
  }

  const offset = searchMatches[searchIndex];
  if (offset === undefined) return;

  toolbarHandle?.setSearchMatches(searchIndex + 1, total);

  const start = Offset.create(offset);
  const end = Offset.create(offset + (patternLen ?? lastPatternLen ?? 1) - 1);
  if (patternLen !== undefined) lastPatternLen = patternLen;

  startSelection(start);
  updateSelection(end);
  commitSelection();

  hexViewHandle?.scrollToOffset(offset);
}

// Helpers

/**
 * Reads the full `ArrayBuffer` from the `LoadedFile`'s handle and returns
 * an independent copy suitable for passing to `initEditor`.
 *
 * @param loadedFile - The loaded file descriptor.
 * @returns A detached `ArrayBuffer` copy of the file contents.
 */
async function getBufferFromLoadedFile(loadedFile: LoadedFile): Promise<ArrayBuffer> {
  const fullRange = {
    start: Offset.create(0),
    end: Offset.create((loadedFile.handle.size as number) - 1),
    length: loadedFile.handle.size,
  };
  const uint8 = await loadedFile.handle.read(fullRange);

  const copy = new ArrayBuffer(uint8.byteLength);
  new Uint8Array(copy).set(uint8);
  return copy;
}

/**
 * Traverses the section tree and builds two offset sets used for semantic
 * colouring in hex-view:
 * - `structuredOffsets` – every byte covered by a parsed section.
 * - `signatureOffsets`  – bytes belonging to magic numbers, signatures, or headers.
 *
 * Uses an iterative DFS to avoid stack overflow on deep trees.
 *
 * @param root - The root section node of the parsed structure.
 * @returns An object containing both offset sets.
 */
function buildOffsetSets(root: SectionNode): {
  structuredOffsets: Set<number>;
  signatureOffsets: Set<number>;
} {
  const structuredOffsets = new Set<number>();
  const signatureOffsets = new Set<number>();

  const stack: SectionNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node?.range) continue;

    const start = node.range.start as number;
    const end = node.range.end as number;

    const isSignature = node.type === "metadata" || node.name.toLowerCase().includes("magic") || node.name.toLowerCase().includes("signature") || node.name.toLowerCase().includes("header");

    for (let i = start; i <= end; i++) {
      structuredOffsets.add(i);
      if (isSignature) signatureOffsets.add(i);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  return { structuredOffsets, signatureOffsets };
}

/**
 * Updates the hex-header label and the `--ascii-w` CSS custom property to
 * match the selected column count.
 *
 * ASCII column widths: 8 cols → 80 px, 16 cols → 120 px, 32 cols → 240 px.
 *
 * @param cols - The new column count (8, 16, or 32).
 */
function updateColumnLayout(cols: number): void {
  const label = document.getElementById("hex-header-label");
  if (label) label.textContent = `Hex (${cols} bytes/row)`;

  const editorRoot = document.querySelector<HTMLElement>(".editor");
  if (editorRoot) {
    const asciiW = cols === 32 ? "240px" : cols === 8 ? "80px" : "120px";
    editorRoot.style.setProperty("--ascii-w", asciiW);
  }
}
