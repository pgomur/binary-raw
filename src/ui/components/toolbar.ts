/**
 * @file src/ui/components/toolbar.ts
 * Toolbar: undo/redo, export, column width, search.
 * Factory pattern: mountToolbar(container, options) → handle.
 */

import type { FileFormat } from "@app-types/index";
import { exportBuffer, canUndo, canRedo, undo, redo, modifiedCount, onEditorChange } from "@core/editor";

// Public types

/** Supported hex-view column widths. */
export type ColWidth = 8 | 16 | 32;

/** Configuration options passed to {@link mountToolbar}. */
export interface ToolbarOptions {
  /** Initial column width for the hex view. */
  readonly initialCols?: ColWidth;
  /** Format of the loaded file (used to render the format badge). */
  readonly format?: FileFormat;
  /** File name (used in the title and as the default export filename). */
  readonly filename?: string;
  /** Called when the user selects a different column width. */
  readonly onColsChange?: (cols: ColWidth) => void;
  /** Called when the user submits a search query. */
  readonly onSearch?: (query: SearchQuery) => void;
  /** Called when the user navigates to the next search result. */
  readonly onSearchNext?: () => void;
  /** Called when the user navigates to the previous search result. */
  readonly onSearchPrev?: () => void;
  /** Called when the user triggers undo from the toolbar or keyboard shortcut. */
  readonly onUndo?: () => void;
  /** Called when the user triggers redo from the toolbar or keyboard shortcut. */
  readonly onRedo?: () => void;
}

/** Supported search modes. */
export type SearchMode = "hex" | "ascii" | "utf8";

/** Describes a search query submitted by the user. */
export interface SearchQuery {
  readonly text: string;
  readonly mode: SearchMode;
  readonly caseSensitive: boolean;
}

/** Handle returned by {@link mountToolbar} for external control of the toolbar. */
export interface ToolbarHandle {
  /** Syncs the undo/redo button state with the current editor state. */
  refresh(): void;
  /** Updates the search match counter (e.g. "1 / 42"). */
  setSearchMatches(current: number, total: number): void;
  /** Tears down the component and removes all event listeners. */
  destroy(): void;
}

// CSS classes

const CLS = {
  root: "toolbar",
  group: "toolbar__group",
  btn: "toolbar__btn",
  btnActive: "toolbar__btn--active",
  btnDisabled: "toolbar__btn--disabled",
  badge: "toolbar__badge",
  filename: "toolbar__filename",
  modBadge: "toolbar__mod-badge",
  separator: "toolbar__separator",
  searchWrap: "toolbar__search-wrap",
  searchInput: "toolbar__search-input",
  searchMode: "toolbar__search-mode",
  colToggle: "toolbar__col-toggle",
  searchMatches: "toolbar__search-matches",
  searchNav: "toolbar__search-nav",
  searchClear: "toolbar__search-clear",
} as const;

// Factory

/**
 * Mounts the toolbar into `container` and returns a {@link ToolbarHandle}
 * for external synchronisation and cleanup.
 *
 * Responsibilities:
 * - **Undo / Redo** – buttons and global `Ctrl+Z` / `Ctrl+Y` shortcuts.
 * - **Export** – triggers a browser file download of the current buffer.
 * - **Column width** – lets the user choose between 8, 16, or 32 bytes per row.
 * - **Search** – debounced incremental search with hex / ASCII / UTF-8 modes
 *   and previous/next navigation.
 *
 * @param container - The host `HTMLElement` into which the toolbar is rendered.
 * @param options   - Optional configuration; see {@link ToolbarOptions}.
 * @returns A {@link ToolbarHandle} for refreshing state and destroying the component.
 */
export function mountToolbar(container: HTMLElement, options: ToolbarOptions = {}): ToolbarHandle {
  const { initialCols = 16, format, filename, onColsChange, onSearch, onSearchNext, onSearchPrev, onUndo: onUndoCb, onRedo: onRedoCb } = options;

  let currentCols: ColWidth = initialCols;
  let searchTimeout: number | null = null;
  let destroyed = false;

  // Render
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = CLS.root;
  container.appendChild(root);

  // Center group: undo/redo + export
  const groupCenter = makeGroup();
  root.appendChild(groupCenter);

  const modBadge = document.createElement("span");
  modBadge.className = CLS.modBadge;
  modBadge.hidden = true;
  groupCenter.appendChild(modBadge);

  const btnUndo = makeButton("↩ Undo", "Undo (Ctrl+Z)", true);
  const btnRedo = makeButton("↪ Redo", "Redo (Ctrl+Y)", true);
  const btnExport = makeButton("⬇ Export", "Export modified file");

  groupCenter.appendChild(btnUndo);
  groupCenter.appendChild(btnRedo);
  groupCenter.appendChild(makeSeparator());
  groupCenter.appendChild(btnExport);

  root.appendChild(makeSeparator());

  // Column width group
  const groupCols = makeGroup();
  root.appendChild(groupCols);

  const colLabel = document.createElement("span");
  colLabel.className = CLS.colToggle;
  colLabel.textContent = "Cols:";
  groupCols.appendChild(colLabel);

  const COL_OPTIONS: ColWidth[] = [8, 16, 32];
  const colButtons = new Map<ColWidth, HTMLButtonElement>();

  for (const cols of COL_OPTIONS) {
    const btn = makeButton(String(cols), `${cols} bytes per row`);
    if (cols === currentCols) btn.classList.add(CLS.btnActive);
    colButtons.set(cols, btn);
    groupCols.appendChild(btn);

    btn.addEventListener("click", () => {
      if (destroyed) return;
      currentCols = cols;
      for (const [c, b] of colButtons) {
        b.classList.toggle(CLS.btnActive, c === cols);
      }
      onColsChange?.(cols);
    });
  }

  root.appendChild(makeSeparator());

  // Search group
  const groupSearch = makeGroup();
  root.appendChild(groupSearch);

  const searchWrap = document.createElement("div");
  searchWrap.className = CLS.searchWrap;
  groupSearch.appendChild(searchWrap);

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = CLS.searchInput;
  searchInput.placeholder = "Search…";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchWrap.appendChild(searchInput);

  const clearBtn = document.createElement("button");
  clearBtn.className = CLS.searchClear;
  clearBtn.innerHTML = "✕";
  clearBtn.title = "Clear search";
  clearBtn.style.display = "none";
  searchWrap.appendChild(clearBtn);

  const searchModeSelect = document.createElement("select");
  searchModeSelect.className = CLS.searchMode;
  searchModeSelect.title = "Search mode";

  const MODES: Array<[SearchMode, string]> = [
    ["hex", "Hex"],
    ["ascii", "ASCII"],
    ["utf8", "UTF-8"],
  ];
  const modeWrap = document.createElement("div");
  modeWrap.className = "toolbar__search-mode-wrap";

  for (const [value, label] of MODES) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    searchModeSelect.appendChild(opt);
  }
  modeWrap.appendChild(searchModeSelect);
  searchWrap.appendChild(modeWrap);

  // Match counter (e.g. "1 / 15")
  const matchesEl = document.createElement("span");
  matchesEl.className = CLS.searchMatches;
  matchesEl.textContent = "";
  matchesEl.style.display = "none"; // hidden by default
  groupSearch.appendChild(matchesEl);

  // Search result navigation buttons
  const navGroup = document.createElement("div");
  navGroup.className = CLS.searchNav;
  navGroup.style.display = "none"; // hidden by default

  const btnPrev = makeButton("↑", "Previous result", true);
  const btnNext = makeButton("↓", "Next result", true);

  navGroup.appendChild(btnPrev);
  navGroup.appendChild(btnNext);
  groupSearch.appendChild(navGroup);

  // Event handlers

  // Undo
  btnUndo.addEventListener("click", () => {
    if (destroyed || !canUndo()) return;
    undo();
    onUndoCb?.();
    syncUndoRedo();
  });

  // Redo
  btnRedo.addEventListener("click", () => {
    if (destroyed || !canRedo()) return;
    redo();
    onRedoCb?.();
    syncUndoRedo();
  });

  // Export
  btnExport.addEventListener("click", () => {
    if (destroyed) return;

    const blob = exportBuffer();
    const name = filename ?? "export.bin";

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Search — triggered on Enter key or after debounce
  function dispatchSearch(): void {
    if (destroyed || !onSearch) return;
    const text = searchInput.value.trim();
    if (!text) return;
    const rawMode = searchModeSelect.value;
    const VALID_MODES: readonly SearchMode[] = ["hex", "ascii", "utf8"];
    const mode: SearchMode = (VALID_MODES as readonly string[]).includes(rawMode) ? (rawMode as SearchMode) : "hex";
    onSearch({ text, mode, caseSensitive: false });
  }

  searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") dispatchSearch();
  });

  searchInput.addEventListener("input", () => {
    if (destroyed) return;
    clearBtn.style.display = searchInput.value ? "block" : "none";

    // Incremental search with debounce
    if (searchTimeout) window.clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => {
      dispatchSearch();
    }, 300);
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.style.display = "none";
    searchInput.focus();
    const mode = searchModeSelect.value as SearchMode;
    onSearch?.({ text: "", mode, caseSensitive: false });
  });

  btnPrev.addEventListener("click", () => {
    if (!destroyed) onSearchPrev?.();
  });

  btnNext.addEventListener("click", () => {
    if (!destroyed) onSearchNext?.();
  });

  // Global keyboard shortcuts (undo/redo)
  function onKeydown(e: KeyboardEvent): void {
    if (destroyed) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      if (canUndo()) {
        undo();
        onUndoCb?.();
        syncUndoRedo();
      }
    }
    if (((e.ctrlKey || e.metaKey) && e.key === "y") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "z")) {
      e.preventDefault();
      if (canRedo()) {
        redo();
        onRedoCb?.();
        syncUndoRedo();
      }
    }
  }
  document.addEventListener("keydown", onKeydown);

  // Editor synchronisation

  function syncUndoRedo(): void {
    setDisabled(btnUndo, !canUndo());
    setDisabled(btnRedo, !canRedo());
  }

  function syncModBadge(count: number): void {
    if (count === 0) {
      modBadge.hidden = true;
    } else {
      modBadge.hidden = false;
      modBadge.textContent = `${count} modified`;
    }
  }

  // Subscribe to editor changes
  const unsubEditor = onEditorChange((count: number) => {
    if (destroyed) return;
    syncUndoRedo();
    syncModBadge(count);
  });

  // Initial state
  syncUndoRedo();
  syncModBadge(modifiedCount());

  // Handle

  return {
    refresh(): void {
      if (destroyed) return;
      syncUndoRedo();
      syncModBadge(modifiedCount());
    },

    setSearchMatches(current, total): void {
      if (destroyed) return;
      if (total === 0) {
        matchesEl.textContent = "";
        matchesEl.style.display = "none";
        navGroup.style.display = "none";
        setDisabled(btnPrev, true);
        setDisabled(btnNext, true);
      } else {
        matchesEl.textContent = `${current} / ${total}`;
        matchesEl.style.display = "inline-block";
        navGroup.style.display = "flex";
        setDisabled(btnPrev, false);
        setDisabled(btnNext, false);
      }
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unsubEditor();
      document.removeEventListener("keydown", onKeydown);
      container.innerHTML = "";
    },
  };
}

// Internal helpers

/**
 * Creates a toolbar group `<div>` with the appropriate CSS class.
 */
function makeGroup(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = CLS.group;
  return el;
}

/**
 * Creates a visual separator `<div>` (aria-hidden).
 */
function makeSeparator(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = CLS.separator;
  el.setAttribute("aria-hidden", "true");
  return el;
}

/**
 * Creates a styled toolbar `<button>`.
 *
 * @param label          - Visible button label.
 * @param title          - Tooltip text.
 * @param startsDisabled - Whether the button is initially disabled (default: `false`).
 */
function makeButton(label: string, title: string, startsDisabled = false): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = CLS.btn;
  btn.textContent = label;
  btn.title = title;
  if (startsDisabled) setDisabled(btn, true);
  return btn;
}

/**
 * Toggles the disabled state and the disabled CSS modifier on a button.
 *
 * @param btn      - The button element to update.
 * @param disabled - `true` to disable, `false` to enable.
 */
function setDisabled(btn: HTMLButtonElement, disabled: boolean): void {
  btn.disabled = disabled;
  btn.classList.toggle(CLS.btnDisabled, disabled);
}
