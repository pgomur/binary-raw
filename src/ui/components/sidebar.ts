/**
 * @file src/ui/components/sidebar.ts
 * Section tree with entropy heatmap.
 * Factory pattern: mountSidebar(container, options) → handle.
 */

import type { ParsedStructure, SectionNode, SelectionState, ByteRange, AbsoluteOffset } from "@app-types/index";
import { Range, Selection } from "@app-types/index";
import { shannonEntropy, entropyToColor, normalizeEntropy, isProbablyEncrypted, isProbablyText, isProbablyPadding, type EntropyResult } from "@utils/entropy";
import { getSelection, setSelection, onSelectionChange } from "@core/selection";

// Public types

/** Configuration options passed to {@link mountSidebar}. */
export interface SidebarOptions {
  /** Parsed structure of the current file. */
  readonly structure: ParsedStructure;
  /** Raw file bytes (used for entropy calculations). */
  readonly buffer: Uint8Array;
  /** Called when the user clicks a section row. */
  readonly onSectionClick?: (node: SectionNode) => void;
  /** Called when the user hovers over a section row (or leaves it, passing `null`). */
  readonly onSectionHover?: (node: SectionNode | null) => void;
  /** When `true`, renders the entropy heatmap bar on each row. */
  readonly showEntropy?: boolean;
}

/** Handle returned by {@link mountSidebar} for external control and cleanup. */
export interface SidebarHandle {
  /** Rebuilds the tree with a new structure (new file loaded). */
  setStructure(structure: ParsedStructure, buffer: Uint8Array): void;
  /** Forces re-sync of the active selection highlight. */
  refresh(): void;
  /** Tears down the component and removes all event listeners. */
  destroy(): void;
}

// CSS classes

const CLS = {
  root: "sidebar",
  header: "sidebar__header",
  title: "sidebar__title",
  toggleEntropy: "sidebar__toggle-entropy",
  tree: "sidebar__tree",
  node: "sidebar__node",
  nodeHeader: "sidebar__node-header",
  nodeSelected: "sidebar__node--selected",
  nodeHovered: "sidebar__node--hovered",
  nodeExec: "sidebar__node--exec",
  nodeWrite: "sidebar__node--write",
  expand: "sidebar__expand",
  expandOpen: "sidebar__expand--open",
  icon: "sidebar__icon",
  label: "sidebar__label",
  labelName: "sidebar__label-name",
  labelRange: "sidebar__label-range",
  labelSize: "sidebar__label-size",
  entropyBar: "sidebar__entropy-bar",
  entropyFill: "sidebar__entropy-fill",
  entropyBadge: "sidebar__entropy-badge",
  children: "sidebar__children",
  childrenOpen: "sidebar__children--open",
  emptyState: "sidebar__empty",
} as const;

// Section type icons

const SECTION_ICONS: Record<string, string> = {
  container: "📦",
  data: "⬛",
  metadata: "🏷",
  padding: "⬜",
};

// Factory

/**
 * Mounts the sidebar into `container` and returns a {@link SidebarHandle}
 * for external updates and cleanup.
 *
 * Features:
 * - **Section tree** – recursive, collapsible tree mirroring the parsed structure.
 *   The first level is expanded by default; deeper levels start collapsed.
 * - **Entropy heatmap** – optional per-row bar showing Shannon entropy; toggled
 *   via the header button.
 * - **Selection sync** – highlights the deepest section that contains the start
 *   of the active selection and scrolls it into view.
 *
 * @param container - The host `HTMLElement` into which the sidebar is rendered.
 * @param options   - Required configuration; see {@link SidebarOptions}.
 * @returns A {@link SidebarHandle} for updating state and destroying the component.
 */
export function mountSidebar(container: HTMLElement, options: SidebarOptions): SidebarHandle {
  let { structure, buffer, onSectionClick, onSectionHover, showEntropy = true } = options;

  let destroyed = false;
  let entropyVisible = showEntropy;
  let hoveredId: string | null = null;

  // Map of section id → row header DOM element
  const nodeElements = new Map<string, HTMLElement>();

  // Render
  container.innerHTML = "";
  container.classList.add(CLS.root);

  // Header
  const header = document.createElement("div");
  header.className = CLS.header;
  container.appendChild(header);

  const title = document.createElement("span");
  title.className = CLS.title;
  title.textContent = "Structure";
  header.appendChild(title);

  const toggleEntropy = document.createElement("button");
  toggleEntropy.type = "button";
  toggleEntropy.className = CLS.toggleEntropy;
  toggleEntropy.title = "Toggle entropy heatmap";
  syncToggleLabel();
  header.appendChild(toggleEntropy);

  toggleEntropy.addEventListener("click", () => {
    if (destroyed) return;
    entropyVisible = !entropyVisible;
    syncToggleLabel();
    renderTree();
  });

  // Tree container
  const treeEl = document.createElement("div");
  treeEl.className = CLS.tree;
  treeEl.setAttribute("role", "tree");
  container.appendChild(treeEl);

  // Tree rendering

  function renderTree(): void {
    treeEl.innerHTML = "";
    nodeElements.clear();

    if (structure.root.children.length === 0 && structure.root.type !== "container") {
      const empty = document.createElement("div");
      empty.className = CLS.emptyState;
      empty.textContent = "No sections found";
      treeEl.appendChild(empty);
      return;
    }

    const rootEl = buildNodeEl(structure.root, 0, true);
    treeEl.appendChild(rootEl);
    syncSelectionHighlight(getSelection());
  }

  /**
   * Recursively builds the DOM element for a {@link SectionNode}.
   *
   * @param node           - The section node to render.
   * @param depth          - Current nesting depth (used for indentation via CSS variable).
   * @param startExpanded  - Whether this node starts in the expanded state.
   * @returns The wrapper `<div>` for the node and all its descendants.
   */
  function buildNodeEl(node: SectionNode, depth: number, startExpanded: boolean): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = CLS.node;
    wrapper.setAttribute("role", "treeitem");
    wrapper.dataset["sectionId"] = node.id;
    wrapper.style.setProperty("--depth", String(depth));

    // Row header
    const rowHeader = document.createElement("div");
    rowHeader.className = CLS.nodeHeader;
    if (node.flags.executable) rowHeader.classList.add(CLS.nodeExec);
    if (node.flags.writable) rowHeader.classList.add(CLS.nodeWrite);
    wrapper.appendChild(rowHeader);

    nodeElements.set(node.id, rowHeader);

    // Expand / collapse button (only rendered when the node has children)
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = CLS.expand;
    expandBtn.textContent = node.children.length > 0 ? (startExpanded ? "▾" : "▸") : "";
    expandBtn.setAttribute("aria-label", node.children.length > 0 ? (startExpanded ? "Collapse" : "Expand") : "");
    rowHeader.appendChild(expandBtn);

    // Type icon
    const iconEl = document.createElement("span");
    iconEl.className = CLS.icon;
    iconEl.dataset["type"] = node.type; // used by CSS to colour the rectangle
    iconEl.setAttribute("aria-hidden", "true");
    rowHeader.appendChild(iconEl);

    // Label: name + byte range + size
    const labelEl = document.createElement("div");
    labelEl.className = CLS.label;
    rowHeader.appendChild(labelEl);

    const nameEl = document.createElement("span");
    nameEl.className = CLS.labelName;
    nameEl.textContent = node.name;
    nameEl.title = node.name;
    labelEl.appendChild(nameEl);

    const rangeEl = document.createElement("span");
    rangeEl.className = CLS.labelRange;
    rangeEl.textContent = formatRange(node.range);
    rangeEl.title = `0x${node.range.start.toString(16).toUpperCase()} – 0x${node.range.end.toString(16).toUpperCase()}`;
    labelEl.appendChild(rangeEl);

    const sizeEl = document.createElement("span");
    sizeEl.className = CLS.labelSize;
    sizeEl.textContent = formatSize(node.range.length);
    labelEl.appendChild(sizeEl);

    // Entropy bar
    if (entropyVisible) {
      const entropyResult = shannonEntropy(buffer, node.range, true);
      rowHeader.appendChild(buildEntropyBar(entropyResult));
    }

    // Children container
    const childrenEl = document.createElement("div");
    childrenEl.className = CLS.children;
    if (startExpanded) childrenEl.classList.add(CLS.childrenOpen);
    wrapper.appendChild(childrenEl);

    let isOpen = startExpanded;

    for (const child of node.children) {
      // Only the first level is expanded by default
      childrenEl.appendChild(buildNodeEl(child, depth + 1, depth < 1));
    }

    // Expand / collapse logic
    if (node.children.length > 0) {
      expandBtn.addEventListener("click", (e: MouseEvent) => {
        if (destroyed) return;
        e.stopPropagation();
        isOpen = !isOpen;
        expandBtn.textContent = isOpen ? "▾" : "▸";
        expandBtn.setAttribute("aria-label", isOpen ? "Collapse" : "Expand");
        expandBtn.classList.toggle(CLS.expandOpen, isOpen);
        childrenEl.classList.toggle(CLS.childrenOpen, isOpen);
      });
    }

    // Row click → select the section's byte range
    rowHeader.addEventListener("click", () => {
      if (destroyed) return;
      setSelection(Selection.select(node.range));
      onSectionClick?.(node);
    });

    // Hover
    rowHeader.addEventListener("mouseenter", () => {
      if (destroyed) return;
      hoveredId = node.id;
      rowHeader.classList.add(CLS.nodeHovered);
      onSectionHover?.(node);
    });

    rowHeader.addEventListener("mouseleave", () => {
      if (destroyed) return;
      if (hoveredId === node.id) hoveredId = null;
      rowHeader.classList.remove(CLS.nodeHovered);
      onSectionHover?.(null);
    });

    return wrapper;
  }

  // Entropy bar

  /**
   * Builds the entropy heatmap bar element for a given {@link EntropyResult}.
   *
   * @param result - Pre-computed entropy result for the section.
   * @returns A `<div>` containing the fill bar and the numeric badge.
   */
  function buildEntropyBar(result: EntropyResult): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = CLS.entropyBar;

    const hint = isProbablyEncrypted(result) ? " ⚠ Possibly encrypted" : isProbablyPadding(result) ? " · Padding zone" : isProbablyText(result) ? " · Plain text" : "";
    wrap.title = `Entropy: ${result.entropy.toFixed(2)} bits/byte (${result.classification})${hint}`;

    const fill = document.createElement("div");
    fill.className = CLS.entropyFill;
    fill.style.width = `${normalizeEntropy(result.entropy) * 100}%`;
    fill.style.backgroundColor = entropyToColor(result.entropy);
    wrap.appendChild(fill);

    const badge = document.createElement("span");
    badge.className = CLS.entropyBadge;
    badge.textContent = result.entropy.toFixed(1);
    badge.dataset["class"] = result.classification;
    wrap.appendChild(badge);

    return wrap;
  }

  // Selection synchronisation

  /**
   * Highlights the deepest section node that contains the start of `sel`,
   * clearing all other highlights first.
   *
   * @param sel - The current selection state.
   */
  function syncSelectionHighlight(sel: SelectionState): void {
    for (const [, el] of nodeElements) {
      el.classList.remove(CLS.nodeSelected);
    }

    if (sel.type === "none") return;

    const selRange: ByteRange | null = sel.type === "selected" ? sel.range : sel.type === "selecting" ? Range.create(Math.min(sel.anchor, sel.current) as AbsoluteOffset, Math.max(sel.anchor, sel.current) as AbsoluteOffset) : null;

    if (!selRange) return;

    // Highlight only the deepest (most specific) section containing the selection start.
    // Highlighting every overlapping section would be too aggressive.
    const targetNode = findInnermostSection(structure.root, selRange.start);
    if (!targetNode) return;

    const el = nodeElements.get(targetNode.id);
    if (el) {
      el.classList.add(CLS.nodeSelected);
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  /**
   * Returns the deepest {@link SectionNode} in the tree whose byte range
   * contains `offset`, or `null` if none matches.
   *
   * @param root   - The root node to search from.
   * @param offset - The byte offset to locate.
   */
  function findInnermostSection(root: SectionNode, offset: number): SectionNode | null {
    if (offset < root.range.start || offset > root.range.end) return null;

    for (const child of root.children) {
      const found = findInnermostSection(child, offset);
      if (found) return found;
    }

    return root;
  }

  // Helpers

  function formatRange(range: ByteRange): string {
    const start = range.start.toString(16).toUpperCase().padStart(8, "0");
    const end = range.end.toString(16).toUpperCase().padStart(8, "0");
    return `${start}–${end}`;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function syncToggleLabel(): void {
    toggleEntropy.textContent = entropyVisible ? "🌡 Hide entropy" : "🌡 Show entropy";
  }

  // Subscribe to selection changes
  const unsubSelection = onSelectionChange((sel: SelectionState) => {
    if (destroyed) return;
    syncSelectionHighlight(sel);
  });

  // Initial render
  renderTree();

  // Handle
  return {
    setStructure(newStructure: ParsedStructure, newBuffer: Uint8Array): void {
      if (destroyed) return;
      structure = newStructure;
      buffer = newBuffer;
      renderTree();
    },

    refresh(): void {
      if (destroyed) return;
      syncSelectionHighlight(getSelection());
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unsubSelection();
      container.innerHTML = "";
      nodeElements.clear();
    },
  };
}

// Tree helpers (outside the closure)

/**
 * Finds a node by its `id` in the section tree using an iterative DFS.
 * Iterative rather than recursive to avoid stack overflow on deep trees.
 *
 * @param root - The root node to search from.
 * @param id   - The section id to locate.
 * @returns The matching {@link SectionNode}, or `null` if not found.
 */
function findNodeById(root: SectionNode, id: string): SectionNode | null {
  const stack: SectionNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.id === id) return node;
    for (const child of node.children) {
      stack.push(child);
    }
  }

  return null;
}
